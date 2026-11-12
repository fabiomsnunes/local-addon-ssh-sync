// Shared renderer-side shapes. Previously duplicated across KinstaPage,
// KinstaPushScreen, and KinstaPullDrawer.

// A Kinsta environment as returned by the main process (`kinsta:getEnvironments`).
export interface Environment {
  id: string;
  name: string;
  display_name: string;
  is_premium: boolean;
  cdn_cache_id?: string;
  primaryDomain?: { name: string };
  domains?: Array<{ name: string }>;
  ssh_connection?: {
    ssh_ip?: { external_ip: string };
    ssh_port?: string;
  };
}

// The flattened env descriptor the main process expects for a sync.
export interface EnvironmentInfo {
  envId: string;
  envType: 'staging' | 'live';
  sshHost: string;
  sshPort: string;
  sshUser: string;
  remoteDomain: string;
  cdnCacheId?: string;
}

// Sync progress payload streamed over `kinsta:syncProgress`.
export interface SyncProgress {
  stage: string;
  progress: number;
  message: string;
}
