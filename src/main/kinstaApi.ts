import axios, { AxiosInstance } from 'axios';

import { KINSTA_API_BASE, KINSTA_BACKUP_TAG, MANUAL_BACKUP_LIMIT } from './constants';
import { CancelledError, ActiveSync } from './types';
import { isTransientApiError } from './validators';

export function getKinstaClient(apiKey: string): AxiosInstance {
  const client = axios.create({
    baseURL: KINSTA_API_BASE,
    // Without a timeout a hung request freezes the whole sync indefinitely.
    timeout: 30000,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  });
  // Retry transient failures (network drop, timeout, 5xx, 429) with linear backoff.
  client.interceptors.response.use(undefined, async (error: any) => {
    const cfg = error?.config;
    if (!cfg) throw error;
    cfg.__retryCount = (cfg.__retryCount || 0) + 1;
    if (cfg.__retryCount <= 2 && isTransientApiError(error)) {
      await new Promise((resolve) => setTimeout(resolve, 500 * cfg.__retryCount));
      return client(cfg);
    }
    throw error;
  });
  return client;
}

// Poll GET /operations/{id} until it reports 200 (done) — 202 means in progress
export async function waitForKinstaOperation(
  client: AxiosInstance,
  operationId: string,
  sync: ActiveSync,
  timeoutMs = 10 * 60_000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (sync.cancelled) throw new CancelledError();
    await new Promise((resolve) => setTimeout(resolve, 3000));
    try {
      const res = await client.get(`/operations/${operationId}`);
      if ((res.data?.status ?? res.status) === 200) return;
      // 202 in body → keep polling
    } catch (e: any) {
      const httpStatus = e.response?.status;
      if (httpStatus === 500) {
        throw new Error(`Kinsta operation failed: ${e.response?.data?.message || 'unknown error'}`);
      }
      // 404 can appear briefly right after creation — keep polling
      if (!httpStatus) throw e;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for Kinsta backup operation');
    }
  }
}

// Create a native Kinsta backup (files + DB). Frees a slot by deleting the
// oldest backup WE created if all manual slots are taken — never touches the
// user's own backups. Returns false if no slot could be freed.
export async function createKinstaBackup(
  client: AxiosInstance,
  envId: string,
  sync: ActiveSync,
  onMessage: (msg: string) => void,
): Promise<boolean> {
  const list = await client.get(`/sites/environments/${envId}/backups`);
  const backups: Array<{
    id: number;
    name?: string;
    note?: string | null;
    type: string;
    created_at: number;
  }> = list.data?.environment?.backups || [];
  const manual = backups.filter((b) => b.type === 'manual');

  if (manual.length >= MANUAL_BACKUP_LIMIT) {
    const ours = manual
      .filter(
        (b) => (b.note || '').includes('kinsta-sync') || (b.name || '').includes('kinsta-sync'),
      )
      .sort((a, b) => a.created_at - b.created_at);
    if (!ours.length) {
      // All slots hold the user's own backups — do not delete those
      return false;
    }
    onMessage('Freeing a Kinsta backup slot (removing our oldest)...');
    const del = await client.delete(`/sites/environments/backups/${ours[0].id}`);
    if (!del.data?.operation_id)
      throw new Error('Kinsta did not return an operation id for the backup deletion');
    await waitForKinstaOperation(client, del.data.operation_id, sync);
  }

  onMessage('Creating Kinsta backup (files + database)...');
  const created = await client.post(`/sites/environments/${envId}/manual-backups`, {
    tag: KINSTA_BACKUP_TAG,
  });
  if (!created.data?.operation_id)
    throw new Error('Kinsta did not return an operation id for the backup');
  await waitForKinstaOperation(client, created.data.operation_id, sync);
  return true;
}

// Kinsta API client
// Kinsta has three separately cleared caches (object cache/Redis has no API):
//   page  — POST /sites/tools/clear-cache   (the only one we cleared before)
//   edge  — POST /sites/edge-caching/clear
//   CDN   — POST /sites/cdn/clear-cache     (needs the env's cdn_cache_id)
// Page cache is required and propagates failure; edge/CDN are best-effort
// since they can be disabled per environment.
export async function clearKinstaCaches(
  client: AxiosInstance,
  envId: string,
  cdnCacheId?: string,
): Promise<string[]> {
  const cleared: string[] = [];
  await client.post('/sites/tools/clear-cache', { environment_id: envId });
  cleared.push('page');
  try {
    await client.post('/sites/edge-caching/clear', { environment_id: envId });
    cleared.push('edge');
  } catch (e: any) {
    console.log('[Kinsta] Edge cache clear skipped:', e.response?.data?.message || e.message);
  }
  if (cdnCacheId) {
    try {
      await client.post('/sites/cdn/clear-cache', {
        environment_id: envId,
        cdn_cache_id: cdnCacheId,
      });
      cleared.push('CDN');
    } catch (e: any) {
      console.log('[Kinsta] CDN cache clear skipped:', e.response?.data?.message || e.message);
    }
  }
  return cleared;
}
