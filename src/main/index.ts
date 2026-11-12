// Type-only imports — keeps this module importable outside Electron (tests)
import type { AddonMainContext } from '@getflywheel/local/main';
import * as path from 'path';
import * as fs from 'fs';
import { randomBytes } from 'crypto';
import { spawn } from 'child_process';
import type { IpcMainInvokeEvent } from 'electron';

import { EXCLUDE_PATTERNS } from './constants';
import {
  ServerEnvironment,
  SyncProgress,
  SyncOptions,
  SiteInfo,
  CancelledError,
  ActiveSync,
  RunOptions,
  PullPushDeps,
  RemoteConnection,
  PushDiffRow,
} from './types';
import { validateEnvironment } from './validators';
import { resolveRsync, parseItemizeOutput, parseVerboseDryRun, localPublicPath } from './rsync';
import {
  openRemoteConnection,
  closeAllConnections,
  removeControlDir,
  sweepStaleControlDirs,
  listSshConfigHosts,
  rsyncRemoteShell,
  rsyncRemoteRoot,
} from './ssh';
import { executePull, executePush } from './sync';
import {
  CliRequest,
  CliMessage,
  CLI_SOCKET_NAME,
  readLocalSite,
  startCliServer,
  cliLauncherScript,
} from './cliProtocol';
import { initLocalPaths, getMysqlSocketPath, findServiceBinary, findWpCliPhar } from './localPaths';
import {
  initConfig,
  getTempDir,
  getBackupsDir,
  getConfigDir,
  ensureConfigDir,
  getProfile,
  loadProfiles,
  findEnvironment,
  canStorePasswords,
  savePassword,
  getPassword,
  hasPassword,
  prunePasswords,
  saveEnvironments,
  deleteProfile,
  recordSync,
  cleanupTempFiles,
  saveNeutralizeRecord,
  loadNeutralizeRecord,
} from './config';

// Re-export the public API from the extracted modules so existing imports
// `from './index'` (the test suite) keep resolving.
export * from './types';
export * from './validators';
export * from './rsync';
export * from './ssh';
export * from './sync';
export * from './safeClone';
export * from './localPaths';
export * from './config';
export {
  PRODUCT_NAME,
  DATA_DIR_NAME,
  EXCLUDE_PATTERNS,
  HISTORY_LIMIT,
  MIN_DUMP_BYTES,
  PUSH_BACKUPS_TO_KEEP,
  REMOTE_TEMP_PREFIX,
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
          console.log('[SSH Sync] Renderer bundle changed — reloaded Local windows');
        } catch (e) {
          console.error('[SSH Sync] Renderer reload failed:', e);
        }
      }, 400);
    });
  } catch (e) {
    console.error('[SSH Sync] Could not watch renderer bundle:', e);
  }
}

// `password` overrides the saved one (Test connection on an edited form)
async function connectRemote(
  environment: ServerEnvironment,
  password: string | null = null,
): Promise<RemoteConnection> {
  const effectivePassword =
    environment.auth === 'password' ? password || getPassword(environment.id) : null;
  return openRemoteConnection(environment, runCommand, effectivePassword);
}

// Passwords live only as long as a password environment that uses them
function pruneOrphanPasswords(): void {
  const keep = new Set<string>();
  for (const profile of Object.values(loadProfiles())) {
    for (const environment of profile.environments) {
      if (environment.auth === 'password') keep.add(environment.id);
    }
  }
  prunePasswords(keep);
}

// What the renderer may know about a profile: whether a password is saved,
// never the password itself.
function profileForRenderer(localSiteId: string) {
  const profile = getProfile(localSiteId);
  if (!profile) return null;
  return {
    ...profile,
    environments: profile.environments.map((environment) => ({
      ...environment,
      hasPassword: environment.auth === 'password' && hasPassword(environment.id),
    })),
  };
}

type EnvironmentInput = Partial<ServerEnvironment> & { password?: string };

