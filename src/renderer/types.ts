// Shared renderer-side shapes. Mirror src/main/types.ts (the main process owns
// validation; these only describe what arrives over IPC).

export interface ServerEnvironment {
  id: string;
  label: string;
  sshAlias?: string;
  sshHost?: string;
  sshUser?: string;
  sshPort?: string;
  auth: 'key' | 'password';
  remotePath: string;
  remoteUrl: string;
  wpCommand: string;
  cacheCommand?: string;
  extraExcludes: string[];
  isProduction: boolean;
}

export interface SyncHistoryEntry {
  mode: 'pull' | 'push';
  environmentId: string;
  environmentLabel: string;
  at: string;
  durationMs: number;
}

export interface SiteProfile {
  localSiteId: string;
  environments: ServerEnvironment[];
  lastPullAt?: string;
  lastPushAt?: string;
  history?: SyncHistoryEntry[];
}

// Sync progress payload streamed over `sshsync:syncProgress`.
export interface SyncProgress {
  stage: string;
  progress: number;
  message: string;
}
