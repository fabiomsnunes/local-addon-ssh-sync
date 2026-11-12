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
  safeRemoteRelPath,
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

  const startedAt = Date.now();

  // Once the local DB import starts, a cancel/crash leaves the database
  // half-written — these let the catch block restore the pre-pull backup.
  let dbImportStarted = false;
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

  // A leftover preview dry-run must not compete with the real push
  deps.activePreviews.get(localSiteId)?.child?.kill('SIGTERM');

  const startedAt = Date.now();

  // Once the remote DB import starts, a cancel/crash leaves the remote
  // database half-written — lets the catch block restore the backup.
  let remoteImportStarted = false;
  let remoteDatabaseFinished = false;
  let restoredOnServer: string[] = [];
  let restoreWarning: string | null = null;
  let prefixReconciled = true;
  let cancelledLate = false;
  let remoteBackupPath: string | null = null;
  const publicPath = localPublicPath(site);

  try {
    // 1. Safety net for the automatic rollback: the remote database, exported
    //    and kept on this machine (nothing is left on the server).
    if (options.includeDatabase) {
      sendProgress({ stage: 'backup', progress: 3, message: 'Backing up remote database...' });
      dfs.mkdirSync(deps.backupsDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      remoteBackupPath = path.join(
        deps.backupsDir,
        `${localSiteId}-${environment.id}-${stamp}.sql`,
      );
      await downloadRemoteDatabase(run, sync, connection, environment, remoteBackupPath);

      // The rollback restores from this exact file: abort if it looks bad
      // (the server is still untouched at this point).
      const backupSize = dfs.existsSync(remoteBackupPath) ? dfs.statSync(remoteBackupPath).size : 0;
      if (!isLikelyValidSqlDump(backupSize)) {
        throw new Error(
          `Remote database backup looks invalid (${backupSize} bytes) — aborting the push before any change. Your server was not modified.`,
        );
      }
      prunePushBackups(deps.backupsDir, localSiteId, environment.id, dfs);
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
    try {
      if (!selective || (options.files && options.files.length > 0)) {
        const rsyncResult = await run(
          sync,
          rsync.bin,
          buildPushRsyncArgs({
            rsync,
            excludeArgs: excludeArgsFor(environment, options.includeUploads),
            sshCommand: rsyncRemoteShell(connection),
            localPublicPath: publicPath,
            remoteRoot: rsyncRemoteRoot(connection),
            mode: options.mode,
            filesFromPath,
          }),
          {
            // 23/24 = partial transfer — warn instead of failing the whole sync
            okCodes: [23, 24],
            onStdout: makeRsyncProgressParser(rsync, (pct) => {
              // Files = 8–50% of the overall push
              const overall = 8 + Math.round(pct * 0.42);
              sendProgress({
                stage: 'files',
                progress: overall,
                message: `Syncing files to ${environment.label}... ${pct}%`,
              });
            }),
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
      const quoted = options.deletions.map((p) => {
        const q = safeRemoteRelPath(p);
        if (!q) throw new Error(`Unsafe path refused for remote deletion: ${p}`);
        return q;
      });
      for (let i = 0; i < quoted.length; i += 200) {
        const batch = quoted.slice(i, i + 200);
        await run(
          sync,
          'ssh',
          sshArgs(connection, inRemoteRoot(connection, `rm -rf -- ${batch.join(' ')}`)),
        );
      }
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
            restoreWarning = `Push done, but re-enabling what the safe local copy turned off failed on ${environment.label}: check its active plugins${record.options.options?.stripeTestmode !== null ? ' and Stripe mode' : ''}.`;
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

    deps.recordSync(localSiteId, 'push', environment, Date.now() - startedAt);
    sendProgress({
      stage: 'done',
      progress: 100,
      message: warning ? `Push complete — ${warning}` : 'Push complete!',
    });
    deps.notify(
      PRODUCT_NAME,
      warning
        ? `Push complete for ${site.name || site.domain} — ${warning}`
        : `Push complete for ${site.name || site.domain}`,
    );
    const restoredNote = restoredOnServer.length
      ? `Re-enabled on ${environment.label} what the safe local copy had turned off: ${restoredOnServer
          .map((p) => (p === 'stripe-testmode' ? 'Stripe live mode' : p.split('/')[0]))
          .join(', ')}.`
      : null;
    return { success: true, warning, note: restoredNote };
  } catch (error: any) {
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
    if (error instanceof CancelledError) {
      sendProgress({ stage: 'cancelled', progress: 0, message: 'Sync cancelled' });
      return { success: false, cancelled: true, error: 'Sync cancelled' };
    }
    sendProgress({ stage: 'error', progress: 0, message: error.message });
    deps.notify(PRODUCT_NAME, `Push failed for ${site.name || site.domain}`);
    return { success: false, error: error.message };
  } finally {
    deps.activeSyncs.delete(localSiteId);
    await connection.close();
  }
}
