import * as os from 'os';
import * as path from 'path';

import { EXCLUDE_PATTERNS, PRODUCT_NAME } from './constants';
import {
  CancelledError,
  ActiveSync,
  RemoteConnection,
  ServerEnvironment,
  SyncParams,
  SyncResult,
  PullPushDeps,
} from './types';
import {
  getDbCredentials,
  isLikelyValidSqlDump,
  isValidDomain,
  searchReplacePairs,
  parseTablePrefix,
  setTablePrefix,
  normalizeTablePrefix,
  downgradeMySQL8Collations,
  downgradeMariaDBCollations,
  validateEnvironment,
  remoteDomainFromUrl,
} from './validators';
import {
  describePartialTransfer,
  rsyncProgressArgs,
  makeRsyncProgressParser,
  buildPushRsyncArgs,
  localPublicPath,
} from './rsync';
import {
  sshArgs,
  scpArgs,
  shellQuote,
  remoteFileSpec,
  rsyncRemoteShell,
  rsyncRemoteRoot,
  inRemoteRoot,
  remoteWp,
  parseRemoteTempPath,
  REMOTE_MKTEMP,
} from './ssh';
import { prunePushBackups } from './config';
import {
  PushManifest,
  OUT_FORMAT_MARKER,
  pushStamp,
  remoteFilesBackupDir,
  parseAddedFromOutFormat,
  PushedChanges,
  isSafeListedPath,
  outermostPaths,
  moveListedToBackupCommand,
  removeListedFilesCommand,
  removeListedEmptyDirsCommand,
  changedSinceCommand,
  changedSinceLines,
  parseChangedSince,
  refreshLockCommand,
  newLockToken,
  lastPushMarker,
  lockDir,
  acquireLockCommand,
  parseLockOutput,
  releaseLockCommand,
  lockOwner,
} from './pushBackup';
import {
  SAFETY_MU_PLUGIN_PATH,
  SAFETY_MU_PLUGIN_SOURCE,
  NEUTRALIZE_SCRIPT,
  UNSAFE_PLUGIN_FOLDERS,
  NeutralizeRecord,
  NeutralizeResult,
  parseNeutralizeOutput,
  ensureLocalCopyConfig,
  describeSafeClone,
  isEmptyRecord,
  restoreNeutralizedScript,
} from './safeClone';

// ---------------------------------------------------------------------------
// Pull / push orchestration (extracted from the IPC handlers so it can be
// integration-tested with injected seams — no real processes, network, or
// Local installation lookups). The handlers are thin wrappers around these.
// ---------------------------------------------------------------------------

type Run = PullPushDeps['runCommand'];

// A server folder whose WordPress reports another site is refused unless the
// user typed that site's URL back (e.g. a staging just cloned from production
// still says production).
function siteUrlRefusal(
  connection: RemoteConnection,
  environment: ServerEnvironment,
  acceptSiteUrl: string | undefined,
): SyncResult | null {
  if (!connection.siteUrlMismatch) return null;
  // With no readable URL, the folder itself is what the user confirms
  const confirmValue = connection.siteUrl || connection.remoteRoot;
  if (acceptSiteUrl && acceptSiteUrl === confirmValue) return null;
  return {
    success: false,
    error: `${connection.siteUrlMismatch} If that is right, type ${confirmValue} to continue.`,
    siteUrlMismatch: { actual: confirmValue, expected: environment.remoteUrl },
  };
}

// Cleanup must run even after a cancel, and the cancelled sync rejects every command
const freshSync = (): ActiveSync => ({ cancelled: false, child: null });

function excludeArgsFor(environment: ServerEnvironment, includeUploads?: boolean): string[] {
  const patterns = [...EXCLUDE_PATTERNS, ...(environment.extraExcludes || [])];
  if (!includeUploads) patterns.push('wp-content/uploads/');
  return patterns.map((p) => `--exclude=${p}`);
}

async function removeRemoteFile(
  run: Run,
  connection: RemoteConnection,
  remoteFile: string,
): Promise<void> {
  try {
    await run(freshSync(), 'ssh', sshArgs(connection, `rm -f -- ${shellQuote(remoteFile)}`));
  } catch (e: any) {
    console.warn(`[SSH Sync] Could not remove ${remoteFile} on the server:`, e?.message);
  }
}

// A private temp file on the server, created on its own so its path is known
// before anything is written to it: whatever happens next, it can be removed.
async function createRemoteTempFile(
  run: Run,
  sync: ActiveSync,
  connection: RemoteConnection,
): Promise<string> {
  let mktempOutput = '';
  await run(sync, 'ssh', sshArgs(connection, REMOTE_MKTEMP), {
    onStdout: (chunk) => (mktempOutput += chunk),
  });
  const remoteFile = parseRemoteTempPath(mktempOutput);
  if (!remoteFile) {
    throw new Error('Could not create a temporary file on the server.');
  }
  return remoteFile;
}

// Export the remote database and download it to `localFile`. The remote copy
// is always removed, whether or not the export or the download worked.
async function downloadRemoteDatabase(
  run: Run,
  sync: ActiveSync,
  connection: RemoteConnection,
  environment: ServerEnvironment,
  localFile: string,
): Promise<void> {
  const remoteFile = await createRemoteTempFile(run, sync, connection);
  try {
    await run(
      sync,
      'ssh',
      sshArgs(
        connection,
        remoteWp(
          connection,
          environment,
          `--skip-plugins --skip-themes db export ${shellQuote(remoteFile)}`,
        ),
      ),
    );
    await run(sync, 'scp', scpArgs(connection, remoteFileSpec(connection, remoteFile), localFile));
  } finally {
    await removeRemoteFile(run, connection, remoteFile);
  }
}

// Upload a local dump to a fresh private temp file on the server, import it,
// and remove it again. `onImportStart` fires right before the server database
// starts changing. The import itself cannot be cancelled: killing the local ssh
// client would leave `wp db import` running on the server, racing any restore.
async function importDatabaseOnServer(
  run: Run,
  sync: ActiveSync,
  connection: RemoteConnection,
  environment: ServerEnvironment,
  localFile: string,
  onImportStart: () => void = () => {},
): Promise<void> {
  const remoteFile = await createRemoteTempFile(run, sync, connection);
  try {
    await run(sync, 'scp', scpArgs(connection, localFile, remoteFileSpec(connection, remoteFile)));
    onImportStart();
    await run(
      freshSync(),
      'ssh',
      sshArgs(connection, remoteWp(connection, environment, `db import ${shellQuote(remoteFile)}`)),
    );
  } finally {
    await removeRemoteFile(run, connection, remoteFile);
  }
}

// Step 1 of a safe copy (see safeClone.ts), before anything is transferred:
// the safety mu-plugin and the wp-config constants that switch it on.
function installSafetyNet(deps: PullPushDeps, publicPath: string): void {
  const dfs = deps.fs;
  const muPluginFile = path.join(publicPath, ...SAFETY_MU_PLUGIN_PATH.split('/'));
  dfs.mkdirSync(path.dirname(muPluginFile), { recursive: true });
  dfs.writeFileSync(muPluginFile, SAFETY_MU_PLUGIN_SOURCE);
  const wpConfigPath = path.join(publicPath, 'wp-config.php');
  dfs.writeFileSync(wpConfigPath, ensureLocalCopyConfig(dfs.readFileSync(wpConfigPath, 'utf8')));
}

// Step 2, right after the database import and before WordPress loads: the
// unsafe plugins deactivated and Stripe switched to test mode, with Local's PHP.
async function neutralizeDatabase(
  deps: PullPushDeps,
  sync: ActiveSync,
  publicPath: string,
  database: {
    phpBin: string;
    socketPath: string;
    db: { user: string; password: string; database: string };
  },
): Promise<NeutralizeResult> {
  const dfs = deps.fs;
  // The prefix the site reads now, after any prefix adoption
  const prefix = normalizeTablePrefix(
    parseTablePrefix(dfs.readFileSync(path.join(publicPath, 'wp-config.php'), 'utf8')) || '',
  );
  if (!prefix) throw new Error('Could not read the table prefix to make the local copy safe.');

  const scriptPath = path.join(deps.tempDir, 'ssh-sync-neutralize.php');
  dfs.writeFileSync(scriptPath, NEUTRALIZE_SCRIPT);
  let output = '';
  try {
    await deps.runCommand(
      sync,
      database.phpBin,
      [
        scriptPath,
        database.socketPath,
        database.db.user,
        database.db.password,
        database.db.database,
        prefix,
        JSON.stringify(UNSAFE_PLUGIN_FOLDERS),
      ],
      { onStdout: (chunk) => (output += chunk) },
    );
  } finally {
    try {
      dfs.unlinkSync(scriptPath);
    } catch {}
  }
  const result = parseNeutralizeOutput(output);
  if (!result) throw new Error('Could not make the local copy safe: unexpected output.');
  return result;
}

