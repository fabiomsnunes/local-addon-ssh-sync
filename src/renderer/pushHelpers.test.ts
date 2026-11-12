import { describe, it, expect } from 'vitest';
import {
  environmentTarget,
  sshCommandFor,
  remoteDomainOf,
  visibleDiffRows,
  summarizeSelection,
  buildPushFileSelection,
  isStaleLocalOnly,
  lastPullFrom,
} from './pushHelpers';

describe('environmentTarget', () => {
  it('prefers the ssh alias', () => {
    expect(environmentTarget({ sshAlias: 'wplus-site', sshHost: 'x', sshUser: 'y' })).toBe(
      'wplus-site',
    );
  });
  it('falls back to user@host, or the bare host', () => {
    expect(environmentTarget({ sshHost: 'example.com', sshUser: 'deploy' })).toBe(
      'deploy@example.com',
    );
    expect(environmentTarget({ sshHost: 'example.com' })).toBe('example.com');
  });
  it('returns an empty string for a missing env', () => {
    expect(environmentTarget(null)).toBe('');
    expect(environmentTarget(undefined)).toBe('');
  });
});

describe('sshCommandFor', () => {
  it('uses the alias as-is', () => {
    expect(sshCommandFor({ sshAlias: 'wplus-site' })).toBe('ssh wplus-site');
  });
  it('adds -p only for a non-default port', () => {
    expect(sshCommandFor({ sshHost: 'h', sshUser: 'u', sshPort: '22' })).toBe('ssh u@h');
    expect(sshCommandFor({ sshHost: 'h', sshUser: 'u', sshPort: '2222' })).toBe('ssh -p 2222 u@h');
  });
});

describe('remoteDomainOf', () => {
  it('returns host + path without the trailing slash', () => {
    expect(remoteDomainOf('https://wplus.pt')).toBe('wplus.pt');
    expect(remoteDomainOf('https://wplus.pt/')).toBe('wplus.pt');
    expect(remoteDomainOf('https://example.com/blog/')).toBe('example.com/blog');
  });
  it('returns an empty string for an invalid or missing URL', () => {
    expect(remoteDomainOf('not a url')).toBe('');
    expect(remoteDomainOf('')).toBe('');
    expect(remoteDomainOf(undefined)).toBe('');
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

describe('isStaleLocalOnly', () => {
  const pull = Date.parse('2026-11-12T10:00:00Z');
  it('marks only files added locally before the last pull', () => {
    expect(isStaleLocalOnly({ op: 'add', localMtime: pull - 1000 }, pull)).toBe(true);
    expect(isStaleLocalOnly({ op: 'add', localMtime: pull + 1000 }, pull)).toBe(false);
    expect(isStaleLocalOnly({ op: 'update', localMtime: pull - 1000 }, pull)).toBe(false);
    expect(isStaleLocalOnly({ op: 'add', isDir: true, localMtime: pull - 1000 }, pull)).toBe(false);
    expect(isStaleLocalOnly({ op: 'add' }, pull)).toBe(false);
    expect(isStaleLocalOnly({ op: 'add', localMtime: 1 }, null)).toBe(false);
  });

  it('takes the newest pull from that environment', () => {
    const history = [
      { mode: 'push', environmentId: 'a', at: '2026-11-12T12:00:00Z' },
      { mode: 'pull', environmentId: 'b', at: '2026-11-12T11:00:00Z' },
      { mode: 'pull', environmentId: 'a', at: '2026-11-12T10:00:00Z' },
    ];
    expect(lastPullFrom(history, 'a')).toBe(pull);
    expect(lastPullFrom(history, 'c')).toBeNull();
  });

  it('an unticked stale row forces the selective path', () => {
    const rows = [
      { op: 'update', path: 'a.php', selected: true },
      { op: 'add', path: 'old.php', selected: false },
    ];
    expect(buildPushFileSelection(rows, 'all')).toEqual({ files: ['a.php'], deletions: [] });
  });
});
