// Pure, dependency-free helpers extracted from KinstaPushScreen so the push
// screen's non-React logic (SSH user sanitization, env mapping, diff filtering,
// selection math, the rsync fast-path decision) can be unit-tested without a DOM
// or Electron. Structural (duck-typed) parameter shapes keep the screen's richer
// objects compatible without sharing the full component types.

export interface EnvLike {
  id: string;
  is_premium?: boolean;
  ssh_connection?: { ssh_ip?: { external_ip?: string }; ssh_port?: string | number };
  primaryDomain?: { name?: string };
  domains?: Array<{ name?: string }>;
  cdn_cache_id?: string | null;
}

export interface LinkLike {
  kinstaSiteSlug?: string;
  kinstaSiteName?: string;
}

export interface PushEnvInfo {
  envId: string;
  envType: 'live' | 'staging';
  sshHost: string;
  sshPort: string;
  sshUser: string;
  remoteDomain: string;
  cdnCacheId?: string | null;
}

export interface DiffRowLike {
  op: string;
  path: string;
  isDir?: boolean;
  sizeBytes?: number;
  selected?: boolean;
}

// Kinsta SSH usernames are the site slug lowercased with everything non-alphanumeric
// stripped. Kept pure + tested because it feeds a shell-adjacent SSH target.
export function sanitizeSshUser(name: string): string {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Map a Kinsta environment + the site link into the EnvironmentInfo the main
// process expects. Returns null when either input is missing.
export function buildEnvInfo(
  env: EnvLike | undefined | null,
  link: LinkLike | null,
): PushEnvInfo | null {
  if (!env || !link) return null;
  const siteName = link.kinstaSiteSlug || link.kinstaSiteName || '';
  return {
    envId: env.id,
    envType: env.is_premium ? 'live' : 'staging',
    sshHost: env.ssh_connection?.ssh_ip?.external_ip || '',
    sshPort: String(env.ssh_connection?.ssh_port || '22'),
    sshUser: sanitizeSshUser(siteName),
    remoteDomain: env.primaryDomain?.name || env.domains?.[0]?.name || '',
    cdnCacheId: env.cdn_cache_id,
  };
}

// The user-facing label for an environment. Kinsta's "premium" flag is the
// production environment; everything else is staging. ("Live" is the stored
// envType; "Production" is the label shown throughout the UI.)
export function envLabel(env: { is_premium?: boolean } | null | undefined): string {
  if (!env) return '';
  return env.is_premium ? 'Production' : 'Staging';
}

// Hide add/update directory rows (implied by their files); keep folder deletions.
export function visibleDiffRows<T extends DiffRowLike>(rows: T[]): T[] {
  return rows.filter((r) => !(r.isDir && r.op !== 'delete'));
}

export interface SelectionSummary {
  addUpdateCount: number;
  deleteCount: number;
  totalBytes: number;
  allSelected: boolean;
  someSelected: boolean;
}

export function summarizeSelection(rows: DiffRowLike[]): SelectionSummary {
  const selected = rows.filter((r) => r.selected);
  return {
    addUpdateCount: selected.filter((r) => r.op !== 'delete').length,
    deleteCount: selected.filter((r) => r.op === 'delete').length,
    totalBytes: selected.reduce((sum, r) => sum + (r.op === 'delete' ? 0 : r.sizeBytes || 0), 0),
    allSelected: rows.length > 0 && rows.every((r) => r.selected),
    someSelected: rows.some((r) => r.selected),
  };
}

// The push payload's file selection. When everything is selected AND the mode is
// "all modified", send nothing extra so the main process takes the plain
// rsync --delete fast path. Otherwise send explicit files + deletions lists
// (the selective path, which never deletes anything not ticked).
export function buildPushFileSelection(
  rows: DiffRowLike[],
  mode: 'newer' | 'all',
): Record<string, never> | { files: string[]; deletions: string[] } {
  const selected = rows.filter((r) => r.selected);
  const allSelected = rows.length > 0 && rows.every((r) => r.selected);
  if (allSelected && mode === 'all') return {};
  return {
    files: selected.filter((r) => r.op !== 'delete').map((r) => r.path),
    deletions: selected.filter((r) => r.op === 'delete').map((r) => r.path),
  };
}
