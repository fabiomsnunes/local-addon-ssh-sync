import * as crypto from 'crypto';

import { shellQuote } from './ssh';

// Every push keeps what it needs to be undone, on this machine:
//   <site>-<env>-<stamp>.sql         the server database before the push (DB pushes)
//   <site>-<env>-<stamp>-files/      the server files the push replaced or deleted
//   <site>-<env>-<stamp>.json        this manifest: what the push added
// On the server the replaced files are collected by rsync --backup-dir (and
// deletions are moved there instead of removed), downloaded, then removed.

export interface PushManifest {
  environmentId: string;
  stamp: string;
  // Files and folders the push created on the server (undo removes them).
  // Null when the local rsync cannot report them (openrsync).
  added: string[] | null;
  addedDirs: string[] | null;
  // Every file the push wrote, with the size and mtime it left on the
  // server, and every file it deleted: undo refuses when any changed since
  pushed?: Record<string, [number, number]>;
  deleted?: string[];
  hasFilesBackup: boolean;
  hasDatabaseBackup: boolean;
  // The server's last-push marker before this push (undo writes it back)
  previousMarker?: string | null;
  // The server's table prefix before a database push changed it (undo sets
  // it back; wp-config.php itself is never synced or backed up)
  remotePrefixBefore?: string;
}

export const REMOTE_FILES_BACKUP_PREFIX = '.ssh-sync-files-';
export const OUT_FORMAT_MARKER = 'SSHSYNC';

export function pushStamp(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

export function remoteFilesBackupDir(remoteHome: string, stamp: string): string {
  return `${remoteHome}/${REMOTE_FILES_BACKUP_PREFIX}${stamp}`;
}

// rsync `--out-format=SSHSYNC|%i|%n` lines: `<f+++++++++` is a new file,
// `cd+++++++++` a new folder (both relative to the WordPress root).
export interface PushedChanges {
  // New files and folders on the server (undo removes them)
  files: string[];
  dirs: string[];
  // Existing files the push overwrote (undo restores them from the backup)
  updated: string[];
  // Files rsync --delete removed (fast path; ticked deletions are listed by us)
  deleted: string[];
}

export function parseAddedFromOutFormat(stdout: string): PushedChanges {
  const changes: PushedChanges = { files: [], dirs: [], updated: [], deleted: [] };
  // Progress output ends its lines with \r, so a marker can follow progress
  // text on the same "line": find every marker wherever it starts. Names are
  // kept exactly (no trimming); only a folder's trailing slash goes.
  const marker = new RegExp(`${OUT_FORMAT_MARKER}\\|([^|\\r\\n]+)\\|([^\\r\\n]+)`, 'g');
  for (const match of stdout.matchAll(marker)) {
    const flags = match[1];
    const name = match[2].replace(/\/$/, '');
    if (!name || name === '.') continue;
    if (flags.startsWith('*deleting')) {
      changes.deleted.push(name);
      continue;
    }
    if (flags[0] !== '<' && flags[0] !== 'c') continue; // attribute-only changes
    const isNew = flags.length > 2 && /^\++$/.test(flags.slice(2));
    if (flags[1] === 'd') {
      if (isNew) changes.dirs.push(name);
    } else if (flags[1] === 'f') {
      (isNew ? changes.files : changes.updated).push(name);
    }
  }
  return changes;
}

// A relative path inside the WordPress root, safe to hand to a remote loop
// that reads one path per line (no quoting involved at all).
export function isSafeListedPath(p: string): boolean {
  if (!p || p.length > 4096 || /[\n\r\0]/.test(p)) return false;
  if (p.startsWith('/') || p.startsWith('~')) return false;
  return !p.split('/').some((segment) => segment === '..' || segment === '' || segment === '.');
}

// Deleting a folder already removes what is inside it: keep only the
// outermost path, so nothing is moved twice (or nested in the backup).
export function outermostPaths(paths: string[]): string[] {
  const set = new Set(paths);
  return [...set].filter((p) => {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (set.has(parts.slice(0, i).join('/'))) return false;
    }
    return true;
  });
}

// Remote loops over a path list given on stdin, one per line
export function moveListedToBackupCommand(backupDir: string): string {
  return `b=${shellQuote(backupDir)}; while IFS= read -r p; do [ -e "$p" ] || [ -L "$p" ] || continue; mkdir -p "$b/$(dirname -- "$p")" && mv -- "$p" "$b/$p" || exit 1; done`;
}

export function removeListedFilesCommand(): string {
  return 'while IFS= read -r p; do rm -f -- "$p"; done';
}

// Folders the push created, deepest first, removed only when empty
export function removeListedEmptyDirsCommand(): string {
  return 'while IFS= read -r d; do rmdir -- "$d" 2>/dev/null; done; true';
}