// Bring the server's backup folder of this push to this machine, then remove
// it there. Returns the local folder, or null when the push replaced nothing.
async function downloadFilesBackup(
  deps: PullPushDeps,
  sync: ActiveSync,
  connection: RemoteConnection,
  remoteDir: string,
  localDir: string,
): Promise<string | null> {
  let exists = '';
  await deps.runCommand(
    sync,
    'ssh',
    sshArgs(connection, `[ -d ${shellQuote(remoteDir)} ] && echo yes || true`),
    {
      onStdout: (c) => (exists += c),
    },
  );
  if (!exists.includes('yes')) return null;
  const rsync = deps.resolveRsync();
  await deps.runCommand(sync, rsync.bin, [
    '-a',
    '-e',
    rsyncRemoteShell(connection),
    `${connection.target}:${remoteDir}/`,
    `${localDir}/`,
  ]);
  await deps.runCommand(
    freshSync(),
    'ssh',
    sshArgs(connection, `rm -rf -- ${shellQuote(remoteDir)}`),
  );
  return localDir;
}

function writePushManifest(deps: PullPushDeps, backupBase: string, manifest: PushManifest): void {
  deps.fs.writeFileSync(`${backupBase}.json`, JSON.stringify(manifest, null, 2));
}

// Run a remote loop over a list of paths sent on stdin, one per line: no path
// ever enters a shell string, whatever characters it holds.
async function runWithPathList(
  deps: PullPushDeps,
  sync: ActiveSync,
  connection: RemoteConnection,
  command: string,
  lines: string[],
): Promise<string> {
  if (!lines.length) return '';
  const listFile = path.join(deps.tempDir, `ssh-sync-list-${pushStamp()}-${lines.length}.txt`);
  deps.fs.writeFileSync(listFile, `${lines.join('\n')}\n`);
  let output = '';
  try {
    await deps.runCommand(sync, 'ssh', sshArgs(connection, inRemoteRoot(connection, command)), {
      stdinFile: listFile,
      onStdout: (chunk) => (output += chunk),
    });
  } finally {
    try {
      deps.fs.unlinkSync(listFile);
    } catch {}
  }
  return output;
}

// Put a push's files back: replaced and deleted files from the backup (on
// this machine, or still on the server when the push failed mid-way), and
// the files and empty folders it added removed.
async function restorePushedFiles(
  deps: PullPushDeps,
  sync: ActiveSync,
  connection: RemoteConnection,
  backup: {
    localFilesBackup: string | null;
    remoteFilesBackup: string | null;
    added: { files: string[]; dirs: string[] } | null;
  },
): Promise<void> {
  const run = deps.runCommand;
  if (backup.localFilesBackup && deps.fs.existsSync(backup.localFilesBackup)) {
    const rsync = deps.resolveRsync();
    await run(sync, rsync.bin, [
      '-a',
      '-e',
      rsyncRemoteShell(connection),
      `${backup.localFilesBackup}/`,
      rsyncRemoteRoot(connection),
    ]);
  } else if (backup.remoteFilesBackup) {
    const q = shellQuote(backup.remoteFilesBackup);
    await run(
      sync,
      'ssh',
      sshArgs(
        connection,
        inRemoteRoot(connection, `if [ -d ${q} ]; then cp -a ${q}/. . && rm -rf -- ${q}; fi`),
      ),
    );
  }
  if (backup.added) {
    await runWithPathList(
      deps,
      sync,
      connection,
      removeListedFilesCommand(),
      backup.added.files.filter(isSafeListedPath),
    );
    await runWithPathList(
      deps,
      sync,
      connection,
      removeListedEmptyDirsCommand(),
      [...backup.added.dirs]
        .filter(isSafeListedPath)
        .sort((x, y) => y.split('/').length - x.split('/').length),
    );
  }
}

// Plugins still installed locally keep their place in the record; the rest
// were deleted on purpose and must not come back on the server.
function keepInstalledPlugins(
  record: NeutralizeRecord,
  publicPath: string,
  dfs: PullPushDeps['fs'],
): { record: NeutralizeRecord; skipped: string[] } {
  const pluginsDir = path.join(publicPath, 'wp-content', 'plugins');
  const installed = (plugin: string) => dfs.existsSync(path.join(pluginsDir, plugin.split('/')[0]));
  const skipped = new Set<string>();
  const options: NeutralizeRecord['options'] = {};
  for (const [suffix, entry] of Object.entries(record.options)) {
    const deactivated = entry.deactivated.filter((plugin) => {
      if (installed(plugin)) return true;
      skipped.add(plugin.split('/')[0]);
      return false;
    });
    if (deactivated.length || entry.stripeTestmode !== null) {
      options[suffix] = { deactivated, stripeTestmode: entry.stripeTestmode };
    }
  }
  const sitewideDeactivated: Record<string, number> = {};
  for (const [plugin, time] of Object.entries(record.sitewideDeactivated)) {
    if (installed(plugin)) sitewideDeactivated[plugin] = time;
    else skipped.add(plugin.split('/')[0]);
  }
  return {
    record: { environmentId: record.environmentId, options, sitewideDeactivated },
    skipped: [...skipped],
  };
}

// After a database push: put back on the server what the safe copy changed
// locally, so the server never ends up with its backups, mail or Stripe off.
async function restoreNeutralizedOnServer(
  deps: PullPushDeps,
  sync: ActiveSync,
  connection: RemoteConnection,
  environment: ServerEnvironment,
  record: NeutralizeRecord,
): Promise<string[]> {
  const scriptPath = path.join(deps.tempDir, 'ssh-sync-restore.php');
  deps.fs.writeFileSync(scriptPath, restoreNeutralizedScript(record));
  let output = '';
  try {
    await deps.runCommand(
      sync,
      'ssh',
      sshArgs(
        connection,
        remoteWp(connection, environment, '--skip-plugins --skip-themes eval-file -'),
      ),
      { stdinFile: scriptPath, onStdout: (chunk) => (output += chunk) },
    );
  } finally {
    try {
      deps.fs.unlinkSync(scriptPath);
    } catch {}
  }
  try {
    const parsed = JSON.parse(output.trim().split('\n').pop() || '');
    return Array.isArray(parsed.restored) ? parsed.restored.map(String) : [];
  } catch {
    throw new Error('Could not restore the plugins the safe local copy turned off on the server.');
  }
}

// Sage/Acorn (and other Laravel-based) themes COMPILE their Blade views and
// CACHE their config/services/packages with ABSOLUTE paths baked in. Pulled
// from production, those paths point at the remote (`/www/<install>/...`), so
// Acorn looks for assets/manifests in the wrong place and the local site
// renders blank ("manifest cannot be found" / "storage/framework/cache must be
// present"). These compiled artifacts are disposable — the framework rebuilds
// them locally on demand — so after a pull we delete the compiled `*.php` files
// while KEEPING the directories (Acorn requires storage/framework/cache to
// exist) and any `.gitkeep`/`.gitignore`. No-op for non-Sage sites (the dirs
// just aren't there). Returns the number of files removed.
const COMPILED_CACHE_RELDIRS = [
  path.join('storage', 'framework', 'views'),
  path.join('storage', 'framework', 'cache'),
  path.join('bootstrap', 'cache'),
];

export function clearCompiledFrameworkCaches(
  localPublicPath: string,
  dfs: PullPushDeps['fs'],
): number {
  const themesDir = path.join(localPublicPath, 'wp-content', 'themes');
  if (!dfs.existsSync(themesDir)) return 0;

  let themes: string[];
  try {
    themes = dfs.readdirSync(themesDir) as string[];
  } catch {
    return 0;
  }

  let removed = 0;
  for (const theme of themes) {
    for (const rel of COMPILED_CACHE_RELDIRS) {
      const dir = path.join(themesDir, theme, rel);
      if (!dfs.existsSync(dir)) continue;
      let entries: string[];
      try {
        entries = dfs.readdirSync(dir) as string[];
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.endsWith('.php')) continue; // keep .gitkeep/.gitignore + data/
        const file = path.join(dir, entry);
        try {
          if (dfs.statSync(file).isFile()) {
            dfs.unlinkSync(file);
            removed++;
          }
        } catch {
          /* best-effort: a file vanishing mid-clear is fine */
        }
      }
    }
  }
  return removed;
}

