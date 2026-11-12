// Type-only imports — keeps this module importable outside Electron (tests)
import type { AddonMainContext } from '@getflywheel/local/main';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import type { IpcMainInvokeEvent } from 'electron';

import { EXCLUDE_PATTERNS } from './constants';
import {
  SiteLink,
  EnvironmentInfo,
  SyncProgress,
  SyncOptions,
  SiteInfo,
  CancelledError,
  ActiveSync,
  RunOptions,
  PullPushDeps,
} from './types';
import { validateEnvironmentInfo } from './validators';
import { resolveRsync, parseItemizeOutput, parseVerboseDryRun, rsyncSshContext } from './rsync';
import { getKinstaClient, createKinstaBackup, clearKinstaCaches } from './kinstaApi';
import { executePull, executePush } from './sync';
import { initLocalPaths, getMysqlSocketPath, findServiceBinary, findWpCliPhar } from './localPaths';
import {
  initConfig,
  getTempDir,
  migrateLegacyConfig,
  ensureConfigDir,
  loadConfig,
  saveConfig,
  getApiKey,
  saveApiKey,
  deleteApiKey,
  loadSiteLinks,
  saveSiteLinks,
  recordSync,
  cleanupTempFiles,
} from './config';

// Re-export the public API from the extracted modules so existing imports
// `from './index'` (the test suite, the renderer IPC types) keep resolving.
export * from './types';
export * from './validators';
export * from './rsync';
export * from './kinstaApi';
export * from './sync';
export * from './localPaths';
export * from './config';
export {
  KINSTA_API_BASE,
  LEGACY_CONFIG_DIR,
  EXCLUDE_PATTERNS,
  HISTORY_LIMIT,
  MIN_DUMP_BYTES,
  KINSTA_BACKUP_TAG,
  MANUAL_BACKUP_LIMIT,
  REMOTE_PUSH_BACKUP,
} from './constants';

// Set from context in the exported entry point
let notifier: AddonMainContext['notifier'] | null = null;

// ---------------------------------------------------------------------------
// Async command runner with cancellation support
// ---------------------------------------------------------------------------

// One active sync per Local site
const activeSyncs = new Map<string, ActiveSync>();
// In-flight push-preview dry-runs (kept separate: previews never block syncs,
// but a re-fired preview kills its predecessor)
const activePreviews = new Map<string, ActiveSync>();

// Spawn without a shell (no injection surface), collect stderr for real error
// messages, and register the child so the sync can be cancelled.
function runCommand(
  sync: ActiveSync,
  cmd: string,
  args: string[],
  opts: RunOptions = {},
): Promise<{ code: number; stderr: string }> {
  if (sync.cancelled) return Promise.reject(new CancelledError());

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: opts.env || process.env,
      stdio: [opts.stdinFile ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    sync.child = child;

    let stderrTail = '';
    let settled = false;

    if (opts.stdinFile) {
      const input = fs.createReadStream(opts.stdinFile);
      input.on('error', (err) => {
        if (!settled) {
          settled = true;
          child.kill();
          reject(err);
        }
      });
      input.pipe(child.stdin!);
    }

    let output: fs.WriteStream | null = null;
    if (opts.stdoutFile) {
      output = fs.createWriteStream(opts.stdoutFile);
      output.on('error', (err) => {
        if (!settled) {
          settled = true;
          child.kill();
          reject(err);
        }
      });
      child.stdout!.pipe(output);
    } else {
      child.stdout!.on('data', (d: Buffer) => {
        opts.onStdout?.(d.toString());
      });
    }

    child.stderr!.on('data', (d: Buffer) => {
      stderrTail = (stderrTail + d.toString()).slice(-4000);
    });

    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    child.on('close', (code) => {
      sync.child = null;
      output?.end();
      if (settled) return;
      settled = true;
      if (sync.cancelled) {
        reject(new CancelledError());
      } else if (code === 0 || (code !== null && opts.okCodes?.includes(code))) {
        resolve({ code: code ?? 0, stderr: stderrTail });
      } else {
        const detail = stderrTail.trim().split('\n').slice(-5).join('\n');
        reject(
          new Error(
            `${path.basename(cmd)} exited with code ${code}${detail ? `:\n${detail}` : ''}`,
          ),
        );
      }
    });
  });
}