// Undo safety: a pushed file that no longer has the size and mtime the push
// gave it, or a deleted file that exists again, changed on the server since.
// stdin lines, tab-separated so names keep every space: "<size>\t<mtime>\t<path>"
// for pushed files, "-\t-\t<path>" for deleted ones. GNU stat, then BSD stat.
export function changedSinceCommand(): string {
  return [
    `tab=$(printf '\\t');`,
    'while IFS= read -r line; do',
    'size=${line%%"$tab"*}; rest=${line#*"$tab"}; mtime=${rest%%"$tab"*}; p=${rest#*"$tab"};',
    'if [ "$size" = - ]; then { [ -e "$p" ] || [ -L "$p" ]; } && printf "SSHSYNC_CHANGED|%s\\n" "$p";',
    'else now=$(stat -c "%s %Y" -- "$p" 2>/dev/null || stat -f "%z %m" -- "$p" 2>/dev/null);',
    '[ "$now" = "$size $mtime" ] || printf "SSHSYNC_CHANGED|%s\\n" "$p"; fi;',
    'done; true',
  ].join(' ');
}

export function changedSinceLines(
  pushed: Record<string, [number, number]>,
  deleted: string[],
): string[] {
  return [
    ...Object.entries(pushed).map(([file, [size, mtime]]) => `${size}\t${mtime}\t${file}`),
    ...deleted.map((file) => `-\t-\t${file}`),
  ];
}

export function parseChangedSince(stdout: string): string[] {
  return [...stdout.matchAll(/SSHSYNC_CHANGED\|([^\r\n]+)/g)].map((m) => m[1]);
}

// ---------------------------------------------------------------------------
// One push at a time per server folder, across machines and people: a lock
// folder in the SSH user's home, created atomically with mkdir.
// ---------------------------------------------------------------------------

export const LOCK_STALE_MINUTES = 360;

export function lockDir(remoteHome: string, remoteRoot: string): string {
  const hash = crypto.createHash('sha1').update(remoteRoot).digest('hex').slice(0, 12);
  return `${remoteHome}/.ssh-sync-lock-${hash}`;
}

// Each holder writes a random token: only the holder releases or refreshes
// the lock. A dead lock (untouched for LOCK_STALE_MINUTES) is taken over with
// an atomic mv, so two takers can never both win.
export function acquireLockCommand(lock: string, owner: string, token: string): string {
  const q = shellQuote(lock);
  return [
    `l=${q}`,
    `if mkdir "$l" 2>/dev/null; then :`,
    // Take over a dead lock: rename it away (only one taker's mv succeeds).
    // What was renamed is still dead: delete it and take the lock, unless
    // someone else's mkdir got there first. It turned out fresh (a new holder
    // got in before the rename): put it back, and if yet another lock took
    // its place meanwhile, remove the copy mv nested inside that one.
    `elif [ -n "$(find "$l" -maxdepth 0 -mmin +${LOCK_STALE_MINUTES} 2>/dev/null)" ] && mv "$l" "$l.stale.$$" 2>/dev/null; then if [ -n "$(find "$l.stale.$$" -maxdepth 0 -mmin +${LOCK_STALE_MINUTES} 2>/dev/null)" ]; then rm -rf -- "$l.stale.$$"; mkdir "$l" 2>/dev/null || { printf 'SSHSYNC_LOCK=busy %s\\n' "$(cat "$l/owner" 2>/dev/null)"; exit 0; }; else mv "$l.stale.$$" "$l" 2>/dev/null; rm -rf -- "$l/\${l##*/}.stale.$$"; printf 'SSHSYNC_LOCK=busy %s\\n' "$(cat "$l/owner" 2>/dev/null)"; exit 0; fi`,
    `else printf 'SSHSYNC_LOCK=busy %s\\n' "$(cat "$l/owner" 2>/dev/null)"; exit 0; fi`,
    `printf '%s\\n' ${shellQuote(owner)} > "$l/owner"`,
    `printf '%s\\n' ${shellQuote(token)} > "$l/token"`,
    'echo SSHSYNC_LOCK=ok',
  ].join('; ');
}

export function parseLockOutput(stdout: string): { ok: true } | { ok: false; owner: string } {
  const match = stdout.match(/SSHSYNC_LOCK=(ok|busy)(.*)/);
  if (match && match[1] === 'ok') return { ok: true };
  return { ok: false, owner: match ? match[2].trim() : '' };
}

function holdsLock(lock: string, token: string): string {
  return `[ "$(cat ${shellQuote(lock)}/token 2>/dev/null)" = ${shellQuote(token)} ]`;
}

export function releaseLockCommand(lock: string, token: string): string {
  return `${holdsLock(lock, token)} && rm -rf -- ${shellQuote(lock)}; true`;
}

// Long pushes keep their lock fresh so it never looks dead
export function refreshLockCommand(lock: string, token: string): string {
  return `${holdsLock(lock, token)} && touch ${shellQuote(lock)}; true`;
}

export function newLockToken(): string {
  return crypto.randomBytes(16).toString('hex');
}

// The newest push to a server folder, from any computer: written on success,
// so an undo can tell whether someone pushed after it
export function lastPushMarker(remoteHome: string, remoteRoot: string): string {
  const hash = crypto.createHash('sha1').update(remoteRoot).digest('hex').slice(0, 12);
  return `${remoteHome}/.ssh-sync-last-push-${hash}`;
}

// Who holds the lock, for the message the next person sees
export function lockOwner(hostname: string, siteName: string, date = new Date()): string {
  const host = hostname.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64) || 'another computer';
  const site = siteName.replace(/[^A-Za-z0-9 ._-]/g, '').slice(0, 64);
  return `${host} (${site}) since ${date.toISOString()}`;
}