export async function executePull(params: SyncParams, deps: PullPushDeps): Promise<SyncResult> {
  const { localSiteId, site, environment, options } = params;
  const dfs = deps.fs;
  const run = deps.runCommand;
  const sendProgress = deps.sendProgress;

  if (deps.activeSyncs.has(localSiteId)) {
    return { success: false, error: 'A sync is already running for this site' };
  }

  // Security: every value below reaches ssh arguments or a remote shell
  const environmentError = validateEnvironment(environment);
  if (environmentError) {
    return { success: false, error: environmentError };
  }
  const remoteDomain = remoteDomainFromUrl(environment.remoteUrl)!;

  // Pre-flight: database sync needs the local site running (MySQL socket)
  const socketPath = deps.getMysqlSocketPath(localSiteId);
  if (options.includeDatabase && !dfs.existsSync(socketPath)) {
    return {
      success: false,
      error:
        'The local site must be running for database sync. Start the site in Local and try again.',
    };
  }

  // Register the sync BEFORE the first await so a second concurrent call can't
  // slip past the "already running" guard during pre-flight (TOCTOU race).
  const sync: ActiveSync = { cancelled: false, child: null };
  deps.activeSyncs.set(localSiteId, sync);

  // Fail-fast: connect and verify the WordPress root before any backup/transfer
  let connection: RemoteConnection;
  try {
    sendProgress({
      stage: 'connect',
      progress: 2,
      message: `Connecting to ${environment.label}...`,
    });
    connection = await deps.connectRemote(environment);
  } catch (e: any) {
    deps.activeSyncs.delete(localSiteId);
    return { success: false, error: e.message };
  }
  const siteUrlRefused = siteUrlRefusal(connection, environment, options.acceptSiteUrl);
  if (siteUrlRefused) {
    deps.activeSyncs.delete(localSiteId);
    await connection.close();
    return siteUrlRefused;
  }

  const startedAt = Date.now();

  // Once the local DB import starts, a cancel/crash leaves the database
  // half-written — these let the catch block restore the pre-pull backup.
  let dbImportStarted = false;
  // Set once the local site was switched to the server's table prefix
  let adoptedPrefix: { previous: string; tables: string[]; wpConfigPath: string } | null = null;
  const localBackupPath = path.join(deps.tempDir, `${localSiteId}-pre-pull-backup.sql`);
  const db = getDbCredentials(site);
  const publicPath = localPublicPath(site);

  try {
    // 0. A safe copy gets its safety net before anything arrives from the
    //    server, so nothing pulled can reach real services, even mid-pull.
    if (options.makeSafe !== false) installSafetyNet(deps, publicPath);

    // 1. Sync files (live progress, flags adapted to the rsync version)
    sendProgress({
      stage: 'files',
      progress: 5,
      message: `Syncing files from ${environment.label}...`,
    });

    const rsync = deps.resolveRsync();
    const rsyncResult = await run(
      sync,
      rsync.bin,
      [
        '-az',
        ...rsyncProgressArgs(rsync),
        ...excludeArgsFor(environment, options.includeUploads),
        '-e',
        rsyncRemoteShell(connection),
        rsyncRemoteRoot(connection),
        `${publicPath}/`,
      ],
      {
        // 23/24 = partial transfer (e.g. legacy non-UTF-8 filenames that
        // macOS can't store, or files vanishing on a live server) — warn
        // instead of failing the whole sync.
        okCodes: [23, 24],
        onStdout: makeRsyncProgressParser(rsync, (pct) => {
          // Files = 5–50% of the overall pull
          const overall = 5 + Math.round(pct * 0.45);
          sendProgress({
            stage: 'files',
            progress: overall,
            message: `Syncing files from ${environment.label}... ${pct}%`,
          });
        }),
      },
    );
    const fileWarning = describePartialTransfer(rsyncResult);

    sendProgress({
      stage: 'files',
      progress: 50,
      message: fileWarning ? 'Files synced (some skipped)' : 'Files synced!',
    });

    // 2. Database (if requested)
    if (options.includeDatabase) {
      const dbDumpPath = path.join(deps.tempDir, `${localSiteId}-remote.sql`);

      const mysqlBin = deps.findServiceBinary(['mysql-', 'mariadb-'], 'mysql');
      const mysqldumpBin = deps.findServiceBinary(['mysql-', 'mariadb-'], 'mysqldump');
      if (!mysqlBin || !mysqldumpBin) {
        throw new Error("Could not find MySQL binaries in Local's lightning-services");
      }

      // Safety net: back up the local database before overwriting it
      sendProgress({
        stage: 'database',
        progress: 52,
        message: 'Backing up local database...',
      });
      await run(
        sync,
        mysqldumpBin,
        [`-u${db.user}`, `-p${db.password}`, `--socket=${socketPath}`, db.database],
        { stdoutFile: localBackupPath },
      );

      // The rollback safety net is only as good as this backup — refuse to
      // overwrite the local DB if the dump came out empty/truncated.
      const localBackupSize = dfs.existsSync(localBackupPath)
        ? dfs.statSync(localBackupPath).size
        : 0;
      if (!isLikelyValidSqlDump(localBackupSize)) {
        throw new Error(
          `Local database backup looks invalid (${localBackupSize} bytes) — aborting before overwriting the local database.`,
        );
      }

      sendProgress({
        stage: 'database',
        progress: 58,
        message: `Exporting database from ${environment.label}...`,
      });
      await downloadRemoteDatabase(run, sync, connection, environment, dbDumpPath);

      // MariaDB 11.4+ → the dump carries utf8mb4_uca1400_* collations that
      // Local's MySQL 8 can't import ("Unknown collation"). Rewrite them in
      // place before the import. No-op for dumps without them.
      // latin1 maps every byte 1:1, so binary column data (e.g. Wordfence's
      // varbinary IPs) survives the round trip; 'utf8' turned invalid
      // sequences into U+FFFD and broke the import with duplicate keys.
      dfs.writeFileSync(
        dbDumpPath,
        downgradeMariaDBCollations(dfs.readFileSync(dbDumpPath, 'latin1')),
        'latin1',
      );

      sendProgress({
        stage: 'database',
        progress: 75,
        message: 'Importing database locally...',
      });
      dbImportStarted = true;
      await run(
        sync,
        mysqlBin,
        [`-u${db.user}`, `-p${db.password}`, `--socket=${socketPath}`, db.database],
        { stdinFile: dbDumpPath },
      );

      sendProgress({
        stage: 'search-replace',
        progress: 82,
        message: 'Running search-replace...',
      });

      // Search-replace URLs using WP-CLI (handles serialized data correctly)
      const localDomain = site.domain;

      const phpBin = deps.findServiceBinary(['php-'], 'php');
      const wpCliPhar = deps.findWpCliPhar();
      if (!phpBin) throw new Error("Could not find PHP binary in Local's lightning-services");
      if (!wpCliPhar) throw new Error('Could not find WP-CLI in the Local installation');
      const mysqlBinDir = path.dirname(mysqlBin);

      // Temporarily modify wp-config.php to include socket path
      const wpConfigPath = path.join(publicPath, 'wp-config.php');
      const wpConfigBackupPath = wpConfigPath + '.ssh-sync-bak';
      let wpConfigBackup: string | null = null;
      // The local table prefix, read before the temporary socket edit, so we can
      // reconcile it against the server's after the import (see below).
      let localPrefix: string | null = null;

      try {
        // Restore from backup if exists (previous crash)
        if (dfs.existsSync(wpConfigBackupPath)) {
          dfs.copyFileSync(wpConfigBackupPath, wpConfigPath);
          dfs.unlinkSync(wpConfigBackupPath);
        }

        wpConfigBackup = dfs.readFileSync(wpConfigPath, 'utf8');
        localPrefix = parseTablePrefix(wpConfigBackup);
        dfs.writeFileSync(wpConfigBackupPath, wpConfigBackup);

        const wpConfigModified = wpConfigBackup.replace(
          /define\s*\(\s*['"]DB_HOST['"]\s*,\s*['"]([^'"]*)['"]\s*\)/,
          `define('DB_HOST', 'localhost:${socketPath}')`,
        );
        dfs.writeFileSync(wpConfigPath, wpConfigModified);

        const wpEnv = { ...process.env, PATH: `${mysqlBinDir}:${process.env.PATH || ''}` };
        // MultiSite.No is the empty string, so truthiness is the correct check
        const networkArgs = site.multiSite ? ['--network'] : [];
        const pairs = searchReplacePairs(remoteDomain, localDomain);

        for (let i = 0; i < pairs.length; i++) {
          const [from, to] = pairs[i];
          sendProgress({
            stage: 'search-replace',
            progress: 84 + i * 3,
            message: `Replacing ${from} → ${to}`,
          });
          await run(
            sync,
            phpBin,
            [
              wpCliPhar,
              'search-replace',
              from,
              to,
              '--all-tables',
              '--skip-columns=guid',
              '--skip-plugins',
              '--skip-themes',
              `--path=${publicPath}`,
              '--allow-root',
              ...networkArgs,
            ],
            { env: wpEnv },
          );
        }

        sendProgress({
          stage: 'search-replace',
          progress: 96,
          message: 'Search-replace complete!',
        });
      } finally {
        // Always restore wp-config.php — but never let a restore failure mask the
        // original sync error (it gates the DB-rollback decision in the catch).
        try {
          if (wpConfigBackup) {
            dfs.writeFileSync(wpConfigPath, wpConfigBackup);
          }
          if (dfs.existsSync(wpConfigBackupPath)) {
            dfs.unlinkSync(wpConfigBackupPath);
          }
        } catch (e: any) {
          console.warn('[SSH Sync] wp-config.php restore failed (non-fatal):', e?.message);
        }
      }

      // Reconcile the table prefix. `wp db export` carries the server's table
      // prefix; if it differs from the local wp-config's, WordPress keeps reading
      // the old (now empty) local tables and the freshly-pulled data is invisible.
      // We adopt the remote prefix locally and drop the stale old-prefix tables.
      // The remote prefix is read authoritatively from the remote wp-config (NOT
      // inferred from local tables — stale tables from a previous prefix would
      // mislead detection and risk dropping the wrong set).
      if (localPrefix) {
        let remotePrefix: string | null = null;
        try {
          let remotePrefixRaw = '';
          await run(
            sync,
            'ssh',
            sshArgs(connection, remoteWp(connection, environment, 'config get table_prefix')),
            {
              onStdout: (c) => {
                remotePrefixRaw += c;
              },
            },
          );
          remotePrefix = normalizeTablePrefix(remotePrefixRaw);
        } catch (e: any) {
          // A prefix-lookup blip must not roll back a successful import — skip
          // reconciliation instead. (Still honor an in-flight cancellation.)
          if (e instanceof CancelledError) throw e;
          console.warn(
            '[SSH Sync] Could not read remote table prefix; skipping prefix reconciliation:',
            e?.message,
          );
        }

        if (remotePrefix && remotePrefix !== localPrefix) {
          let tablesRaw = '';
          await run(
            sync,
            mysqlBin,
            [
              `-u${db.user}`,
              `-p${db.password}`,
              `--socket=${socketPath}`,
              db.database,
              '-N',
              '-e',
              'SHOW TABLES',
            ],
            {
              onStdout: (c) => {
                tablesRaw += c;
              },
            },
          );
          const allTables = tablesRaw
            .split('\n')
            .map((t) => t.trim())
            .filter(Boolean);
          const keep = allTables.filter((t) => t.startsWith(remotePrefix));
          const stale = allTables.filter((t) => !t.startsWith(remotePrefix));

          // Safety: only act when the import really produced the adopted-prefix
          // tables — never repoint wp-config at a prefix with no tables, and
          // never risk nuking the whole database on an unexpected table list.
          if (keep.length > 0) {
            sendProgress({
              stage: 'search-replace',
              progress: 97,
              message: `Adopting table prefix ${remotePrefix}...`,
            });

            // 1. Drop the stale old-prefix tables.
            if (stale.length > 0) {
              const dropSql =
                'SET FOREIGN_KEY_CHECKS=0;' +
                stale.map((t) => ` DROP TABLE IF EXISTS \`${t.replace(/`/g, '``')}\`;`).join('') +
                ' SET FOREIGN_KEY_CHECKS=1;';
              await run(sync, mysqlBin, [
                `-u${db.user}`,
                `-p${db.password}`,
                `--socket=${socketPath}`,
                db.database,
                '-e',
                dropSql,
              ]);
            }

            // 2. Point wp-config at the imported tables LAST: until this write
            //    WordPress still reads the local prefix, so a failure before it
            //    (with the DB rolled back by the catch) leaves a consistent site.
            const cfg = dfs.readFileSync(wpConfigPath, 'utf8');
            dfs.writeFileSync(wpConfigPath, setTablePrefix(cfg, remotePrefix));
            // A failure after this point must undo the adoption too
            adoptedPrefix = { previous: localPrefix, tables: keep, wpConfigPath };
          }
        }
      }

      // Cleanup (keep the pre-pull backup until the next pull)
      try {
        dfs.unlinkSync(dbDumpPath);
      } catch (e: any) {
        console.warn('[SSH Sync] Temp dump cleanup failed (non-fatal):', e?.message);
      }
    }

    // 3. Make the copy safe before anything can load it. A failure here rolls
    //    the database back (catch below): an unsafe copy is worse than none.
    let safeCloneNote: string | null = null;
    if (options.makeSafe !== false) {
      let neutralized: Pick<NeutralizeResult, 'deactivated' | 'stripe'> = {
        deactivated: [],
        stripe: false,
      };
      if (options.includeDatabase) {
        sendProgress({ stage: 'safety', progress: 98, message: 'Making the local copy safe...' });
        const phpBin = deps.findServiceBinary(['php-'], 'php');
        if (!phpBin) throw new Error("Could not find PHP binary in Local's lightning-services");
        const result = await neutralizeDatabase(deps, sync, publicPath, { phpBin, socketPath, db });
        deps.saveNeutralizeRecord(localSiteId, { ...result.record, environmentId: environment.id });
        neutralized = result;
      }
      safeCloneNote = describeSafeClone(neutralized);
    } else if (options.includeDatabase) {
      // The local database is the server's again, untouched: nothing to put back
      deps.saveNeutralizeRecord(localSiteId, null);
    }

    // Clear compiled Sage/Acorn caches that bake absolute server paths (see
    // clearCompiledFrameworkCaches). Runs for every pull — the compiled views
    // are files, synced regardless of the database option — and is best-effort:
    // a failure here must never fail an otherwise-complete pull.
    try {
      const cleared = clearCompiledFrameworkCaches(publicPath, dfs);
      if (cleared > 0) {
        console.log(`[SSH Sync] Cleared ${cleared} compiled theme cache file(s) after pull`);
      }
    } catch (e: any) {
      console.warn('[SSH Sync] Framework cache clear failed (non-fatal):', e?.message);
    }

    deps.recordSync(localSiteId, 'pull', environment, Date.now() - startedAt);
    sendProgress({
      stage: 'done',
      progress: 100,
      message: fileWarning ? `Pull complete — ${fileWarning}` : 'Pull complete!',
    });
    if (safeCloneNote) console.log(`[SSH Sync] ${safeCloneNote}`);
    deps.notify(
      PRODUCT_NAME,
      fileWarning
        ? `Pull complete for ${site.name || site.domain} — some files were skipped (legacy filenames)`
        : `Pull complete for ${site.name || site.domain}`,
    );
    return { success: true, warning: fileWarning, note: safeCloneNote };
  } catch (error: any) {
    // The local DB was (partially) overwritten — a half-imported or
    // half-search-replaced database is unusable, so roll back to the
    // backup taken right before the import.
    if (dbImportStarted && dfs.existsSync(localBackupPath)) {
      try {
        sendProgress({
          stage: 'database',
          progress: 0,
          message: 'Restoring local database from backup...',
        });
        const mysqlBinRestore = deps.findServiceBinary(['mysql-', 'mariadb-'], 'mysql');
        if (!mysqlBinRestore) throw new Error('mysql binary not found');
        await run(
          freshSync(),
          mysqlBinRestore,
          [`-u${db.user}`, `-p${db.password}`, `--socket=${socketPath}`, db.database],
          { stdinFile: localBackupPath },
        );
        // The backup brought the local-prefix tables back: drop the pulled
        // ones and point wp-config.php back at the local prefix
        if (adoptedPrefix) {
          const dropSql =
            'SET FOREIGN_KEY_CHECKS=0;' +
            adoptedPrefix.tables
              .map((t) => ` DROP TABLE IF EXISTS \`${t.replace(/`/g, '``')}\`;`)
              .join('') +
            ' SET FOREIGN_KEY_CHECKS=1;';
          await run(freshSync(), mysqlBinRestore, [
            `-u${db.user}`,
            `-p${db.password}`,
            `--socket=${socketPath}`,
            db.database,
            '-e',
            dropSql,
          ]);
          const cfg = dfs.readFileSync(adoptedPrefix.wpConfigPath, 'utf8');
          dfs.writeFileSync(
            adoptedPrefix.wpConfigPath,
            setTablePrefix(cfg, adoptedPrefix.previous),
          );
        }
        deps.notify(
          PRODUCT_NAME,
          `Pull aborted — local database for ${site.name || site.domain} was restored from backup`,
        );
      } catch (restoreError: any) {
        console.error('[SSH Sync] DB restore after aborted pull failed:', restoreError.message);
        deps.notify(
          PRODUCT_NAME,
          `Pull aborted — automatic DB restore FAILED. Backup: ${localBackupPath}`,
        );
      }
    }
    if (error instanceof CancelledError) {
      sendProgress({ stage: 'cancelled', progress: 0, message: 'Sync cancelled' });
      return { success: false, cancelled: true, error: 'Sync cancelled' };
    }
    sendProgress({ stage: 'error', progress: 0, message: error.message });
    deps.notify(PRODUCT_NAME, `Pull failed for ${site.name || site.domain}`);
    return { success: false, error: error.message };
  } finally {
    deps.activeSyncs.delete(localSiteId);
    await connection.close();
  }
}

