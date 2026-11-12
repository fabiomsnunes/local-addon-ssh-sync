// Pure, dependency-free helpers extracted from the push screen so its
// non-React logic (environment targets, diff filtering,
// selection math, the rsync fast-path decision) can be unit-tested without a DOM
// or Electron. Structural (duck-typed) parameter shapes keep the screen's richer
// objects compatible without sharing the full component types.

export interface DiffRowLike {
  op: string;
  path: string;
  isDir?: boolean;
  sizeBytes?: number;
  selected?: boolean;
}

export interface EnvironmentLike {
  sshAlias?: string;
  sshHost?: string;
  sshUser?: string;
  sshPort?: string;
}

// What the user would type after `ssh`: the alias, or user@host
export function environmentTarget(env: EnvironmentLike | null | undefined): string {
  if (!env) return '';
  if (env.sshAlias) return env.sshAlias;
  return env.sshUser && env.sshHost ? `${env.sshUser}@${env.sshHost}` : env.sshHost || '';
}

// A copy-pasteable ssh command for the environment
export function sshCommandFor(env: EnvironmentLike | null | undefined): string {
  if (!env) return '';
  if (env.sshAlias) return `ssh ${env.sshAlias}`;
  const port = env.sshPort && env.sshPort !== '22' ? `-p ${env.sshPort} ` : '';
  return `ssh ${port}${environmentTarget(env)}`;
}

// host + path of the site URL (what the user types to confirm a production
// database push; mirrors remoteDomainFromUrl in the main process)
export function remoteDomainOf(remoteUrl: string | null | undefined): string {
  if (!remoteUrl) return '';
  try {
    const url = new URL(remoteUrl);
    return `${url.host}${url.pathname}`.replace(/\/+$/, '');
  } catch {
    return '';
  }
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
