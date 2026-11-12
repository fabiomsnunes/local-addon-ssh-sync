import { describe, it, expect } from 'vitest';
import {
  sanitizeSshUser,
  buildEnvInfo,
  envLabel,
  visibleDiffRows,
  summarizeSelection,
  buildPushFileSelection,
} from './pushHelpers';

describe('envLabel', () => {
  it('labels premium as Production and non-premium as Staging', () => {
    expect(envLabel({ is_premium: true })).toBe('Production');
    expect(envLabel({ is_premium: false })).toBe('Staging');
  });
  it('returns an empty string for a missing env', () => {
    expect(envLabel(null)).toBe('');
    expect(envLabel(undefined)).toBe('');
  });
});

describe('sanitizeSshUser', () => {
  it('lowercases and strips everything non-alphanumeric', () => {
    expect(sanitizeSshUser('Nuclear Sweden')).toBe('nuclearsweden');
    expect(sanitizeSshUser('GBD-Shop_2024!')).toBe('gbdshop2024');
    expect(sanitizeSshUser('  spaces  ')).toBe('spaces');
  });
  it('handles empty/undefined input', () => {
    expect(sanitizeSshUser('')).toBe('');
    expect(sanitizeSshUser(undefined as unknown as string)).toBe('');
  });
});

describe('buildEnvInfo', () => {
  const env = {
    id: 'env-1',
    is_premium: false,
    ssh_connection: { ssh_ip: { external_ip: '1.2.3.4' }, ssh_port: 36750 },
    primaryDomain: { name: 'stg-foo.kinsta.cloud' },
    domains: [{ name: 'other.example.com' }],
    cdn_cache_id: null,
  };
  const link = { kinstaSiteSlug: 'Foo Bar', kinstaSiteName: 'Foo Bar Display' };

  it('returns null when env or link is missing', () => {
    expect(buildEnvInfo(undefined, link)).toBeNull();
    expect(buildEnvInfo(env, null)).toBeNull();
  });

  it('maps a staging environment with a sanitized ssh user', () => {
    expect(buildEnvInfo(env, link)).toEqual({
      envId: 'env-1',
      envType: 'staging',
      sshHost: '1.2.3.4',
      sshPort: '36750',
      sshUser: 'foobar',
      remoteDomain: 'stg-foo.kinsta.cloud',
      cdnCacheId: null,
    });
  });

  it('marks premium environments as live and prefers the slug for the ssh user', () => {
    const info = buildEnvInfo({ ...env, is_premium: true }, link)!;
    expect(info.envType).toBe('live');
    expect(info.sshUser).toBe('foobar'); // from slug, not display name
  });

  it('falls back to the site name when no slug, port 22, and first domain', () => {
    const info = buildEnvInfo(
      { id: 'e', is_premium: false, domains: [{ name: 'fallback.example.com' }] },
      { kinstaSiteName: 'My Site' },
    )!;
    expect(info.sshPort).toBe('22');
    expect(info.sshUser).toBe('mysite');
    expect(info.remoteDomain).toBe('fallback.example.com');
    expect(info.sshHost).toBe('');
  });
});

describe('visibleDiffRows', () => {
  it('hides add/update directory rows but keeps files and folder deletions', () => {
    const rows = [
      { op: 'add', path: 'a.txt' },
      { op: 'update', path: 'dir', isDir: true },
      { op: 'add', path: 'newdir', isDir: true },
      { op: 'delete', path: 'gone-dir', isDir: true },
      { op: 'delete', path: 'gone.txt' },
    ];
    expect(visibleDiffRows(rows).map((r) => r.path)).toEqual(['a.txt', 'gone-dir', 'gone.txt']);
  });
});

describe('summarizeSelection', () => {
  const rows = [
    { op: 'add', path: 'a', sizeBytes: 100, selected: true },
    { op: 'update', path: 'b', sizeBytes: 50, selected: true },
    { op: 'delete', path: 'c', sizeBytes: 999, selected: true },
    { op: 'add', path: 'd', sizeBytes: 200, selected: false },
  ];
  it('counts adds/updates, deletes, and bytes (deletes contribute 0 bytes)', () => {
    const s = summarizeSelection(rows);
    expect(s.addUpdateCount).toBe(2);
    expect(s.deleteCount).toBe(1);
    expect(s.totalBytes).toBe(150);
    expect(s.allSelected).toBe(false);
    expect(s.someSelected).toBe(true);
  });
  it('allSelected is false for an empty list, true when every row is selected', () => {
    expect(summarizeSelection([]).allSelected).toBe(false);
    expect(summarizeSelection([{ op: 'add', path: 'x', selected: true }]).allSelected).toBe(true);
  });
});

describe('buildPushFileSelection', () => {
  const rows = [
    { op: 'add', path: 'a', selected: true },
    { op: 'delete', path: 'b', selected: true },
  ];
  it('returns the empty fast-path only when all selected AND mode is "all"', () => {
    expect(buildPushFileSelection(rows, 'all')).toEqual({});
  });
  it('returns explicit files/deletions for "newer" mode even when all selected', () => {
    expect(buildPushFileSelection(rows, 'newer')).toEqual({ files: ['a'], deletions: ['b'] });
  });
  it('returns explicit lists for a partial selection', () => {
    const partial = [
      { op: 'add', path: 'a', selected: true },
      { op: 'add', path: 'c', selected: false },
      { op: 'delete', path: 'b', selected: true },
    ];
    expect(buildPushFileSelection(partial, 'all')).toEqual({ files: ['a'], deletions: ['b'] });
  });
  it('never takes the fast path for an empty diff', () => {
    expect(buildPushFileSelection([], 'all')).toEqual({ files: [], deletions: [] });
  });
});