// Fail-fast pre-flight: confirm SSH + remote WP-CLI + the public dir are reachable
// BEFORE any destructive step. Without it a bad key / unreachable host only surfaces
// mid-sync as a cryptic rsync/ssh failure (after backups have already run). Returns
// null on success or a user-facing error message. ConnectTimeout bounds a dead host.
async function preflightRemote(envInfo: EnvironmentInfo): Promise<string | null> {
  const probe: ActiveSync = { cancelled: false, child: null };
  try {
    await runCommand(probe, 'ssh', [
      '-p',
      envInfo.sshPort,
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-o',
      'ConnectTimeout=15',
      `${envInfo.sshUser}@${envInfo.sshHost}`,
      'cd ~/public && wp --version',
    ]);
    return null;
  } catch (e: any) {
    return `Could not reach Kinsta over SSH (or WP-CLI failed on the server). Check that your SSH key is added in MyKinsta and the environment has SSH access enabled. Details: ${e.message}`;
  }
}

function notify(title: string, message: string): void {
  try {
    notifier?.notify({ title, message });
  } catch {
    // Notifications are best-effort
  }
}

// Dev convenience: Local only loads add-on bundles at app start, so watch the
// compiled renderer bundle and reload Local's windows when webpack rewrites it.
// Renderer changes hot-reload this way; main-process changes still need a full
// app restart (Electron cannot swap the main process at runtime).
function watchRendererBundle(electron: AddonMainContext['electron']): void {
  // __dirname is lib/main at runtime
  const rendererDir = path.resolve(__dirname, '..', 'renderer');
  if (!fs.existsSync(rendererDir)) return;

  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    // Watch the directory (not the file) — webpack replaces the file inode
    fs.watch(rendererDir, (_event, filename) => {
      if (filename !== 'index.js') return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          for (const win of electron.BrowserWindow.getAllWindows()) {
            win.webContents.reloadIgnoringCache();
          }
          console.log('[Kinsta] Renderer bundle changed — reloaded Local windows');
        } catch (e) {
          console.error('[Kinsta] Renderer reload failed:', e);
        }
      }, 400);
    });
  } catch (e) {
    console.error('[Kinsta] Could not watch renderer bundle:', e);
  }
}

