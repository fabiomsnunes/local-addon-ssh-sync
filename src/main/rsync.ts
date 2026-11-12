import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

import { EnvironmentInfo, RsyncInfo, PushDiffRow, SiteInfo } from './types';
import { expandPath } from './validators';

// The per-sync local webroot + SSH target shared by every rsync invocation
// (pull, push, and the dry-run preview).
export function rsyncSshContext(
  site: SiteInfo,
  envInfo: EnvironmentInfo,
): { localPublicPath: string; sshCommandForRsync: string; remoteHost: string } {
  return {
    localPublicPath: path.join(expandPath(site.path), 'app', 'public'),
    sshCommandForRsync: `ssh -p ${envInfo.sshPort} -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=60 -o ServerAliveCountMax=120`,
    remoteHost: `${envInfo.sshUser}@${envInfo.sshHost}`,
  };
}

export function sshArgs(envInfo: EnvironmentInfo, remoteCmd: string): string[] {
  return [
    '-p',
    envInfo.sshPort,
    '-o',
    'StrictHostKeyChecking=accept-new',
    // Keep the connection alive on long-running steps (big rsync, slow
    // mysqldump/import) so an idle NAT/firewall can't drop the channel
    // mid-sync: probe every 60s, give up only after 120 missed probes.
    '-o',
    'ServerAliveInterval=60',
    '-o',
    'ServerAliveCountMax=120',
    `${envInfo.sshUser}@${envInfo.sshHost}`,
    remoteCmd,
  ];
}

// Human-readable warning for an rsync partial transfer (exit 23/24), or null
// for a clean run. Typical cause: filenames in a legacy encoding (Latin-1 åäö)
// that macOS refuses ("Illegal byte sequence") — fixable only by renaming the
// files on the server.
export function describePartialTransfer(result: { code: number; stderr: string }): string | null {
  if (result.code === 0) return null;
  const failed = (result.stderr.match(/failed:|cannot /g) || []).length;
  console.warn(
    '[Kinsta] rsync partial transfer (code',
    result.code,
    '):',
    result.stderr.slice(-2000),
  );
  return `${failed || 'Some'} file(s) were skipped — usually filenames in a legacy encoding (e.g. Latin-1 åäö) that macOS cannot store. Rename those files on the server to fix. Everything else synced.`;
}

// macOS no longer ships GNU rsync: newer versions bundle openrsync, older ones
// rsync 2.6.9 — neither supports --info=progress2 (GNU >= 3.1). Version sniffing
// is unreliable across implementations, so we capability-probe each flag:
// `rsync <flag> --version` exits 0 only if the flag is recognized.
// Prefer a Homebrew/GNU rsync when installed.
let cachedRsync: RsyncInfo | null = null;

