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
  hasFilesBackup: boolean;
  hasDatabaseBackup: boolean;
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
export function parseAddedFromOutFormat(stdout: string): { files: string[]; dirs: string[] } {
  const files: string[] = [];
  const dirs: string[] = [];
  // Progress output ends its lines with \r, so a marker can follow progress
  // text on the same "line": find every marker wherever it starts.
  const marker = new RegExp(`${OUT_FORMAT_MARKER}\\|([^|\\r\\n]+)\\|([^\\r\\n]+)`, 'g');
  for (const match of stdout.matchAll(marker)) {
    const flags = match[1];
    const name = match[2].trim().replace(/\/$/, '');
    if (!name || name === '.') continue;
    const isNew = flags.length > 2 && /^\++$/.test(flags.slice(2));
    if (!isNew) continue;
    if (flags[1] === 'd') dirs.push(name);
    else if (flags[1] === 'f') files.push(name);
  }
  return { files, dirs };
}

// Move the ticked deletions into the backup folder instead of removing them.
// `quotedPaths` are already validated and single-quoted (safeRemoteRelPath).
export function moveToBackupCommand(backupDir: string, quotedPaths: string[]): string {
  return [
    `b=${shellQuote(backupDir)}`,
    `for p in ${quotedPaths.join(' ')}; do [ -e "$p" ] || continue; mkdir -p "$b/$(dirname "$p")" && mv -- "$p" "$b/$p" || exit 1; done`,
  ].join('; ');
}

// Folders the push created, deepest first, removed only when empty.
export function removeEmptyDirsCommand(quotedDirs: string[]): string {
  return `for d in ${quotedDirs.join(' ')}; do rmdir -- "$d" 2>/dev/null; done; true`;
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

export function acquireLockCommand(lock: string, owner: string): string {
  const q = shellQuote(lock);
  return [
    `if mkdir ${q} 2>/dev/null; then :`,
    // A lock older than LOCK_STALE_MINUTES belongs to a push that died
    `elif [ -n "$(find ${q} -maxdepth 0 -mmin +${LOCK_STALE_MINUTES} 2>/dev/null)" ]; then rm -rf -- ${q} && mkdir ${q} || { echo SSHSYNC_LOCK=busy; exit 0; }`,
    `else printf 'SSHSYNC_LOCK=busy %s\\n' "$(cat ${q}/owner 2>/dev/null)"; exit 0; fi`,
    `printf '%s\\n' ${shellQuote(owner)} > ${q}/owner`,
    'echo SSHSYNC_LOCK=ok',
  ].join('; ');
}

export function parseLockOutput(stdout: string): { ok: true } | { ok: false; owner: string } {
  const match = stdout.match(/SSHSYNC_LOCK=(ok|busy)(.*)/);
  if (match && match[1] === 'ok') return { ok: true };
  return { ok: false, owner: match ? match[2].trim() : '' };
}

export function releaseLockCommand(lock: string): string {
  return `rm -rf -- ${shellQuote(lock)}`;
}

// Who holds the lock, for the message the next person sees
export function lockOwner(hostname: string, siteName: string, date = new Date()): string {
  const host = hostname.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64) || 'another computer';
  const site = siteName.replace(/[^A-Za-z0-9 ._-]/g, '').slice(0, 64);
  return `${host} (${site}) since ${date.toISOString()}`;
}