// Wire the orchestration seams to the real implementations. Called per IPC
// invocation with a `sendProgress` bound to the requesting renderer.
function defaultPullPushDeps(sendProgress: (progress: SyncProgress) => void): PullPushDeps {
  return {
    fs,
    runCommand,
    activeSyncs,
    activePreviews,
    connectRemote,
    getMysqlSocketPath,
    resolveRsync,
    findServiceBinary,
    findWpCliPhar,
    recordSync,
    notify,
    saveNeutralizeRecord,
    loadNeutralizeRecord,
    ensureConfigDir,
    tempDir: getTempDir(),
    backupsDir: getBackupsDir(),
    sendProgress,
  };
}

// Environments arrive from the renderer: keep only known fields, give new ones
// an id, and reject the whole save on the first invalid entry.
export function normalizeEnvironments(
  input: Partial<ServerEnvironment>[],
): { environments: ServerEnvironment[] } | { error: string } {
  const environments: ServerEnvironment[] = [];
  for (const raw of input) {
    const environment: ServerEnvironment = {
      id: raw.id && /^[a-z0-9-]+$/.test(raw.id) ? raw.id : randomBytes(6).toString('hex'),
      label: String(raw.label || '').trim(),
      sshAlias: raw.sshAlias ? String(raw.sshAlias).trim() : undefined,
      sshHost: raw.sshAlias ? undefined : String(raw.sshHost || '').trim(),
      sshUser: raw.sshAlias ? undefined : String(raw.sshUser || '').trim(),
      sshPort: raw.sshAlias ? undefined : String(raw.sshPort || '22').trim(),
      auth: raw.auth === 'password' ? 'password' : 'key',
      remotePath: String(raw.remotePath || '')
        .trim()
        .replace(/(.)\/+$/, '$1'),
      remoteUrl: String(raw.remoteUrl || '')
        .trim()
        .replace(/\/+$/, ''),
      wpCommand: String(raw.wpCommand || 'wp').trim(),
      cacheCommand: raw.cacheCommand ? String(raw.cacheCommand).trim() : undefined,
      extraExcludes: Array.isArray(raw.extraExcludes)
        ? raw.extraExcludes.map((p) => String(p).trim()).filter(Boolean)
        : [],
      isProduction: Boolean(raw.isProduction),
    };
    const error = validateEnvironment(environment);
    if (error) return { error: `${environment.label || 'Environment'}: ${error}` };
    environments.push(environment);
  }
  return { environments };
}

interface PreviewOptions {
  mode?: 'newer' | 'all';
  includeUploads?: boolean;
}

// rsync dry-run diff of what a push would change on the server. Read-only.
async function previewPush(
  localSiteId: string,
  site: SiteInfo,
  environment: ServerEnvironment,
  options: PreviewOptions = {},
): Promise<
  | { success: true; rows: PushDiffRow[]; degraded: boolean; mode: 'newer' | 'all' }
  | { success: false; error: string; mode: 'newer' | 'all' }
