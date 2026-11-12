// Type-only imports — keeps this module importable outside Electron (tests)
import type * as Local from '@getflywheel/local';
import type * as fs from 'fs';
import type { ChildProcess } from 'child_process';
import type { AxiosInstance } from 'axios';

export interface KinstaConfig {
  companyId?: string;
}

export interface SyncHistoryEntry {
  mode: 'pull' | 'push';
  envType: string; // 'live' | 'staging'
  at: string; // ISO timestamp
  durationMs: number;
}

export interface SiteLink {
  localSiteId: string;
  kinstaSiteId: string;
  kinstaSiteName: string; // Display name for UI
  kinstaSiteSlug: string; // Actual site name for SSH username
  lastPullAt?: string; // ISO timestamp of last successful pull
  lastPushAt?: string; // ISO timestamp of last successful push
  history?: SyncHistoryEntry[]; // Most recent first, capped
}

export interface EnvironmentInfo {
  envId: string;
  envType: 'staging' | 'live';
  sshHost: string;
  sshPort: string;
  sshUser: string;
  remoteDomain: string;
  cdnCacheId?: string; // needed for CDN cache clearing (from env.cdn_cache_id)
}

export interface SyncProgress {
  stage: string;
  progress: number;
  message: string;
}

export interface SyncOptions {
  includeUploads?: boolean;
  includeDatabase?: boolean;
  // Push only: create a native Kinsta backup (files + DB) before pushing
  kinstaBackup?: boolean;
  // Push only (from the preview screen): sync mode + selective file lists.
  // When `files` is present the rsync runs with --files-from and WITHOUT
  // --delete; `deletions` are executed separately so unchecked deletions
  // are preserved on the remote.
  mode?: 'newer' | 'all';
  files?: string[];
  deletions?: string[];
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
  path: string; // relative to ~/public
  op: 'add' | 'update' | 'delete';
  isDir: boolean;
  sizeBytes: number; // rsync %l; 0 for deletes/dirs/unknown
  localMtime?: number; // epoch ms from rsync %M (add/update only)
}

export interface SyncParams {
  localSiteId: string;
  site: SiteInfo;
  envInfo: EnvironmentInfo;
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
// pass fakes (a command runner that matches on cmd/args, an in-memory site-link
// store, fake binary paths, a sandboxed fs, …).
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
  >;
  runCommand: (
    sync: ActiveSync,
    cmd: string,
    args: string[],
    opts?: RunOptions,
  ) => Promise<{ code: number; stderr: string }>;
  activeSyncs: Map<string, ActiveSync>;
  activePreviews: Map<string, ActiveSync>;
  loadSiteLinks: () => Record<string, SiteLink>;
  validateEnvironmentInfo: (env: EnvironmentInfo) => boolean;
  getMysqlSocketPath: (localSiteId: string) => string;
  preflightRemote: (envInfo: EnvironmentInfo) => Promise<string | null>;
  resolveRsync: () => RsyncInfo;
  findServiceBinary: (prefixes: string[], binName: string) => string | null;
  findWpCliPhar: () => string | null;
  getApiKey: () => string | null;
  getKinstaClient: (apiKey: string) => AxiosInstance;
  createKinstaBackup: (
    client: AxiosInstance,
    envId: string,
    sync: ActiveSync,
    onMessage: (msg: string) => void,
  ) => Promise<boolean>;
  clearKinstaCaches: (
    client: AxiosInstance,
    envId: string,
    cdnCacheId?: string,
  ) => Promise<string[]>;
  recordSync: (
    localSiteId: string,
    mode: 'pull' | 'push',
    envType: string,
    durationMs: number,
  ) => void;
  notify: (title: string, message: string) => void;
  ensureConfigDir: () => void;
  tempDir: string;
  sendProgress: (progress: SyncProgress) => void;
}