// Replacing a Production database wipes everything written there since the
// last pull (orders, form entries, users). Only an explicit Migration mode with
// the domain typed back allows it; enforced here, not only in the UI.
export function productionDatabaseGuard(
  environment: ServerEnvironment,
  options: SyncParams['options'],
): string | null {
  if (!options.includeDatabase || !environment.isProduction) return null;
  const remoteDomain = remoteDomainFromUrl(environment.remoteUrl);
  if (options.migrationMode && remoteDomain && options.confirmDomain === remoteDomain) {
    return null;
  }
  return `Pushing the database to ${environment.label} (production) replaces everything on the live site. Turn on Migration mode and type ${remoteDomain || 'the domain'} to confirm.`;
}

export async function executePush(params: SyncParams, deps: PullPushDeps): Promise<SyncResult> {
  const { localSiteId, site, environment, options } = params;
  const dfs = deps.fs;
  const run = deps.runCommand;
  const sendProgress = deps.sendProgress;

  if (deps.activeSyncs.has(localSiteId)) {
    return { success: false, error: 'A sync is already running for this site' };
  }

  // Security: every value below reaches ssh arguments or a remote shell
  const environmentError = validateEnvironment(environment);
  if (environmentError) {
    return { success: false, error: environmentError };
  }
  const remoteDomain = remoteDomainFromUrl(environment.remoteUrl)!;

  const guardError = productionDatabaseGuard(environment, options);
  if (guardError) {
    return { success: false, error: guardError };
  }

  // The local domain goes into the remote search-replace command — reject
  // shell-unsafe domains before any destructive step.
  if (options.includeDatabase && !isValidDomain(site.domain)) {
    return { success: false, error: 'Invalid local site domain.' };
  }

  // Pre-flight: database sync needs the local site running (MySQL socket)
  const socketPath = deps.getMysqlSocketPath(localSiteId);
  if (options.includeDatabase && !dfs.existsSync(socketPath)) {
    return {
      success: false,
      error:
        'The local site must be running for database sync. Start the site in Local and try again.',
    };
  }

  // Register the sync BEFORE the first await so a second concurrent call can't
  // slip past the "already running" guard during pre-flight (TOCTOU race).
  const sync: ActiveSync = { cancelled: false, child: null };
  deps.activeSyncs.set(localSiteId, sync);

  let connection: RemoteConnection;
  try {
    sendProgress({
      stage: 'connect',
      progress: 1,
      message: `Connecting to ${environment.label}...`,
    });
    connection = await deps.connectRemote(environment);
  } catch (e: any) {
    deps.activeSyncs.delete(localSiteId);
    return { success: false, error: e.message };
  }
  const siteUrlRefused = siteUrlRefusal(connection, environment, options.acceptSiteUrl);
  if (siteUrlRefused) {
    deps.activeSyncs.delete(localSiteId);
    await connection.close();
    return siteUrlRefused;
  }

  // A leftover preview dry-run must not compete with the real push
  deps.activePreviews.get(localSiteId)?.child?.kill('SIGTERM');

  const startedAt = Date.now();

  // Once the remote DB import starts, a cancel/crash leaves the remote
  // database half-written — lets the catch block restore the backup.
  let remoteImportStarted = false;
  let remoteDatabaseFinished = false;
  let restoredOnServer: string[] = [];
  const stamp = pushStamp();
  const backupBase = path.join(deps.backupsDir, `${localSiteId}-${environment.id}-${stamp}`);
  let lock: string | null = null;
  // Set right before the first file changes on the server: from then on a
  // failure puts the replaced files back and removes the added ones
  let filesChanged = false;
  let remoteFilesBackup: string | null = null;
  let localFilesBackup: string | null = null;
  let changes: PushedChanges | null = null;
  const lockToken = newLockToken();
  let lockHeartbeat: ReturnType<typeof setInterval> | null = null;
  let restoreWarning: string | null = null;
  let prefixReconciled = true;
  let pushManifest: PushManifest | null = null;
  let remotePrefixBefore: string | null = null;
  let cancelledLate = false;
  let remoteBackupPath: string | null = null;
  const publicPath = localPublicPath(site);

  try {
    // 0. One push at a time to this server folder, from any computer. The
    //    release in `finally` checks our token, so it is safe to attempt even
    //    when this acquire is interrupted or loses the race.
    lock = lockDir(connection.remoteHome, connection.remoteRoot);
    let lockOutput = '';
    await run(
      sync,
      'ssh',
      sshArgs(
        connection,
        acquireLockCommand(lock, lockOwner(os.hostname(), site.name || site.domain), lockToken),
      ),
      { onStdout: (c) => (lockOutput += c) },
    );
    const lockResult = parseLockOutput(lockOutput);
    if (!lockResult.ok) {
      throw new Error(
        `Another push to ${environment.label} is running${lockResult.owner ? `: ${lockResult.owner}` : ''}. Try again when it finishes.`,
      );
    }
    const heldLock = lock;
    lockHeartbeat = setInterval(() => {
      run(freshSync(), 'ssh', sshArgs(connection, refreshLockCommand(heldLock, lockToken))).catch(
        () => {},
      );
    }, 15 * 60_000);
    dfs.mkdirSync(deps.backupsDir, { recursive: true });

    // 1. Safety net for the automatic rollback: the remote database, exported
    //    and kept on this machine (nothing is left on the server).
    if (options.includeDatabase) {
      sendProgress({ stage: 'backup', progress: 3, message: 'Backing up remote database...' });
      remoteBackupPath = `${backupBase}.sql`;
      await downloadRemoteDatabase(run, sync, connection, environment, remoteBackupPath);

      // The rollback restores from this exact file: abort if it looks bad
      // (the server is still untouched at this point).
      const backupSize = dfs.existsSync(remoteBackupPath) ? dfs.statSync(remoteBackupPath).size : 0;
      if (!isLikelyValidSqlDump(backupSize)) {
        throw new Error(
          `Remote database backup looks invalid (${backupSize} bytes) — aborting the push before any change. Your server was not modified.`,
        );
      }
    }

    // 2. Sync files (live progress, flags adapted to the rsync version)
    sendProgress({
      stage: 'files',
      progress: 8,
      message: `Syncing files to ${environment.label}...`,
    });

    const rsync = deps.resolveRsync();

    // Selective push (from the preview screen): only the checked files
    const selective = Array.isArray(options.files);
    let filesFromPath: string | undefined;
    if (selective) {
      filesFromPath = path.join(deps.tempDir, `${localSiteId}-push-files.txt`);
      deps.ensureConfigDir();
      // One path per line, relative to the rsync source root
      dfs.writeFileSync(filesFromPath, (options.files || []).join('\n') + '\n');
    }

    let fileWarning: string | null = null;
    // Replaced and deleted server files go to a backup folder (downloaded
    // below); new ones are listed so an undo can remove them
    remoteFilesBackup = remoteFilesBackupDir(connection.remoteHome, stamp);
    const knowsAdded = rsync.supportsOutFormat;
    let rsyncOutput = '';
    let ranRsync = false;
    try {
      if (!selective || (options.files && options.files.length > 0)) {
        const progressParser = makeRsyncProgressParser(rsync, (pct) => {
          // Files = 8–50% of the overall push
          const overall = 8 + Math.round(pct * 0.42);
          sendProgress({
            stage: 'files',
            progress: overall,
            message: `Syncing files to ${environment.label}... ${pct}%`,
          });
        });
        filesChanged = true;
        ranRsync = true;
        const rsyncResult = await run(
          sync,
          rsync.bin,
          buildPushRsyncArgs({
            rsync,
            excludeArgs: [
              ...excludeArgsFor(environment, options.includeUploads),
              '--backup',
              `--backup-dir=${remoteFilesBackup}`,
              // -8: names exactly as on disk (no \#ooo escapes) in the markers
              ...(knowsAdded ? ['-8', `--out-format=${OUT_FORMAT_MARKER}|%i|%n`] : []),
            ],
            sshCommand: rsyncRemoteShell(connection),
            localPublicPath: publicPath,
            remoteRoot: rsyncRemoteRoot(connection),
            mode: options.mode,
            filesFromPath,
          }),
          {
            // 23/24 = partial transfer — warn instead of failing the whole sync
            okCodes: [23, 24],
            onStdout: (chunk) => {
              rsyncOutput += chunk;
              progressParser(chunk);
            },
          },
        );
        fileWarning = describePartialTransfer(rsyncResult);
      }
    } finally {
      if (filesFromPath) {
        try {
          dfs.unlinkSync(filesFromPath);
        } catch {}
      }
      // No rsync run (database-only or deletions-only push): nothing unknown
      changes = !ranRsync
        ? { files: [], dirs: [], updated: [], deleted: [] }
        : knowsAdded
          ? parseAddedFromOutFormat(rsyncOutput)
          : null;
    }
    // Checked deletions from the preview — executed explicitly (instead of
    // rsync --delete) so unchecked deletions survive. Paths are strictly
    // validated + single-quoted.
    if (options.deletions && options.deletions.length > 0) {
      sendProgress({
        stage: 'files',
        progress: 48,
        message: `Deleting ${options.deletions.length} file(s) on ${environment.label}...`,
      });
      const unsafe = options.deletions.find((p) => !isSafeListedPath(p));
      if (unsafe) throw new Error(`Unsafe path refused for remote deletion: ${unsafe}`);
      filesChanged = true;
      await runWithPathList(
        deps,
        sync,
        connection,
        moveListedToBackupCommand(remoteFilesBackup),
        outermostPaths(options.deletions),
      );
    }

    // The replaced and deleted files come to this machine; nothing stays on
    // the server. The manifest makes the push undoable.
    if (filesChanged) {
      localFilesBackup = await downloadFilesBackup(
        deps,
        sync,
        connection,
        remoteFilesBackup,
        `${backupBase}-files`,
      );
      remoteFilesBackup = null;
    }
    // What each written file looks like now on the server (rsync -a keeps
    // size and mtime), so an undo can see if anything changed after the push
    const pushed: Record<string, [number, number]> = {};
    for (const file of changes ? [...changes.files, ...changes.updated] : []) {
      try {
        const stat = dfs.statSync(path.join(publicPath, file));
        pushed[file] = [stat.size, Math.floor(stat.mtimeMs / 1000)];
      } catch {
        // gone locally since: undo will not check it
      }
    }
    // A push that changed nothing on the server leaves nothing to undo
    if (filesChanged || options.includeDatabase) {
      pushManifest = {
        environmentId: environment.id,
        stamp,
        added: changes ? changes.files : null,
        addedDirs: changes ? changes.dirs : null,
        pushed,
        deleted: [...(changes ? changes.deleted : []), ...outermostPaths(options.deletions || [])],
        hasFilesBackup: Boolean(localFilesBackup),
        hasDatabaseBackup: Boolean(options.includeDatabase),
      };
      writePushManifest(deps, backupBase, pushManifest);
    }

    sendProgress({
      stage: 'files',
      progress: 50,
      message: fileWarning ? 'Files synced (some skipped)' : 'Files synced!',
    });

    // 3. Database (if requested)
    if (options.includeDatabase) {
      const db = getDbCredentials(site);
      const dbDumpPath = path.join(deps.tempDir, `${localSiteId}-local.sql`);

      const mysqldumpBin = deps.findServiceBinary(['mysql-', 'mariadb-'], 'mysqldump');
      if (!mysqldumpBin) {
        throw new Error("Could not find mysqldump in Local's lightning-services");
      }

      sendProgress({ stage: 'database', progress: 55, message: 'Exporting local database...' });
      await run(
        sync,
        mysqldumpBin,
        [`-u${db.user}`, `-p${db.password}`, `--socket=${socketPath}`, db.database],
        { stdoutFile: dbDumpPath },
      );

      // Local ships MySQL 8.x → the dump carries utf8mb4_0900_* collations that
      // MariaDB servers can't import ("Unknown collation"). Rewrite them in
      // place before upload so the import succeeds. No-op for dumps without them.
      // latin1 maps every byte 1:1, so binary column data (e.g. Wordfence's
      // varbinary IPs) survives the round trip; 'utf8' turned invalid
      // sequences into U+FFFD and broke the import with duplicate keys.
      dfs.writeFileSync(
        dbDumpPath,
        downgradeMySQL8Collations(dfs.readFileSync(dbDumpPath, 'latin1')),
        'latin1',
      );

      sendProgress({
        stage: 'database',
        progress: 70,
        message: `Importing database on ${environment.label}...`,
      });
      // From here until the database steps finish, the server is changed by
      // commands a cancel cannot stop (see importDatabaseOnServer): they run on
      // their own ActiveSync, and a cancel takes effect once they are done.
      const serverDbSync = freshSync();
      try {
        await importDatabaseOnServer(run, sync, connection, environment, dbDumpPath, () => {
          remoteImportStarted = true;
        });
      } finally {
        try {
          dfs.unlinkSync(dbDumpPath);
        } catch {}
      }

      sendProgress({
        stage: 'search-replace',
        progress: 82,
        message: 'Running search-replace...',
      });

      // MultiSite.No is the empty string, so truthiness is the correct check
      const networkFlag = site.multiSite ? ' --network' : '';
      const pairs = searchReplacePairs(site.domain, remoteDomain);

      for (let i = 0; i < pairs.length; i++) {
        const [from, to] = pairs[i];
        sendProgress({
          stage: 'search-replace',
          progress: 84 + i * 3,
          message: `Replacing ${from} → ${to}`,
        });
        // Plugins and themes stay off: the freshly imported local database must
        // not boot on the server (cron, emails, fatals) before the URLs are right.
        await run(
          serverDbSync,
          'ssh',
          sshArgs(
            connection,
            remoteWp(
              connection,
              environment,
              `--skip-plugins --skip-themes search-replace ${shellQuote(from)} ${shellQuote(to)} --all-tables --skip-columns=guid${networkFlag}`,
            ),
          ),
        );
      }

      // Reconcile the remote table prefix (symmetric with the pull side). The
      // pushed dump carries the LOCAL prefix; if the server's wp-config uses a
      // different one, WordPress there keeps reading the old (now stale) tables
      // and the pushed data is invisible. Read both authoritatively and, if they
      // differ, repoint the remote wp-config. Non-fatal: a failed lookup/set must
      // not roll back an otherwise-successful push (the import already landed) —
      // we surface a notice instead, mirroring the pull-side handling.
      try {
        const localPrefix = normalizeTablePrefix(
          parseTablePrefix(dfs.readFileSync(path.join(publicPath, 'wp-config.php'), 'utf8')) || '',
        );
        let remotePrefix: string | null = null;
        if (localPrefix) {
          let remotePrefixRaw = '';
          await run(
            serverDbSync,
            'ssh',
            sshArgs(connection, remoteWp(connection, environment, 'config get table_prefix')),
            { onStdout: (c: string) => (remotePrefixRaw += c) },
          );
          remotePrefix = normalizeTablePrefix(remotePrefixRaw);
        }
        if (localPrefix && remotePrefix && localPrefix !== remotePrefix) {
          sendProgress({
            stage: 'search-replace',
            progress: 96,
            message: `Updating remote table prefix to ${localPrefix}...`,
          });
          // wp-config.php is never synced or backed up: the old prefix goes in
          // the manifest so an undo can point the site back at its tables
          remotePrefixBefore = remotePrefix;
          await run(
            serverDbSync,
            'ssh',
            sshArgs(
              connection,
              remoteWp(
                connection,
                environment,
                `--skip-plugins --skip-themes config set table_prefix ${shellQuote(localPrefix)}`,
              ),
            ),
          );
        }
      } catch (prefixError: any) {
        prefixReconciled = false;
        console.warn(
          '[SSH Sync] Remote table-prefix reconcile failed (non-fatal):',
          prefixError?.message,
        );
        deps.notify(
          PRODUCT_NAME,
          `Push done, but updating the remote table prefix failed — if the site looks empty, set $table_prefix in wp-config.php on ${environment.label} to match Local.`,
        );
      }

      // The server database is complete and consistent: nothing after this
      // point may roll it back, a late cancel included.
      remoteDatabaseFinished = true;
      if (pushManifest && remotePrefixBefore) {
        pushManifest.remotePrefixBefore = remotePrefixBefore;
        writePushManifest(deps, backupBase, pushManifest);
      }

      // What the safe local copy turned off goes back on, on the server it
      // was pulled from only: on any other environment it would switch on
      // that server's live payments, backups and mail. Plugins whose folder
      // is gone locally were removed on purpose and stay off. Non-fatal: the
      // push itself has landed.
      const neutralizeRecord = deps.loadNeutralizeRecord(localSiteId);
      if (
        neutralizeRecord &&
        neutralizeRecord.environmentId === environment.id &&
        prefixReconciled
      ) {
        const { record, skipped } = keepInstalledPlugins(neutralizeRecord, publicPath, dfs);
        if (!isEmptyRecord(record)) {
          sendProgress({
            stage: 'search-replace',
            progress: 97,
            message: 'Restoring plugins the safe local copy turned off...',
          });
          try {
            restoredOnServer = await restoreNeutralizedOnServer(
              deps,
              serverDbSync,
              connection,
              environment,
              record,
            );
          } catch (e: any) {
            console.warn('[SSH Sync] Restoring neutralized plugins failed:', e?.message);
            restoreWarning = `Push done, but re-enabling what the safe local copy turned off failed on ${environment.label}: check its active plugins${typeof record.options.options?.stripeTestmode === 'string' ? ' and Stripe mode' : ''}.`;
          }
        }
        if (skipped.length) {
          restoreWarning = [
            restoreWarning,
            `Left off on ${environment.label} (deleted locally): ${skipped.join(', ')}.`,
          ]
            .filter(Boolean)
            .join(' ');
        }
      } else if (neutralizeRecord && neutralizeRecord.environmentId === environment.id) {
        restoreWarning = `The table prefix could not be updated, so the plugins the safe local copy turned off were not re-enabled on ${environment.label}.`;
      }
    }

    // A cancel that arrived while the server database was being replaced only
    // skips what is left (the cache command): the push itself already landed.
    if (sync.cancelled) {
      cancelledLate = true;
    }

    // 4. The environment's cache command (non-fatal)
    if (environment.cacheCommand && !cancelledLate) {
      sendProgress({ stage: 'cache', progress: 98, message: 'Clearing cache...' });
      try {
        await run(
          sync,
          'ssh',
          sshArgs(connection, inRemoteRoot(connection, environment.cacheCommand)),
        );
      } catch (e: any) {
        if (e instanceof CancelledError) {
          cancelledLate = true;
        } else {
          console.warn('[SSH Sync] Cache command after push failed:', e?.message);
          deps.notify(
            PRODUCT_NAME,
            `Push done, but the cache command failed on ${environment.label}.`,
          );
        }
      }
    }

    const lateCancelWarning = cancelledLate
      ? 'Cancel arrived after the server was updated, so the push was completed.'
      : null;
    const warning =
      [fileWarning, lateCancelWarning, restoreWarning].filter(Boolean).join(' ') || null;
    const pushWarning = () => [warning, markerWarning].filter(Boolean).join(' ') || null;

    // The newest push to this folder, for undo from any computer to check
    let markerWarning: string | null = null;
    if (filesChanged || options.includeDatabase) {
      try {
        await run(
          freshSync(),
          'ssh',
          sshArgs(
            connection,
            `printf '%s %s\\n' ${shellQuote(stamp)} ${shellQuote(lockOwner(os.hostname(), site.name || site.domain))} > ${shellQuote(lastPushMarker(connection.remoteHome, connection.remoteRoot))}`,
          ),
        );
      } catch (e: any) {
        console.warn('[SSH Sync] Could not record the push on the server:', e?.message);
        markerWarning = `This push could not be recorded on ${environment.label}, so an undo of an older push from another computer cannot see it.`;
      }
    }
    deps.recordSync(localSiteId, 'push', environment, Date.now() - startedAt);
    sendProgress({
      stage: 'done',
      progress: 100,
      message: pushWarning() ? `Push complete — ${pushWarning()}` : 'Push complete!',
    });
    deps.notify(
      PRODUCT_NAME,
      pushWarning()
        ? `Push complete for ${site.name || site.domain} — ${pushWarning()}`
        : `Push complete for ${site.name || site.domain}`,
    );
    const restoredNote = restoredOnServer.length
      ? `Re-enabled on ${environment.label} what the safe local copy had turned off: ${restoredOnServer
          .map((p) => (p === 'stripe-testmode' ? 'Stripe live mode' : p.split('/')[0]))
          .join(', ')}.`
      : null;
    // Only now: a failed push must never push a good one's backups out
    prunePushBackups(deps.backupsDir, localSiteId, environment.id, dfs);
    return { success: true, warning: pushWarning(), note: restoredNote };
  } catch (error: any) {
    let rollbackFailed = false;
    // The remote DB was (partially) overwritten — restore the backup exported
    // right before the import.
    if (remoteImportStarted && !remoteDatabaseFinished && remoteBackupPath) {
      try {
        sendProgress({
          stage: 'database',
          progress: 0,
          message: 'Restoring remote database from backup...',
        });
        await importDatabaseOnServer(run, freshSync(), connection, environment, remoteBackupPath);
        deps.notify(
          PRODUCT_NAME,
          `Push aborted — remote database for ${site.name || site.domain} was restored from backup`,
        );
      } catch (restoreError: any) {
        rollbackFailed = true;
        console.error(
          '[SSH Sync] Remote DB restore after aborted push failed:',
          restoreError.message,
        );
        deps.notify(
          PRODUCT_NAME,
          `Push aborted — automatic remote DB restore FAILED. Backup on this computer: ${remoteBackupPath}`,
        );
      }
    }
    // A push that did not finish is not undoable: its changes are rolled
    // back here, so the newest finished push stays the one to undo
    try {
      dfs.unlinkSync(`${backupBase}.json`);
    } catch {
      // not written yet
    }
    // Files changed but the push did not finish: put them back, so the
    // server keeps code that matches its (restored) database
    if (filesChanged && !remoteDatabaseFinished) {
      try {
        sendProgress({ stage: 'files', progress: 0, message: 'Restoring server files...' });
        await restorePushedFiles(deps, freshSync(), connection, {
          localFilesBackup,
          remoteFilesBackup,
          added: changes,
        });
        deps.notify(
          PRODUCT_NAME,
          `Push aborted — the files it changed on ${environment.label} were put back`,
        );
      } catch (restoreError: any) {
        rollbackFailed = true;
        console.error('[SSH Sync] File restore after aborted push failed:', restoreError.message);
        deps.notify(
          PRODUCT_NAME,
          `Push aborted — restoring the files on ${environment.label} FAILED. Backup: ${localFilesBackup || remoteFilesBackup}`,
        );
      }
    }
    // Rolled back: this push's backups have served their purpose. Kept when
    // a rollback failed, as the user's way back.
    if (!rollbackFailed) {
      for (const artifact of [`${backupBase}.sql`, `${backupBase}-files`]) {
        try {
          dfs.rmSync(artifact, { recursive: true, force: true });
        } catch {}
      }
    }
    if (error instanceof CancelledError) {
      sendProgress({ stage: 'cancelled', progress: 0, message: 'Sync cancelled' });
      return { success: false, cancelled: true, error: 'Sync cancelled' };
    }
    sendProgress({ stage: 'error', progress: 0, message: error.message });
    deps.notify(PRODUCT_NAME, `Push failed for ${site.name || site.domain}`);
    return { success: false, error: error.message };
  } finally {
    deps.activeSyncs.delete(localSiteId);
    if (lockHeartbeat) clearInterval(lockHeartbeat);
    if (lock) {
      try {
        await run(freshSync(), 'ssh', sshArgs(connection, releaseLockCommand(lock, lockToken)));
      } catch (e: any) {
        console.warn('[SSH Sync] Could not release the push lock:', e?.message);
      }
    }
    await connection.close();
  }
}