> {
  const mode = options.mode || 'newer';
  if (activeSyncs.has(localSiteId)) {
    return { success: false, error: 'A sync is already running for this site', mode };
  }

  const excludeArgs = [...EXCLUDE_PATTERNS, ...environment.extraExcludes].map(
    (p) => `--exclude=${p}`,
  );
  if (!options.includeUploads) {
    excludeArgs.push('--exclude=wp-content/uploads/');
  }

  // One preview at a time per site: kill the previous dry-run if the renderer
  // re-fires (mode/env/uploads toggles) so orphaned SSH sessions don't pile up
  // against the server's connection limit.
  activePreviews.get(localSiteId)?.child?.kill('SIGTERM');
  const preview: ActiveSync = { cancelled: false, child: null };
  activePreviews.set(localSiteId, preview);

  let connection: RemoteConnection | null = null;
  try {
    connection = await connectRemote(environment);
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
      rsyncRemoteShell(connection),
      `${localPublicPath(site)}/`,
      rsyncRemoteRoot(connection),
    );

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
    await connection?.close();
    if (activePreviews.get(localSiteId) === preview) activePreviews.delete(localSiteId);
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// One `ssh-sync` request: the same engine and guards as the UI. Connection
// details always come from the stored profile.
async function handleCliRequest(
  userDataPath: string,
  request: CliRequest,
  send: (message: CliMessage) => void,
  onDisconnect: (callback: () => void) => void,
): Promise<void> {
  const fail = (message: string) => send({ type: 'result', success: false, message });
  const site = readLocalSite(userDataPath, request.site);
  if (!site) return fail(`No Local site called "${request.site}".`);
  const environments = getProfile(site.id)?.environments || [];

  if (request.command === 'envs') {
    if (!environments.length) return fail(`${site.name} has no server environments yet.`);
    for (const e of environments) {
      const target = e.sshAlias || `${e.sshUser}@${e.sshHost}:${e.sshPort || '22'}`;
      send({
        type: 'output',
        text: `${e.label}${e.isProduction ? ' (production)' : ''}  ${target}  ${e.remoteUrl}  [${e.id}]`,
      });
    }
    return send({ type: 'result', success: true });
  }

  const wanted = request.environment.toLowerCase();
  const environment = environments.find(
    (e) => e.id === request.environment || e.label.toLowerCase() === wanted,
  );
  if (!environment) return fail(`${site.name} has no environment "${request.environment}".`);
  const progress = (p: SyncProgress) =>
    send({ type: 'progress', progress: p.progress, message: p.message });

  // Cancel the sync this request started (never one the UI started) when the
  // client goes away. executePull/executePush register their ActiveSync
  // before their first await, so it is in the map right after the call.
  const runCancellable = async <T>(start: () => Promise<T>): Promise<T> => {
    const before = activeSyncs.get(site.id);
    const pending = start();
    const started = activeSyncs.get(site.id);
    if (started && started !== before) {
      onDisconnect(() => {
        started.cancelled = true;
        started.child?.kill('SIGTERM');
      });
    }
    return pending;
  };

  if (request.command === 'test') {
    try {
      const connection = await connectRemote(environment);
      await connection.close();
      return send({
        type: 'result',
        success: true,
        message: `Connected · WordPress at ${connection.remoteRoot}`,
      });
    } catch (e: any) {
      return fail(e.message);
    }
  }

  if (request.command === 'pull') {
    const result = await runCancellable(() =>
      executePull(
        {
          localSiteId: site.id,
          site,
          environment,
          options: {
            includeDatabase: request.includeDatabase,
            includeUploads: request.includeUploads,
            makeSafe: request.makeSafe,
          },
        },
        defaultPullPushDeps(progress),
      ),
    );
    if (!result.success) return fail(result.error || 'Pull failed.');
    if (result.note) send({ type: 'output', text: result.note });
    return send({
      type: 'result',
      success: true,
      message: result.warning ? `Pull complete. ${result.warning}` : 'Pull complete.',
    });
  }

  // push: always from a fresh preview, so only what it lists can change
  progress({ stage: 'preview', progress: 1, message: `Comparing with ${environment.label}...` });
  const preview = await previewPush(site.id, site, environment, {
    mode: request.mode,
    includeUploads: request.includeUploads,
  });
  if (!preview.success) return fail(preview.error);
  const rows = preview.rows.filter((r) => !(r.isDir && r.op !== 'delete'));
  const files = rows.filter((r) => r.op !== 'delete');
  const deletions = rows.filter((r) => r.op === 'delete');
  for (const r of files) {
    send({
      type: 'output',
      text: `${r.op === 'add' ? '+' : '~'} ${r.path}  ${formatBytes(r.sizeBytes)}`,
    });
  }
  for (const r of deletions) {
    send({
      type: 'output',
      text: `- ${r.path}${request.deletions ? '' : '  (kept: add --delete)'}`,
    });
  }
  const summary = `${files.length} to upload, ${deletions.length} only on the server${request.includeDatabase ? ', database' : ''}`;
  if (!request.yes) {
    return send({
      type: 'result',
      success: true,
      message: `Dry run: ${summary}. Add --yes to push.`,
    });
  }
  if (!files.length && !(request.deletions && deletions.length) && !request.includeDatabase) {
    return send({ type: 'result', success: true, message: 'Nothing to push.' });
  }
  const result = await runCancellable(() =>
    executePush(
      {
        localSiteId: site.id,
        site,
        environment,
        options: {
          includeDatabase: request.includeDatabase,
          includeUploads: request.includeUploads,
          mode: request.mode,
          files: files.map((r) => r.path),
          deletions: request.deletions ? deletions.map((r) => r.path) : [],
        },
      },
      defaultPullPushDeps(progress),
    ),
  );
  if (!result.success) return fail(result.error || 'Push failed.');
  return send({
    type: 'result',
    success: true,
    message: result.warning
      ? `Push complete (${summary}). ${result.warning}`
      : `Push complete (${summary}).`,
  });
}

function cliLauncherPath(userDataPath: string): string {
  return path.join(userDataPath, 'bin', 'ssh-sync');
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
  initConfig(userDataPath, electron.safeStorage);

  // Security: Clean up any leftover temp files from previous sessions
  cleanupTempFiles();
  sweepStaleControlDirs();

  // The `ssh-sync` command's endpoint
  ensureConfigDir();
  const cliSocketPath = path.join(getConfigDir(), CLI_SOCKET_NAME);
  const cliServer = startCliServer(cliSocketPath, (request, send, onDisconnect) =>
    handleCliRequest(userDataPath, request, send, onDisconnect),
  );

  // Quitting Local mid-sync must not leave ssh masters running
  try {
    electron.app.on('before-quit', () => {
      cliServer.close();
      void closeAllConnections().finally(removeControlDir);
    });
  } catch (e) {
    console.error('[SSH Sync] Could not register the quit handler:', e);
  }

  // Hot-reload Local's renderer when the compiled renderer bundle changes
  watchRendererBundle(electron);

  // Remove the profile when its site is deleted in Local
  try {
    hooks.addAction('siteDeleted', (siteId: string) => {
      if (deleteProfile(siteId)) {
        pruneOrphanPasswords();
        console.log(`[SSH Sync] Removed profile for deleted site ${siteId}`);
      }
    });
  } catch (e) {
    console.error('[SSH Sync] Could not register siteDeleted action:', e);
  }

  ipcMain.handle('sshsync:getProfile', async (_event: IpcMainInvokeEvent, localSiteId: string) => {
    return profileForRenderer(localSiteId);
  });

  ipcMain.handle('sshsync:canStorePasswords', async () => canStorePasswords());

  ipcMain.handle('sshsync:listSshHosts', async () => listSshConfigHosts());

  ipcMain.handle('sshsync:cliStatus', async () => {
    const launcher = cliLauncherPath(userDataPath);
    return { installed: fs.existsSync(launcher), path: launcher };
  });

  // Writes the `ssh-sync` launcher next to Local's own `localwp`
  ipcMain.handle('sshsync:installCli', async () => {
    const launcher = cliLauncherPath(userDataPath);
    try {
      fs.mkdirSync(path.dirname(launcher), { recursive: true });
      fs.writeFileSync(
        launcher,
        cliLauncherScript(process.execPath, path.join(__dirname, 'cli.js'), cliSocketPath),
        { mode: 0o755 },
      );
      return { success: true, path: launcher };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle(
    'sshsync:saveEnvironments',
    async (_event: IpcMainInvokeEvent, localSiteId: string, input: EnvironmentInput[]) => {
      const inputs = Array.isArray(input) ? input : [];
      const result = normalizeEnvironments(inputs);
      if ('error' in result) return { success: false, error: result.error };
      // normalizeEnvironments keeps the order, so inputs[i] is environments[i].
      // Check every environment before saving any password.
      const typedPasswords = result.environments.map((environment, i) =>
        environment.auth === 'password' && typeof inputs[i].password === 'string'
          ? inputs[i].password!
          : '',
      );
      for (let i = 0; i < result.environments.length; i++) {
        const environment = result.environments[i];
        if (environment.auth !== 'password' || typedPasswords[i]) continue;
        if (!hasPassword(environment.id)) {
          return { success: false, error: `${environment.label}: enter the SSH password.` };
        }
      }
      if (typedPasswords.some(Boolean) && !canStorePasswords()) {
        return {
          success: false,
          error: 'This computer cannot store the password encrypted, so it was not saved.',
        };
      }
      result.environments.forEach((environment, i) => {
        if (typedPasswords[i]) savePassword(environment.id, typedPasswords[i]);
      });
      saveEnvironments(localSiteId, result.environments);
      pruneOrphanPasswords();
      return { success: true, profile: profileForRenderer(localSiteId) };
    },
  );

  ipcMain.handle(
    'sshsync:deleteProfile',
    async (_event: IpcMainInvokeEvent, localSiteId: string) => {
      deleteProfile(localSiteId);
      pruneOrphanPasswords();
      return { success: true };
    },
  );

  // Connect and probe an environment as typed in the form (not yet saved)
  ipcMain.handle(
    'sshsync:testConnection',
    async (_event: IpcMainInvokeEvent, input: EnvironmentInput) => {
      const result = normalizeEnvironments([input]);
      if ('error' in result) return { success: false, error: result.error };
      try {
        const connection = await connectRemote(
          result.environments[0],
          typeof input.password === 'string' ? input.password : null,
        );
        await connection.close();
        return { success: true, remoteRoot: connection.remoteRoot };
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    },
  );

  // Push preview: rsync dry-run diff of what a push would change on the server.
  // Read-only — no files are touched on either side.
  ipcMain.handle(
    'sshsync:pushPreview',
    async (
      _event: IpcMainInvokeEvent,
      localSiteId: string,
      site: SiteInfo,
      environmentId: string,
      options: PreviewOptions = {},
    ) => {
      const environment = findEnvironment(localSiteId, environmentId);
      if (!environment) {
        return { success: false, error: 'Unknown environment.', mode: options.mode || 'newer' };
      }
      return previewPush(localSiteId, site, environment, options);
    },
  );

  // Cancel a running sync for a site
  ipcMain.handle('sshsync:cancelSync', async (_event: IpcMainInvokeEvent, localSiteId: string) => {
    const sync = activeSyncs.get(localSiteId);
    if (sync) {
      sync.cancelled = true;
      sync.child?.kill('SIGTERM');
    }
    return { success: true };
  });

  // The renderer names the environment; its connection details always come
  // from the stored profile, never from the renderer.
  const syncHandler =
    (mode: 'pull' | 'push') =>
    async (
      event: IpcMainInvokeEvent,
      localSiteId: string,
      site: SiteInfo,
      environmentId: string,
      options: SyncOptions,
    ) => {
      const environment = findEnvironment(localSiteId, environmentId);
      if (!environment) return { success: false, error: 'Unknown environment.' };
      // siteId + mode let listeners (status badge, drawer) filter events
      const sendProgress = (progress: SyncProgress) => {
        event.sender.send('sshsync:syncProgress', { ...progress, siteId: localSiteId, mode });
      };
      const execute = mode === 'pull' ? executePull : executePush;
      return execute(
        { localSiteId, site, environment, options: options || {} },
        defaultPullPushDeps(sendProgress),
      );
    };

  ipcMain.handle('sshsync:pull', syncHandler('pull'));
  ipcMain.handle('sshsync:push', syncHandler('push'));
}
