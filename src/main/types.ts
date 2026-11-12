// Type-only imports — keeps this module importable outside Electron (tests)
import type * as Local from '@getflywheel/local';
import type * as fs from 'fs';
import type { ChildProcess } from 'child_process';

export type SshAuthMethod = 'key' | 'password';

// One server a Local site syncs with (e.g. Production, Staging). The connection
// is either an alias from ~/.ssh/config (which then owns host, user, port and
// key) or an explicit host/user/port.
export interface ServerEnvironment {
  id: string;
  label: string;
  sshAlias?: string;
  sshHost?: string;
  sshUser?: string;
  sshPort?: string;
  auth: SshAuthMethod;
  // WordPress root on the server: absolute, or relative to the SSH user's home (~/...)
  remotePath: string;
  // The site's URL on the server, e.g. https://example.com
  remoteUrl: string;
  // How WP-CLI is invoked on the server, e.g. `wp` or `php8.2 ~/wp-cli.phar`
  wpCommand: string;
  // Optional command run in the WordPress root after a push, e.g. `wp cache flush`
  cacheCommand?: string;
  // Extra rsync exclude patterns for this server, on top of EXCLUDE_PATTERNS
  extraExcludes: string[];
  isProduction: boolean;
}

export interface SyncHistoryEntry {
  mode: 'pull' | 'push';
  environmentId: string;
  environmentLabel: string;
  at: string; // ISO timestamp
  durationMs: number;
}

export interface SiteProfile {
  localSiteId: string;
  environments: ServerEnvironment[];
  lastPullAt?: string; // ISO timestamp of last successful pull
  lastPushAt?: string; // ISO timestamp of last successful push
  history?: SyncHistoryEntry[]; // Most recent first, capped
}

export interface SyncProgress {
  stage: string;
  progress: number;
  message: string;
}

export interface SyncOptions {
  includeUploads?: boolean;
  includeDatabase?: boolean;
  // Push only (from the preview screen): sync mode + selective file lists.
  // When `files` is present the rsync runs with --files-from and WITHOUT
  // --delete; `deletions` are executed separately so unchecked deletions
  // are preserved on the remote.
  mode?: 'newer' | 'all';
  files?: string[];
  deletions?: string[];
  // Push only: replacing a Production database requires Migration mode plus
  // the remote domain typed back by the user.
  migrationMode?: boolean;
  confirmDomain?: string;
}

// The subset of Local.SiteJSON we actually use (full object arrives over IPC)
export interface SiteInfo {
  id: string;
  name?: string;
  path: string;
  domain: string;
  multiSite?: Local.SiteJSON['multiSite'];
  mysql?: { database?: string; user?: string; password?: string };
}

export class CancelledError extends Error {
  constructor() {
    super('Sync cancelled');
    this.name = 'CancelledError';
  }
}

export interface ActiveSync {
  cancelled: boolean;
  child: ChildProcess | null;
}

export interface RunOptions {
  // Pipe this file into the process' stdin (e.g. mysql < dump.sql)
  stdinFile?: string;
  // Pipe the process' stdout into this file (e.g. mysqldump > dump.sql)
  stdoutFile?: string;
  // Called for every stdout chunk (e.g. rsync progress parsing)
  onStdout?: (chunk: string) => void;
  env?: NodeJS.ProcessEnv;
  // Extra exit codes to treat as success (e.g. rsync 23/24 = partial transfer).
  // The caller can inspect the resolved { code, stderr } to warn about them.
  okCodes?: number[];
}

// An open, verified connection to one environment. Every ssh/scp/rsync call of
// a sync reuses its multiplexed master, so the server sees one authenticated
// session per sync.
export interface RemoteConnection {
  // `alias` or `user@host`
  target: string;
  // ssh options shared by ssh, scp and rsync's remote shell (port, keepalives,
  // ControlPath). Values never contain whitespace.
  sshOptions: string[];
  // The WordPress root resolved to an absolute path on the server
  remoteRoot: string;
  close: () => Promise<void>;
}

// macOS no longer ships GNU rsync: newer versions bundle openrsync, older ones
// rsync 2.6.9 — neither supports --info=progress2 (GNU >= 3.1). Version sniffing
// is unreliable across implementations, so we capability-probe each flag:
// `rsync <flag> --version` exits 0 only if the flag is recognized.
// Prefer a Homebrew/GNU rsync when installed.
export interface RsyncInfo {
  bin: string;
  supportsProgress2: boolean;
  supportsProgress: boolean;
  // Needed for the push preview (dry-run diff). openrsync lacks both —
  // the preview then degrades to a name-only list.
  supportsItemizeChanges: boolean;
  supportsOutFormat: boolean;
}

export interface PushDiffRow {
  path: string; // relative to the remote WordPress root
  op: 'add' | 'update' | 'delete';
  isDir: boolean;
  sizeBytes: number; // rsync %l; 0 for deletes/dirs/unknown
  localMtime?: number; // epoch ms from rsync %M (add/update only)
}

export interface SyncParams {
  localSiteId: string;
  site: SiteInfo;
  environment: ServerEnvironment;
  options: SyncOptions;
}

export interface SyncResult {
  success: boolean;
  cancelled?: boolean;
  error?: string;
  warning?: string | null;
}

// Every environment-touching dependency executePull/executePush rely on. The
// `defaultPullPushDeps` factory wires these to the real implementations; tests
// pass fakes (a command runner that matches on cmd/args, a fake connection,
// fake binary paths, a sandboxed fs, …).
export interface PullPushDeps {
  fs: Pick<
    typeof fs,
    | 'existsSync'
    | 'statSync'
    | 'readFileSync'
    | 'writeFileSync'
    | 'copyFileSync'
    | 'unlinkSync'
    | 'readdirSync'
    | 'mkdirSync'
  >;
  runCommand: (
    sync: ActiveSync,
    cmd: string,
    args: string[],
    opts?: RunOptions,
  ) => Promise<{ code: number; stderr: string }>;
  activeSyncs: Map<string, ActiveSync>;
  activePreviews: Map<string, ActiveSync>;
  // Opens the multiplexed connection and verifies the WordPress root and WP-CLI.
  // Rejects with a user-facing message when the server is unreachable.
  connectRemote: (environment: ServerEnvironment) => Promise<RemoteConnection>;
  getMysqlSocketPath: (localSiteId: string) => string;
  resolveRsync: () => RsyncInfo;
  findServiceBinary: (prefixes: string[], binName: string) => string | null;
  findWpCliPhar: () => string | null;
  recordSync: (
    localSiteId: string,
    mode: 'pull' | 'push',
    environment: ServerEnvironment,
    durationMs: number,
  ) => void;
  notify: (title: string, message: string) => void;
  ensureConfigDir: () => void;
  tempDir: string;
  // Remote databases exported before a push land here (the rollback source)
  backupsDir: string;
  sendProgress: (progress: SyncProgress) => void;
}