// Undo the newest push to an environment: the files it replaced or deleted
// come back, the files it added go, and when it carried the database, the
// database from right before it is imported again. Undoing a production
// database needs the domain typed back, like the push itself.
export async function executeUndoPush(
  params: {
    localSiteId: string;
    site: SyncParams['site'];
    environment: ServerEnvironment;
    confirmDomain?: string;
    acceptSiteUrl?: string;
  },
  deps: PullPushDeps,
): Promise<SyncResult> {
  const { localSiteId, site, environment } = params;
  const sendProgress = deps.sendProgress;
  if (deps.activeSyncs.has(localSiteId)) {
    return { success: false, error: 'A sync is already running for this site' };
  }
  const environmentError = validateEnvironment(environment);
  if (environmentError) return { success: false, error: environmentError };

  const latest = deps.latestPushManifest(localSiteId, environment.id);
  if (!latest) return { success: false, error: `No push to ${environment.label} to undo.` };
  const manifest = latest.manifest as PushManifest;
  const sqlBackup = `${latest.base}.sql`;
  const withDatabase = manifest.hasDatabaseBackup && deps.fs.existsSync(sqlBackup);
  if (
    withDatabase &&
    environment.isProduction &&
    params.confirmDomain !== remoteDomainFromUrl(environment.remoteUrl)
  ) {
    return {
      success: false,
      error: `Undoing this push replaces the ${environment.label} database with the one from before it. Type ${remoteDomainFromUrl(environment.remoteUrl)} to confirm.`,
    };
  }

  const sync: ActiveSync = { cancelled: false, child: null };
  deps.activeSyncs.set(localSiteId, sync);
  let connection: RemoteConnection;
  try {
    sendProgress({
      stage: 'connect',
      progress: 2,
      message: `Connecting to ${environment.label}...`,
    });
    connection = await deps.connectRemote(environment);
  } catch (e: any) {
    deps.activeSyncs.delete(localSiteId);
    return { success: false, error: e.message };
  }
  const siteUrlRefused = siteUrlRefusal(connection, environment, params.acceptSiteUrl);
  if (siteUrlRefused) {
    deps.activeSyncs.delete(localSiteId);
    await connection.close();
    return siteUrlRefused;
  }

  const lockToken = newLockToken();
  const lock = lockDir(connection.remoteHome, connection.remoteRoot);
  try {
    let lockOutput = '';
    await deps.runCommand(
      sync,
      'ssh',
      sshArgs(
        connection,
        acquireLockCommand(lock, lockOwner(os.hostname(), site.name || site.domain), lockToken),
      ),
      { onStdout: (c) => (lockOutput += c) },
    );
    const lockResult = parseLockOutput(lockOutput);
    if (!lockResult.ok) {
      throw new Error(
        `Another push to ${environment.label} is running${lockResult.owner ? `: ${lockResult.owner}` : ''}. Try again when it finishes.`,
      );
    }

    // Only the newest push to this folder can be undone, whoever made it
    const marker = lastPushMarker(connection.remoteHome, connection.remoteRoot);
    let markerOutput = '';
    await deps.runCommand(
      sync,
      'ssh',
      sshArgs(connection, `cat ${shellQuote(marker)} 2>/dev/null; true`),
      {
        onStdout: (c) => (markerOutput += c),
      },
    );
    const [newestStamp, ...newestOwner] = markerOutput.trim().split(' ');
    if (newestStamp && newestStamp !== manifest.stamp) {
      return {
        success: false,
        error: `A newer push to ${environment.label} was made${newestOwner.length ? ` by ${newestOwner.join(' ')}` : ''}: undoing this one would overwrite it.`,
      };
    }

    // Nothing the push wrote or deleted may have changed on the server since
    if (manifest.added === null) {
      return {
        success: false,
        error: `This push was made with a local rsync that cannot report what it changed (install rsync 3 with Homebrew), so undo cannot check what changed on ${environment.label} since. The files it replaced are in ${latest.base}-files.`,
      };
    }
    const checks = changedSinceLines(
      Object.fromEntries(
        Object.entries(manifest.pushed || {}).filter(([file]) => isSafeListedPath(file)),
      ),
      (manifest.deleted || []).filter(isSafeListedPath),
    );
    const conflicts = parseChangedSince(
      await runWithPathList(deps, sync, connection, changedSinceCommand(), checks),
    );
    if (conflicts.length) {
      return {
        success: false,
        error: `${conflicts.length} file(s) changed on ${environment.label} after this push, so undoing it would overwrite them.`,
        conflicts,
      };
    }

    // Undo cannot be half-done: it runs to the end once started
    const undoSync = freshSync();
    sendProgress({
      stage: 'files',
      progress: 20,
      message: `Restoring files on ${environment.label}...`,
    });
    await restorePushedFiles(deps, undoSync, connection, {
      localFilesBackup: manifest.hasFilesBackup ? `${latest.base}-files` : null,
      remoteFilesBackup: null,
      added:
        manifest.added && manifest.addedDirs
          ? { files: manifest.added, dirs: manifest.addedDirs }
          : null,
    });
    if (withDatabase) {
      sendProgress({ stage: 'database', progress: 60, message: 'Restoring the database...' });
      await importDatabaseOnServer(deps.runCommand, undoSync, connection, environment, sqlBackup);
      // The push pointed wp-config.php at the pushed tables: point it back
      const previousPrefix = normalizeTablePrefix(manifest.remotePrefixBefore || '');
      if (previousPrefix) {
        await deps.runCommand(
          undoSync,
          'ssh',
          sshArgs(
            connection,
            remoteWp(
              connection,
              environment,
              `--skip-plugins --skip-themes config set table_prefix ${shellQuote(previousPrefix)}`,
            ),
          ),
        );
      }
    }
    if (environment.cacheCommand) {
      try {
        await deps.runCommand(
          undoSync,
          'ssh',
          sshArgs(connection, inRemoteRoot(connection, environment.cacheCommand)),
        );
      } catch {
        // non-fatal, as after a push
      }
    }
    // Undone once: the backups stay until pruned, the manifest and the
    // server's newest-push marker go
    deps.fs.unlinkSync(`${latest.base}.json`);
    await deps.runCommand(
      freshSync(),
      'ssh',
      sshArgs(connection, `rm -f -- ${shellQuote(marker)}`),
    );
    sendProgress({ stage: 'done', progress: 100, message: 'Push undone!' });
    const warning =
      manifest.added === null
        ? 'Files the push added were not removed: the local rsync could not list them (install rsync 3 with Homebrew).'
        : null;
    deps.notify(PRODUCT_NAME, `Undid the last push to ${environment.label}`);
    return {
      success: true,
      warning,
      note: withDatabase ? 'Files and database restored.' : 'Files restored.',
    };
  } catch (error: any) {
    sendProgress({ stage: 'error', progress: 0, message: error.message });
    return { success: false, error: error.message };
  } finally {
    deps.activeSyncs.delete(localSiteId);
    try {
      await deps.runCommand(
        freshSync(),
        'ssh',
        sshArgs(connection, releaseLockCommand(lock, lockToken)),
      );
    } catch {}
    await connection.close();
  }
}
