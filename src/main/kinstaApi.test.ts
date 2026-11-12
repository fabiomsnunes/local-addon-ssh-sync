import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  getKinstaClient,
  waitForKinstaOperation,
  createKinstaBackup,
  clearKinstaCaches,
} from './kinstaApi';
import { KINSTA_BACKUP_TAG } from './constants';
import { CancelledError, ActiveSync } from './types';

const newSync = (): ActiveSync => ({ cancelled: false, child: null });

afterEach(() => {
  vi.useRealTimers();
});

// --- waitForKinstaOperation -------------------------------------------------

describe('waitForKinstaOperation', () => {
  it('resolves once the operation reports status 200 in the body', async () => {
    vi.useFakeTimers();
    const client = { get: vi.fn(async () => ({ data: { status: 200 } })) } as any;
    const p = waitForKinstaOperation(client, 'op-1', newSync());
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBeUndefined();
  });

  it('keeps polling on 202 (in progress) until 200', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const client = {
      get: vi.fn(async () => ({ data: { status: ++calls >= 3 ? 200 : 202 } })),
    } as any;
    const p = waitForKinstaOperation(client, 'op-1', newSync());
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBeUndefined();
    expect(calls).toBe(3);
  });

  it('throws a descriptive error on HTTP 500', async () => {
    vi.useFakeTimers();
    const client = {
      get: vi.fn(async () => {
        throw { response: { status: 500, data: { message: 'boom' } } };
      }),
    } as any;
    const p = waitForKinstaOperation(client, 'op-1', newSync());
    const assertion = expect(p).rejects.toThrow(/Kinsta operation failed: boom/);
    await vi.runAllTimersAsync();
    await assertion;
  });

  it('throws CancelledError immediately when the sync is cancelled', async () => {
    const client = { get: vi.fn() } as any;
    await expect(
      waitForKinstaOperation(client, 'op-1', { cancelled: true, child: null }),
    ).rejects.toBeInstanceOf(CancelledError);
    expect(client.get).not.toHaveBeenCalled();
  });
});

// --- createKinstaBackup -----------------------------------------------------

const backupListResponse = (backups: any[]) => ({ data: { environment: { backups } } });

describe('createKinstaBackup', () => {
  it('creates a manual backup when a slot is free (no deletion)', async () => {
    vi.useFakeTimers();
    const client = {
      get: vi.fn(async (url: string) =>
        url.includes('/operations/')
          ? { data: { status: 200 } }
          : backupListResponse([{ id: 1, type: 'manual', created_at: 1 }]),
      ),
      post: vi.fn(async () => ({ data: { operation_id: 'op-create' } })),
      delete: vi.fn(),
    } as any;

    const p = createKinstaBackup(client, 'env-1', newSync(), () => {});
    await vi.runAllTimersAsync();
    expect(await p).toBe(true);
    expect(client.delete).not.toHaveBeenCalled();
    expect(client.post).toHaveBeenCalledWith('/sites/environments/env-1/manual-backups', {
      tag: KINSTA_BACKUP_TAG,
    });
  });

  it('frees a slot by deleting OUR oldest backup when all manual slots are full', async () => {
    vi.useFakeTimers();
    // 5 manual = the limit. Two are ours (kinsta-sync); the oldest of those is id 3.
    const backups = [
      { id: 1, type: 'manual', note: 'kinsta-sync-pre-push', created_at: 300 },
      { id: 2, type: 'manual', note: 'my own backup', created_at: 100 },
      { id: 3, type: 'manual', note: 'kinsta-sync-pre-push', created_at: 200 },
      { id: 4, type: 'manual', note: 'another user backup', created_at: 50 },
      { id: 5, type: 'manual', note: 'user', created_at: 75 },
    ];
    const client = {
      get: vi.fn(async (url: string) =>
        url.includes('/operations/') ? { data: { status: 200 } } : backupListResponse(backups),
      ),
      post: vi.fn(async () => ({ data: { operation_id: 'op-create' } })),
      delete: vi.fn(async () => ({ data: { operation_id: 'op-del' } })),
    } as any;

    const p = createKinstaBackup(client, 'env-1', newSync(), () => {});
    await vi.runAllTimersAsync();
    expect(await p).toBe(true);
    // deletes the oldest of OUR backups (id 3, created_at 200) — never a user's
    expect(client.delete).toHaveBeenCalledWith('/sites/environments/backups/3');
    expect(client.post).toHaveBeenCalledOnce();
  });

  it('throws (instead of polling forever) if Kinsta omits the operation id', async () => {
    const client = {
      get: vi.fn(async () => backupListResponse([{ id: 1, type: 'manual', created_at: 1 }])),
      post: vi.fn(async () => ({ data: {} })), // no operation_id
      delete: vi.fn(),
    } as any;
    await expect(createKinstaBackup(client, 'env-1', newSync(), () => {})).rejects.toThrow(
      /operation id/,
    );
  });

  it('returns false (and changes nothing) when every full slot is the users own', async () => {
    const backups = Array.from({ length: 5 }, (_, i) => ({
      id: i + 1,
      type: 'manual',
      note: 'user backup',
      created_at: i,
    }));
    const client = {
      get: vi.fn(async () => backupListResponse(backups)),
      post: vi.fn(),
      delete: vi.fn(),
    } as any;

    expect(await createKinstaBackup(client, 'env-1', newSync(), () => {})).toBe(false);
    expect(client.delete).not.toHaveBeenCalled();
    expect(client.post).not.toHaveBeenCalled();
  });
});