function probeRsyncFlag(bin: string, flag: string): boolean {
  try {
    return spawnSync(bin, [flag, '--version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

export function resolveRsync(): RsyncInfo {
  if (cachedRsync) return cachedRsync;

  const candidates = ['/opt/homebrew/bin/rsync', '/usr/local/bin/rsync', '/usr/bin/rsync', 'rsync'];
  let fallback: RsyncInfo | null = null;

  for (const bin of candidates) {
    if (bin.startsWith('/') && !fs.existsSync(bin)) continue;
    try {
      if (spawnSync(bin, ['--version'], { stdio: 'ignore' }).status !== 0) continue;
    } catch {
      continue;
    }
    const info: RsyncInfo = {
      bin,
      supportsProgress2: probeRsyncFlag(bin, '--info=progress2'),
      supportsProgress: probeRsyncFlag(bin, '--progress'),
      supportsItemizeChanges: probeRsyncFlag(bin, '--itemize-changes'),
      supportsOutFormat: probeRsyncFlag(bin, '--out-format=%n'),
    };
    if (info.supportsProgress2) {
      cachedRsync = info;
      return info;
    }
    fallback = fallback || info;
  }

  cachedRsync = fallback || {
    bin: 'rsync',
    supportsProgress2: false,
    supportsProgress: false,
    supportsItemizeChanges: false,
    supportsOutFormat: false,
  };
  return cachedRsync;
}

export function rsyncProgressArgs(rsync: RsyncInfo): string[] {
  // --info=progress2 reports the OVERALL percentage, but rsync's default
  // incremental recursion streams the file list while it transfers, so the
  // byte total it divides by keeps growing as more of the tree is discovered.
  // That makes the percentage non-monotonic: it shoots up early (e.g. 95% when
  // only one subdir is known) then drops back (27%) once the rest of wp-content
  // is scanned. --no-inc-recursive builds the complete file list up front so
  // the denominator is final from the first byte and the percentage only rises.
  // (--no-inc-recursive exists in GNU rsync >= 3.0 and progress2 in >= 3.1, so
  // progress2 support guarantees the flag is available; openrsync/2.6.9 get
  // neither.) The trade-off is a brief pause before transfer while the list is
  // built — well worth a progress bar that doesn't jump backwards.
  if (rsync.supportsProgress2) return ['--info=progress2', '--no-inc-recursive'];
  if (rsync.supportsProgress) return ['--progress'];
  return [];
}

// Parse rsync progress output into an overall percentage.
// - rsync >= 3.1 (--info=progress2): "  1,234,567  42%  ..." is overall — use directly.
// - rsync 2.6.9 (--progress): per-file % bounces, but "to-check=remaining/total"
//   after each file gives a stable overall estimate.
export function makeRsyncProgressParser(
  rsync: RsyncInfo,
  onPercent: (pct: number) => void,
): (chunk: string) => void {
  return (chunk: string) => {
    const toCheck = chunk.match(/to-check=(\d+)\/(\d+)/g);
    if (toCheck && toCheck.length) {
      const m = toCheck[toCheck.length - 1].match(/to-check=(\d+)\/(\d+)/)!;
      const remaining = parseInt(m[1], 10);
      const total = parseInt(m[2], 10);
      if (total > 0) onPercent(Math.round(((total - remaining) / total) * 100));
      return;
    }
    if (!rsync.supportsProgress2) return; // per-file % would bounce — skip
    const matches = chunk.match(/(\d{1,3})%/g);
    if (matches && matches.length) {
      const pct = parseInt(matches[matches.length - 1], 10);
      if (!isNaN(pct) && pct >= 0 && pct <= 100) onPercent(pct);
    }
  };
}

// rsync %M prints the source file's mtime as "YYYY/MM/DD-HH:MM:SS" (local TZ)
function parseRsyncMtime(s: string): number | undefined {
  if (!s || !s.includes('/')) return undefined;
  const t = new Date(s.replace('-', ' ')).getTime();
  return Number.isNaN(t) ? undefined : t;
}

// Parse one line of `rsync -n --itemize-changes --out-format='%i|%l|%M|%n'`.
// The mtime comes from rsync itself (%M) — statting thousands of files in the
// Electron main process would block Local's whole UI.
// %i is the YXcstpoguax flag string:
//   *deleting        — file will be removed on the receiver (--delete)
//   <f+++++++++      — new file transferred to remote (push direction)
//   <f.st......      — existing file, size/time changed → update
//   cd+++++++++      — new directory
//   .f / .d ...      — attrs only, no transfer → skip
export function parseItemizeLine(line: string): PushDiffRow | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  // Deletions: with --out-format the line is "*deleting|<len>|<mtime>|<path>";
  // without it rsync prints "*deleting   path". Handle both.
  if (trimmed.startsWith('*deleting')) {
    const rest = trimmed.includes('|')
      ? trimmed.split('|').slice(3).join('|') // %i|%l|%M|%n form
      : trimmed.slice('*deleting'.length).replace(/^\s+/, ''); // plain form
    if (!rest || rest === './') return null;
    const isDir = rest.endsWith('/');
    return { path: rest.replace(/\/$/, ''), op: 'delete', isDir, sizeBytes: 0 };
  }

  const parts = trimmed.split('|');
  if (parts.length < 4) return null; // rsync chatter ("sending incremental file list", totals, ...)
  const flags = parts[0];
  const sizeBytes = parseInt(parts[1], 10) || 0;
  const localMtime = parseRsyncMtime(parts[2]);
  const filePath = parts.slice(3).join('|'); // paths may legitimately contain '|'

  if (!filePath || filePath === './') return null;
  if (!/^[<>ch.*]/.test(flags) || flags.length < 2) return null;

  const changeType = flags[0]; // < > transfer, c create (dirs), . attrs-only, h hardlink
  const fileType = flags[1]; // f file, d dir, L symlink

  if (changeType === '.') return null; // attribute-only change — not content
  const isDir = fileType === 'd';
  const isNew = flags
    .slice(2)
    .split('')
    .every((c) => c === '+');

  return {
    path: filePath.replace(/\/$/, ''),
    op: isNew ? 'add' : 'update',
    isDir,
    sizeBytes: isDir ? 0 : sizeBytes,
    ...(isDir ? {} : { localMtime }),
  };
}

export function parseItemizeOutput(stdout: string): PushDiffRow[] {
  return stdout
    .split('\n')
    .map(parseItemizeLine)
    .filter((r): r is PushDiffRow => r !== null);
}

// Degraded fallback for rsync builds without --itemize-changes/--out-format
// (openrsync): `rsync -n -v` prints one path per line plus "deleting X" lines.
// Cannot distinguish add vs update, has no sizes or mtimes.
export function parseVerboseDryRun(stdout: string): PushDiffRow[] {
  const rows: PushDiffRow[] = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line || line === './') continue;
    if (/^(sending|building|sent |total |created directory|receiving)/.test(line)) continue;
    if (line.startsWith('deleting ')) {
      const p = line.slice('deleting '.length);
      rows.push({ path: p.replace(/\/$/, ''), op: 'delete', isDir: p.endsWith('/'), sizeBytes: 0 });
    } else {
      rows.push({
        path: line.replace(/\/$/, ''),
        op: 'update',
        isDir: line.endsWith('/'),
        sizeBytes: 0,
      });
    }
  }
  return rows;
}

// Security: the selective-push remote `rm` is the only place a file path enters
// an ssh remote-command STRING (everything else is spawn arg arrays). Strictly
// validate, then single-quote. Returns null when the path must be rejected.
export function safeRemoteRelPath(p: string): string | null {
  if (!p || p.length > 4096) return null;
  if (p.includes("'") || p.includes('\\')) return null; // would escape the quoting
  if (p.includes('\n') || p.includes('\r') || p.includes('\0')) return null;
  if (p.startsWith('/') || p.startsWith('~')) return null; // must stay relative
  if (p.split('/').some((seg) => seg === '..' || seg === '')) return null; // no traversal, no '//'
  if (/[`$!;&<>(){}*?#]/.test(p)) return null; // defense in depth inside single quotes
  return `'${p}'`;
}

// Pure builder for the push rsync invocation so the flag logic is unit-testable.
// Selective pushes (files list) drop --delete: deletions are executed separately
// (per checked row) so unchecked deletions are preserved on the remote.
export function buildPushRsyncArgs(opts: {
  rsync: RsyncInfo;
  excludeArgs: string[];
  sshCommand: string;
  localPublicPath: string;
  remoteHost: string;
  mode?: 'newer' | 'all';
  filesFromPath?: string;
}): string[] {
  const args = ['-az'];
  if (opts.filesFromPath) {
    args.push(`--files-from=${opts.filesFromPath}`);
  } else {
    args.push('--delete');
  }
  if (opts.mode === 'newer') args.push('--update');
  args.push(...rsyncProgressArgs(opts.rsync), ...opts.excludeArgs);
  args.push('-e', opts.sshCommand, `${opts.localPublicPath}/`, `${opts.remoteHost}:~/public/`);
  return args;
}