// Wire the orchestration seams to the real implementations. Called per IPC
// invocation with a `sendProgress` bound to the requesting renderer.
function defaultPullPushDeps(sendProgress: (progress: SyncProgress) => void): PullPushDeps {
  return {
    fs,
    runCommand,
    activeSyncs,
    activePreviews,
    loadSiteLinks,
    validateEnvironmentInfo,
    getMysqlSocketPath,
    preflightRemote,
    resolveRsync,
    findServiceBinary,
    findWpCliPhar,
    getApiKey,
    getKinstaClient,
    createKinstaBackup,
    clearKinstaCaches,
    recordSync,
    notify,
    ensureConfigDir,
    tempDir: getTempDir(),
    sendProgress,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export default function (context: AddonMainContext): void {
  const { electron, hooks } = context;
  const { ipcMain } = electron;

  // Initialize from the Context API
  notifier = context.notifier;
  const userDataPath = String(context.environment.userDataPath || '');
  const appPath = String(context.environment.appPath || '');
  initLocalPaths(userDataPath, appPath);
  // initConfig sets safeStorage then resolves the config paths (preserving the
  // original order: paths/safeStorage set before resolveConfigPaths/migrate).
  initConfig(userDataPath, electron.safeStorage);
  migrateLegacyConfig();

  // Security: Clean up any leftover temp files from previous sessions
  cleanupTempFiles();

  // Hot-reload Local's renderer when the compiled renderer bundle changes
  watchRendererBundle(electron);

  // Clean up stale links when a site is deleted in Local
  try {
    hooks.addAction('siteDeleted', (siteId: string) => {
      const links = loadSiteLinks();
      if (links[siteId]) {
        delete links[siteId];
        saveSiteLinks(links);
        console.log(`[Kinsta] Removed link for deleted site ${siteId}`);
      }
    });
  } catch (e) {
    console.error('[Kinsta] Could not register siteDeleted action:', e);
  }

  // Test API connection
  ipcMain.handle(
    'kinsta:testConnection',
    async (_event: IpcMainInvokeEvent, apiKey: string, companyId: string) => {
      try {
        const client = getKinstaClient(apiKey);
        const response = await client.get(`/sites?company=${companyId}`);

        if (response.data.company) {
          // Save credentials securely
          const saved = saveApiKey(apiKey);
          if (!saved) {
            return {
              success: false,
              error: 'Could not save API key securely. Encryption not available.',
            };
          }
          // Note: the /sites response's `company` object only contains `sites` —
          // the Kinsta API has no endpoint that exposes the company name.
          saveConfig({ companyId });
          return { success: true, company: response.data.company };
        }
        return { success: false, error: 'Invalid response from Kinsta API' };
      } catch (error: any) {
        return { success: false, error: error.message || 'Connection failed' };
      }
    },
  );

  // Get stored config (returns masked apiKey if exists)
  ipcMain.handle('kinsta:getConfig', async () => {
    const config = loadConfig();
    const hasApiKey = getApiKey() !== null;
    return { ...config, apiKey: hasApiKey ? '••••••••' : undefined };
  });

  // Get Kinsta sites
  ipcMain.handle('kinsta:getSites', async () => {
    const config = loadConfig();
    const apiKey = getApiKey();
    if (!apiKey || !config.companyId) {
      return { success: false, error: 'Not connected to Kinsta' };
    }

    try {
      const client = getKinstaClient(apiKey);
      const response = await client.get(`/sites?company=${config.companyId}`);
      return { success: true, sites: response.data.company?.sites || [] };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  // Get environments for a site
  ipcMain.handle('kinsta:getEnvironments', async (_event: IpcMainInvokeEvent, siteId: string) => {
    const apiKey = getApiKey();
    if (!apiKey) {
      return { success: false, error: 'Not connected' };
    }

    try {
      const client = getKinstaClient(apiKey);
      const response = await client.get(`/sites/${siteId}/environments`);
      return { success: true, environments: response.data.site?.environments || [] };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  // Link Local site to Kinsta (only stores site info, not environment)
  ipcMain.handle(
    'kinsta:linkSite',
    async (_event: IpcMainInvokeEvent, localSiteId: string, kinstaSite: any) => {
      const links = loadSiteLinks();

      const link: SiteLink = {
        localSiteId,
        kinstaSiteId: kinstaSite.id,
        kinstaSiteName: kinstaSite.display_name || kinstaSite.name,
        kinstaSiteSlug: kinstaSite.name, // The actual site name used for SSH
      };

      links[localSiteId] = link;
      saveSiteLinks(links);

      return { success: true, link };
    },
  );

  // Get link for a Local site
  ipcMain.handle('kinsta:getSiteLink', async (_event: IpcMainInvokeEvent, localSiteId: string) => {
    const links = loadSiteLinks();
    return links[localSiteId] || null;
  });

  // Unlink site
  ipcMain.handle('kinsta:unlinkSite', async (_event: IpcMainInvokeEvent, localSiteId: string) => {
    const links = loadSiteLinks();
    delete links[localSiteId];
    saveSiteLinks(links);
    return { success: true };
  });

  // Clear all Kinsta caches for an environment (also used standalone from the page)
  ipcMain.handle(
    'kinsta:clearCache',
    async (_event: IpcMainInvokeEvent, envId: string, cdnCacheId?: string) => {
      const apiKey = getApiKey();
      if (!apiKey) {
        return { success: false, error: 'Not connected' };
      }
      try {
        const client = getKinstaClient(apiKey);
        const cleared = await clearKinstaCaches(client, envId, cdnCacheId);
        return { success: true, cleared };
      } catch (error: any) {
        return { success: false, error: error.response?.data?.message || error.message };
      }
    },
  );

  // Push preview: rsync dry-run diff of what a push would change on Kinsta.
  // Read-only — no files are touched on either side.
  ipcMain.handle(
    'kinsta:pushPreview',
    async (
      _event: IpcMainInvokeEvent,
      localSiteId: string,
      site: SiteInfo,
      envInfo: EnvironmentInfo,
      options: { mode?: 'newer' | 'all'; includeUploads?: boolean } = {},
    ) => {
      const mode = options.mode || 'newer';
      if (activeSyncs.has(localSiteId)) {
        return { success: false, error: 'A sync is already running for this site', mode };
      }
      if (!validateEnvironmentInfo(envInfo)) {
        return { success: false, error: 'Invalid environment configuration.', mode };
      }

      const { localPublicPath, sshCommandForRsync, remoteHost } = rsyncSshContext(site, envInfo);

      const excludeArgs = EXCLUDE_PATTERNS.map((p) => `--exclude=${p}`);
      if (!options.includeUploads) {
        excludeArgs.push('--exclude=wp-content/uploads/');
      }

      const rsync = resolveRsync();
      const degraded = !(rsync.supportsItemizeChanges && rsync.supportsOutFormat);

      // %M carries the local file's mtime so we never stat thousands of files
      // in the main process (which would block Local's entire UI)
      const args = ['-az', '--delete', '-n'];
      if (mode === 'newer') args.push('--update');
      args.push(...(degraded ? ['-v'] : ['--itemize-changes', '--out-format=%i|%l|%M|%n']));
      args.push(
        ...excludeArgs,
        '-e',
        sshCommandForRsync,
        `${localPublicPath}/`,
        `${remoteHost}:~/public/`,
      );

      // One preview at a time per site: kill the previous dry-run if the
      // renderer re-fires (mode/env/uploads toggles) so orphaned SSH sessions
      // don't pile up against Kinsta's connection limit.
      activePreviews.get(localSiteId)?.child?.kill('SIGTERM');
      const preview: ActiveSync = { cancelled: false, child: null };
      activePreviews.set(localSiteId, preview);

      try {
        const chunks: string[] = [];
        await runCommand(preview, rsync.bin, args, {
          okCodes: [23, 24],
          onStdout: (chunk) => {
            chunks.push(chunk);
          },
        });
        const stdout = chunks.join('');

        const rows = degraded ? parseVerboseDryRun(stdout) : parseItemizeOutput(stdout);
        return { success: true, rows, degraded, mode };
      } catch (error: any) {
        return { success: false, error: error.message, mode };
      } finally {
        if (activePreviews.get(localSiteId) === preview) activePreviews.delete(localSiteId);
      }
    },
  );

  // Cancel a running sync for a site
  ipcMain.handle('kinsta:cancelSync', async (_event: IpcMainInvokeEvent, localSiteId: string) => {
    const sync = activeSyncs.get(localSiteId);
    if (sync) {
      sync.cancelled = true;
      sync.child?.kill('SIGTERM');
    }
    return { success: true };
  });

  // Pull from Kinsta
  ipcMain.handle(
    'kinsta:pull',
    async (
      event: IpcMainInvokeEvent,
      localSiteId: string,
      site: SiteInfo,
      envInfo: EnvironmentInfo,
      options: SyncOptions,
    ) => {
      // siteId + mode let listeners (status badge, drawer) filter events
      const sendProgress = (progress: SyncProgress) => {
        event.sender.send('kinsta:syncProgress', {
          ...progress,
          siteId: localSiteId,
          mode: 'pull',
        });
      };
      return executePull(
        { localSiteId, site, envInfo, options },
        defaultPullPushDeps(sendProgress),
      );
    },
  );

  // Push to Kinsta
  ipcMain.handle(
    'kinsta:push',
    async (
      event: IpcMainInvokeEvent,
      localSiteId: string,
      site: SiteInfo,
      envInfo: EnvironmentInfo,
      options: SyncOptions,
    ) => {
      // siteId + mode let listeners (status badge, drawer) filter events
      const sendProgress = (progress: SyncProgress) => {
        event.sender.send('kinsta:syncProgress', {
          ...progress,
          siteId: localSiteId,
          mode: 'push',
        });
      };
      return executePush(
        { localSiteId, site, envInfo, options },
        defaultPullPushDeps(sendProgress),
      );
    },
  );

  // Disconnect from Kinsta
  ipcMain.handle('kinsta:disconnect', async () => {
    deleteApiKey();
    saveConfig({});
    return { success: true };
  });
}