// --- clearKinstaCaches ------------------------------------------------------

describe('clearKinstaCaches', () => {
  it('always clears the page cache and reports it', async () => {
    const client = { post: vi.fn(async () => ({})) } as any;
    const cleared = await clearKinstaCaches(client, 'env-1');
    expect(cleared).toEqual(['page', 'edge']); // no CDN without a cache id
    expect(client.post).toHaveBeenCalledWith('/sites/tools/clear-cache', {
      environment_id: 'env-1',
    });
  });

  it('also clears edge + CDN when a cdnCacheId is given', async () => {
    const client = { post: vi.fn(async () => ({})) } as any;
    expect(await clearKinstaCaches(client, 'env-1', 'cdn-1')).toEqual(['page', 'edge', 'CDN']);
  });

  it('treats edge/CDN as best-effort — a failure there never fails the page clear', async () => {
    const client = {
      post: vi.fn(async (url: string) => {
        if (url.includes('edge-caching')) throw { response: { data: { message: 'disabled' } } };
        return {};
      }),
    } as any;
    const cleared = await clearKinstaCaches(client, 'env-1', 'cdn-1');
    expect(cleared).toContain('page');
    expect(cleared).not.toContain('edge'); // failed, skipped
    expect(cleared).toContain('CDN'); // still attempted after edge failed
  });
});

// --- getKinstaClient retry interceptor --------------------------------------

describe('getKinstaClient retry interceptor', () => {
  it('retries transient failures (5xx) with backoff, then succeeds', async () => {
    vi.useFakeTimers();
    const client = getKinstaClient('test-key');
    let calls = 0;
    client.defaults.adapter = async (config) => {
      calls++;
      if (calls < 3) {
        return Promise.reject({ config, response: { status: 503 }, isAxiosError: true });
      }
      return { data: { ok: true }, status: 200, statusText: 'OK', headers: {}, config };
    };
    const p = client.get('/x');
    await vi.runAllTimersAsync();
    const res = await p;
    expect(res.data).toEqual({ ok: true });
    expect(calls).toBe(3); // original + 2 retries
  });

  it('does not retry a non-transient 4xx error', async () => {
    const client = getKinstaClient('test-key');
    let calls = 0;
    client.defaults.adapter = async (config) => {
      calls++;
      return Promise.reject({ config, response: { status: 400 }, isAxiosError: true });
    };
    await expect(client.get('/x')).rejects.toMatchObject({ response: { status: 400 } });
    expect(calls).toBe(1); // no retry
  });
});
