import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  executePull,
  executePush,
  CancelledError,
  ServerEnvironment,
  RemoteConnection,
  SiteInfo,
  SyncOptions,
  SyncParams,
  PullPushDeps,
  ActiveSync,
  RunOptions,
  RsyncInfo,
  executeUndoPush,
  latestPushManifest,
} from './index';

// ---------------------------------------------------------------------------
// Integration test net around executePull / executePush.
//
// The orchestration is exercised end-to-end with injected seams: a fake command
// runner that matches on the command name/args (no real spawn), an in-memory
// connection, fake binary paths, and a real `fs`
// pointed at an os.tmpdir() sandbox. No network, no spawned processes.
//
// The fake runner can simulate rsync progress, write the SQL dump files the
// orchestration size-checks, and fail or cancel at a chosen step — which lets us
// assert the rollback/abort paths that are otherwise impossible to reach in CI.
// ---------------------------------------------------------------------------

const SITE_ID = 'site-1';
const REMOTE_TEMP = '/home/deploy/.ssh-sync-Ab12Cd34';

// Classify a runCommand call into a stable step label used for assertions and
// for failAt/cancelAt matching. Mirrors the actual commands the code issues.
function describeStep(cmd: string, args: string[], opts: RunOptions): string {
  const base = cmd.split('/').pop() || cmd;
  if (base === 'rsync') return 'rsync';
  if (base === 'mysqldump') return 'mysqldump';
  if (base === 'mysql') {
    if ((opts.stdinFile || '').includes('pre-pull-backup')) return 'mysql-restore';
    const sql = args[args.indexOf('-e') + 1] || '';
    if (/^\s*SHOW TABLES/i.test(sql)) return 'mysql-show-tables';
    if (/DROP TABLE/i.test(sql)) return 'mysql-drop-tables';
    return 'mysql-import';
  }
  if (base === 'php') {
    if (args.includes('search-replace')) return 'local-search-replace';
    if (String(args[0]).endsWith('ssh-sync-neutralize.php')) return 'local-neutralize';
    return 'php';
  }
  if (base === 'scp') return 'scp';
  if (base === 'ssh') {
    const remote = args[args.length - 1] || '';
    // Match 'db export' (not 'wp db export') so inserted global flags like
    // --skip-plugins/--skip-themes between `wp` and the subcommand don't break it.
    if (remote.includes('db export')) return 'remote-db-export';
    if (remote.includes('mktemp')) return 'remote-mktemp';
    if (remote.includes('config get table_prefix')) return 'remote-config-prefix';
    if (remote.includes('config set table_prefix')) return 'remote-config-set-prefix';
    if (remote.includes('db import')) return 'remote-db-import';
    if (remote.includes('search-replace')) return 'remote-search-replace';
    if (remote.includes('cache flush')) return 'remote-cache';
    if (remote.includes('SSHSYNC_LOCK')) return 'remote-lock';
    if (remote.includes('.ssh-sync-lock-') && remote.includes('rm -rf')) return 'remote-unlock';
    if (remote.includes('.ssh-sync-files-') && remote.includes('[ -d')) {
      return remote.includes('cp -a') ? 'remote-files-restore' : 'remote-files-backup-check';
    }
    if (remote.includes('.ssh-sync-files-') && remote.includes('mv --'))
      return 'remote-move-to-backup';
    if (remote.includes('.ssh-sync-files-') && remote.includes('rm -rf'))
      return 'remote-files-backup-remove';
    if (remote.includes('rmdir --')) return 'remote-rmdir';
    if (remote.includes('eval-file -')) return 'remote-restore-neutralized';
    if (remote.includes('rm -rf')) return 'remote-rm';
    if (remote.includes('rm -f')) return 'remote-cleanup';
    return 'ssh';
  }
  return base;
}

interface FakeRunnerConfig {
  failAt?: string;
  cancelAt?: string;
  // Bytes written for any stdoutFile (mysqldump). <200 makes a backup "invalid".
  stdoutBytes?: number;
  // Bytes the remote database export downloads as (pull dump and pre-push
  // backup). <200 makes the pre-push backup "invalid".
  remoteDumpBytes?: number;
  // What `wp config get table_prefix` reports for the remote site (pull prefix
  // reconciliation). Unset → empty → reconciliation is skipped.
  remotePrefix?: string;
  // What `SHOW TABLES` reports locally after the import (prefix reconciliation).
  localTables?: string[];
  // SQL written to any stdoutFile (e.g. the local mysqldump on push) instead of
  // filler bytes — lets a test assert transforms applied to the dump.
  pushDumpSql?: string | Buffer;
  // SQL materialized at the local destination of an scp *download* (the remote
  // dump on pull) — lets a test assert transforms applied before the import.
  pullDumpSql?: string | Buffer;
  // JSON the neutralize script prints (safe clone)
  neutralizeOutput?: string;
  // Another push holds the server lock
  lockBusy?: string;
  // The push replaced or deleted files, so the server backup folder exists
  remoteFilesBackupExists?: boolean;
  // rsync --out-format lines the push prints (new files and folders)
  pushOutFormat?: string;
}

interface RecordedCall {
  step: string;
  cmd: string;
  args: string[];
  opts: RunOptions;
}

function makeFakeRunner(cfg: FakeRunnerConfig = {}) {
  const calls: RecordedCall[] = [];
  // Records the on-disk content of each scp source at upload time — so a test
  // can assert what would actually land on the server (after any local transform).
  const uploads: { src: string; content: string; bytes: Buffer }[] = [];
  // Records the content piped into each `mysql` import (stdinFile) at import
  // time — what Local's MySQL would actually receive.
  const imports: { src: string; content: string; bytes: Buffer }[] = [];
  // The pre-push backup is uploaded back only by the rollback: an import that
  // follows that upload is the restore, not the push import.
  let lastUploadWasBackup = false;
  const run = async (sync: ActiveSync, cmd: string, args: string[], opts: RunOptions = {}) => {
    // Faithful to runCommand's contract: a cancelled sync rejects everything.
    if (sync.cancelled) throw new CancelledError();
    let step = describeStep(cmd, args, opts);
    if (step === 'remote-db-import' && lastUploadWasBackup) step = 'remote-db-restore';
    calls.push({ step, cmd, args, opts });

    // Capture what scp would upload (source is the second-to-last arg), or
    // materialize a download (destination is the last arg, a local path).
    if (step === 'scp') {
      const src = args[args.length - 2];
      const dest = args[args.length - 1];
      if (dest.includes(':')) {
        lastUploadWasBackup = src.includes(`${path.sep}backups${path.sep}`);
        try {
          const bytes = fs.readFileSync(src);
          uploads.push({ src, content: bytes.toString('utf8'), bytes });
        } catch {}
      } else {
        fs.writeFileSync(dest, cfg.pullDumpSql ?? 'x'.repeat(cfg.remoteDumpBytes ?? 500));
      }
    }
    if (step === 'mysql-import' && opts.stdinFile) {
      try {
        const bytes = fs.readFileSync(opts.stdinFile);
        imports.push({ src: opts.stdinFile, content: bytes.toString('utf8'), bytes });
      } catch {}
    }

    if (cfg.cancelAt === step) {
      sync.cancelled = true;
      throw new CancelledError();
    }
    if (cfg.failAt === step) {
      throw new Error(`fake failure at ${step}`);
    }

    // Simulate rsync --info=progress2 output so the parser advances progress.
    if (step === 'rsync' && opts.onStdout) {
      opts.onStdout('   1,234,567  42%   1.00MB/s    0:00:01');
    }
    // Remote mktemp (export or upload target) prints the private temp path.
    if ((step === 'remote-db-export' || step === 'remote-mktemp') && opts.onStdout) {
      opts.onStdout(`${REMOTE_TEMP}\n`);
    }
    // Remote table prefix lookup (pull reconciliation).
    if (step === 'remote-config-prefix' && opts.onStdout) {
      opts.onStdout(`${cfg.remotePrefix ?? ''}\n`);
    }
    if (step === 'remote-lock' && opts.onStdout) {
      opts.onStdout(cfg.lockBusy ? `SSHSYNC_LOCK=busy ${cfg.lockBusy}\n` : 'SSHSYNC_LOCK=ok\n');
    }
    if (step === 'remote-files-backup-check' && opts.onStdout) {
      opts.onStdout(cfg.remoteFilesBackupExists ? 'yes\n' : '');
    }
    if (
      step === 'rsync' &&
      cfg.pushOutFormat &&
      opts.onStdout &&
      args.some((a) => a.startsWith('--out-format='))
    ) {
      opts.onStdout(cfg.pushOutFormat);
    }
    // A server backup folder downloaded to this machine: materialize it
    if (step === 'rsync' && String(args[args.length - 2]).includes('.ssh-sync-files-')) {
      const dest = args[args.length - 1];
      fs.mkdirSync(dest, { recursive: true });
      fs.writeFileSync(path.join(dest, 'replaced.php'), 'old');
    }
    if (step === 'remote-restore-neutralized' && opts.onStdout) {
      opts.onStdout('{"restored":["updraftplus/updraftplus.php","stripe-testmode"]}\n');
    }
    if (step === 'local-neutralize' && opts.onStdout) {
      opts.onStdout(
        cfg.neutralizeOutput ??
          '{"deactivated":[],"stripe":false,"record":{"options":{},"sitewideDeactivated":[]}}\n',
      );
    }
    // Local table list after import (pull reconciliation).
    if (step === 'mysql-show-tables' && opts.onStdout) {
      opts.onStdout(`${(cfg.localTables ?? []).join('\n')}\n`);
    }
    // mysqldump / wp db export to a local file → materialize a dump so the
    // size-check (isLikelyValidSqlDump) sees a real file.
    if (opts.stdoutFile) {
      fs.writeFileSync(opts.stdoutFile, cfg.pushDumpSql ?? 'x'.repeat(cfg.stdoutBytes ?? 500));
    }
    return { code: 0, stderr: '' };
  };
  return { run, calls, uploads, imports };
}

const steps = (calls: RecordedCall[]) => calls.map((c) => c.step);

// --- sandbox + deps wiring ---------------------------------------------------

let sandbox: string;
let tempDir: string;
let backupsDir: string;
let neutralizeRecords: Map<string, any>;
let socketPath: string;
let sitePath: string;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-sync-it-'));
  tempDir = path.join(sandbox, 'tmp');
  backupsDir = path.join(sandbox, 'backups');
  neutralizeRecords = new Map();
  fs.mkdirSync(tempDir, { recursive: true });

  // MySQL socket file — its mere existence satisfies the pre-flight check.
  socketPath = path.join(sandbox, 'mysqld.sock');
  fs.writeFileSync(socketPath, '');

  // Local site with a wp-config.php containing a DB_HOST define (the pull
  // search-replace step rewrites it temporarily, then restores it).
  sitePath = path.join(sandbox, 'site');
  const publicPath = path.join(sitePath, 'app', 'public');
  fs.mkdirSync(publicPath, { recursive: true });
  fs.writeFileSync(
    path.join(publicPath, 'wp-config.php'),
    "<?php\ndefine('DB_HOST', 'localhost');\n$table_prefix = 'wp_';\n",
  );
});

afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const FAKE_RSYNC: RsyncInfo = {
  bin: 'rsync',
  supportsProgress2: true,
  supportsProgress: true,
  supportsItemizeChanges: true,
  supportsOutFormat: true,
};

const environment = (overrides: Partial<ServerEnvironment> = {}): ServerEnvironment => ({
  id: 'staging',
  label: 'Staging',
  sshHost: '35.1.2.3',
  sshPort: '12345',
  sshUser: 'deploy',
  auth: 'key',
  remotePath: '/var/www/example.com',
  remoteUrl: 'https://example.com',
  wpCommand: 'wp',
  extraExcludes: [],
  isProduction: false,
  ...overrides,
});

const fakeConnection = (): RemoteConnection => ({
  target: 'deploy@35.1.2.3',
  sshOptions: ['-o', 'Port=12345', '-o', 'ControlPath=/tmp/cm-test', '-o', 'ControlMaster=no'],
  remoteRoot: '/var/www/example.com',
  remoteHome: '/home/deploy',
  siteUrl: 'https://example.com',
  close: vi.fn(async () => {}),
});

const site = (): SiteInfo => ({
  id: SITE_ID,
  name: 'GBD Shop',
  path: sitePath,
  domain: 'gbdshop.local',
  mysql: { database: 'local', user: 'root', password: 'root' },
});

interface DepsOverrides extends Partial<PullPushDeps> {
  runner?: { run: PullPushDeps['runCommand']; calls: RecordedCall[] };
}

function makeDeps(overrides: DepsOverrides = {}): {
  deps: PullPushDeps;
  calls: RecordedCall[];
  progress: any[];
  notify: ReturnType<typeof vi.fn>;
  recordSync: ReturnType<typeof vi.fn>;
} {
  const runner = overrides.runner ?? makeFakeRunner();
  const progress: any[] = [];
  const notify = vi.fn();
  const recordSync = vi.fn();

  const deps: PullPushDeps = {
    fs,
    runCommand: runner.run,
    activeSyncs: new Map(),
    activePreviews: new Map(),
    connectRemote: async () => fakeConnection(),
    getMysqlSocketPath: () => socketPath,
    resolveRsync: () => FAKE_RSYNC,
    findServiceBinary: (_prefixes, bin) => `/fake/bin/${bin}`,
    findWpCliPhar: () => '/fake/wp-cli.phar',
    recordSync,
    notify,
    saveNeutralizeRecord: (id, record) => {
      if (record) neutralizeRecords.set(id, record);
      else neutralizeRecords.delete(id);
    },
    loadNeutralizeRecord: (id) => neutralizeRecords.get(id) ?? null,
    latestPushManifest: (id, environmentId) => latestPushManifest(backupsDir, id, environmentId),
    ensureConfigDir: () => fs.mkdirSync(tempDir, { recursive: true }),
    tempDir,
    backupsDir,
    sendProgress: (p) => progress.push(p),
    ...overrides,
  };

  return { deps, calls: runner.calls, progress, notify, recordSync };
}

const pullParams = (options: SyncOptions = { includeDatabase: true }): SyncParams => ({
  localSiteId: SITE_ID,
  site: site(),
  environment: environment(),
  options,
});

const pushParams = (
  options: SyncOptions = { includeDatabase: true },
  environmentOverrides: Partial<ServerEnvironment> = {},
): SyncParams => ({
  localSiteId: SITE_ID,
  site: site(),
  environment: environment(environmentOverrides),
  options,
});

// ---------------------------------------------------------------------------

describe('wp db export hardening (#2)', () => {
  it('runs the remote DB exports with --skip-plugins --skip-themes', async () => {
    // A broken/heavy plugin must not be able to break the remote DB export that
    // backs the pull, nor the pre-push export that is our rollback safety net.
    const pull = makeDeps();
    await executePull(pullParams(), pull.deps);
    const pullExport = pull.calls.find((c) => c.step === 'remote-db-export');
    expect(pullExport).toBeDefined();
    const pullCmd = pullExport!.args[pullExport!.args.length - 1];
    expect(pullCmd).toContain('--skip-plugins');
    expect(pullCmd).toContain('--skip-themes');

    const push = makeDeps();
    await executePush(pushParams(), push.deps);
    const backupExport = push.calls.find((c) => c.step === 'remote-db-export');
    expect(backupExport).toBeDefined();
    const backupCmd = backupExport!.args[backupExport!.args.length - 1];
    expect(backupCmd).toContain('--skip-plugins');
    expect(backupCmd).toContain('--skip-themes');
  });
});

describe('executePull', () => {
  it('happy path: files + DB + search-replace, records + notifies success', async () => {
    const { deps, calls, progress, notify, recordSync } = makeDeps();
    const result = await executePull(pullParams(), deps);

    expect(result).toEqual({
      success: true,
      warning: null,
      note: expect.stringContaining('Made the copy safe'),
    });

    const labels = steps(calls);
    expect(labels).toContain('rsync');
    expect(labels).toContain('mysqldump'); // pre-pull local backup
    expect(labels).toContain('remote-db-export');
    expect(labels).toContain('scp');
    expect(labels).toContain('mysql-import');
    expect(labels).toContain('local-search-replace');
    expect(labels).not.toContain('mysql-restore'); // no rollback on success

    // rsync progress was parsed and surfaced
    expect(progress.some((p) => p.stage === 'files' && /42%/.test(p.message))).toBe(true);
    expect(progress.some((p) => p.stage === 'done' && p.progress === 100)).toBe(true);

    expect(recordSync).toHaveBeenCalledWith(
      SITE_ID,
      'pull',
      expect.objectContaining({ id: 'staging' }),
      expect.any(Number),
    );
    expect(notify).toHaveBeenCalledWith('SSH Sync', expect.stringContaining('Pull complete'));

    // wp-config.php restored to its original content
    const wpConfig = fs.readFileSync(path.join(sitePath, 'app', 'public', 'wp-config.php'), 'utf8');
    expect(wpConfig).toContain("define('DB_HOST', 'localhost')");
    expect(wpConfig).not.toContain(socketPath);
    expect(deps.activeSyncs.size).toBe(0); // unregistered in finally
  });

  it('makes the copy safe after the import: plugins, Stripe, mu-plugin, environment type', async () => {
    const runner = makeFakeRunner({
      neutralizeOutput:
        '{"deactivated":["updraftplus/updraftplus.php","fluent-smtp/fluent-smtp.php"],"stripe":true,"record":{"options":{"options":{"deactivated":["updraftplus/updraftplus.php","fluent-smtp/fluent-smtp.php"],"stripeTestmode":"no"}},"sitewideDeactivated":[]}}\n',
    });
    const { deps } = makeDeps({ runner });
    const result = await executePull(pullParams(), deps);

    expect(result.success).toBe(true);
    expect(result.note).toBe(
      'Made the copy safe: deactivated updraftplus, fluent-smtp; put Stripe in test mode; blocked outgoing requests and email.',
    );
    const labels = steps(runner.calls);
    expect(labels.indexOf('local-neutralize')).toBeGreaterThan(labels.indexOf('mysql-import'));
    const neutralize = runner.calls.find((c) => c.step === 'local-neutralize')!;
    expect(neutralize.args.slice(1, 6)).toEqual([socketPath, 'root', 'root', 'local', 'wp_']);
    expect(JSON.parse(neutralize.args[6])).toContain('updraftplus');
    // The script is a temp file, removed afterwards
    expect(fs.existsSync(neutralize.args[0])).toBe(false);

    const publicPath = path.join(sitePath, 'app', 'public');
    const muPlugin = path.join(publicPath, 'wp-content', 'mu-plugins', 'ssh-sync-local-safety.php');
    expect(fs.readFileSync(muPlugin, 'utf8')).toContain("add_filter( 'pre_wp_mail'");
    const wpConfig = fs.readFileSync(path.join(publicPath, 'wp-config.php'), 'utf8');
    expect(wpConfig).toContain("define( 'SSH_SYNC_LOCAL_COPY', true );");
    expect(wpConfig).toContain("define( 'WP_ENVIRONMENT_TYPE', 'local' );");
    // What was changed is kept for a later database push to this environment
    expect(neutralizeRecords.get(SITE_ID).options.options.stripeTestmode).toBe('no');
    expect(neutralizeRecords.get(SITE_ID).environmentId).toBe('staging');
  });

  it('installs the safety net before anything is transferred', async () => {
    const publicPath = path.join(sitePath, 'app', 'public');
    const muPlugin = path.join(publicPath, 'wp-content', 'mu-plugins', 'ssh-sync-local-safety.php');
    let presentAtRsync = false;
    const runner = makeFakeRunner();
    const { deps } = makeDeps({ runner });
    deps.runCommand = async (sync, cmd, args, opts) => {
      if (cmd === 'rsync') presentAtRsync = fs.existsSync(muPlugin);
      return runner.run(sync, cmd, args, opts);
    };
    await executePull(pullParams(), deps);
    expect(presentAtRsync).toBe(true);
  });

  it('neutralizes with the adopted remote prefix', async () => {
    const runner = makeFakeRunner({
      remotePrefix: 'wp0x_',
      localTables: ['wp0x_options', 'wp_options'],
    });
    const { deps } = makeDeps({ runner });
    await executePull(pullParams(), deps);
    const neutralize = runner.calls.find((c) => c.step === 'local-neutralize')!;
    expect(neutralize.args[5]).toBe('wp0x_');
  });

  it('rolls the database back when the copy cannot be made safe', async () => {
    const runner = makeFakeRunner({ failAt: 'local-neutralize' });
    const { deps } = makeDeps({ runner });
    const result = await executePull(pullParams(), deps);
    expect(result.success).toBe(false);
    expect(steps(runner.calls)).toContain('mysql-restore');
  });

  it('a files-only pull still installs the mu-plugin, without touching the database', async () => {
    const runner = makeFakeRunner();
    const { deps } = makeDeps({ runner });
    const result = await executePull(pullParams({ includeDatabase: false }), deps);
    expect(result.note).toBe('Made the copy safe: blocked outgoing requests and email.');
    expect(steps(runner.calls)).not.toContain('local-neutralize');
  });

  it('skips the safety step when makeSafe is false', async () => {
    const runner = makeFakeRunner();
    const { deps } = makeDeps({ runner });
    neutralizeRecords.set(SITE_ID, { options: { options: {} }, sitewideDeactivated: {} });
    const result = await executePull(pullParams({ includeDatabase: true, makeSafe: false }), deps);
    expect(result.note).toBeNull();
    expect(steps(runner.calls)).not.toContain('local-neutralize');
    // The pulled database is untouched, so there is nothing to put back on a push
    expect(neutralizeRecords.has(SITE_ID)).toBe(false);
  });

  it('removes the remote dump and closes the connection, even when the download fails', async () => {
    const connection = fakeConnection();
    const { deps, calls } = makeDeps({
      connectRemote: async () => connection,
      runner: makeFakeRunner({ failAt: 'scp' }),
    });
    const result = await executePull(pullParams(), deps);

    expect(result.success).toBe(false);
    const cleanup = calls.find((c) => c.step === 'remote-cleanup');
    expect(cleanup?.args[cleanup.args.length - 1]).toBe(`rm -f -- '${REMOTE_TEMP}'`);
    expect(connection.close).toHaveBeenCalledOnce();
    expect(deps.activeSyncs.size).toBe(0);
  });

  it('syncs from the resolved WordPress root with the environment excludes', async () => {
    const { deps, calls } = makeDeps();
    const params = pullParams({ includeDatabase: false });
    params.environment.extraExcludes = ['wp-content/litespeed/'];
    await executePull(params, deps);
    const rsync = calls.find((c) => c.step === 'rsync')!;
    expect(rsync.args).toContain('deploy@35.1.2.3:/var/www/example.com/');
    expect(rsync.args).toContain('--exclude=wp-content/litespeed/');
    expect(rsync.args).toContain('--exclude=wp-content/uploads/');
  });

  it('downgrades MariaDB 11.4 collations in the downloaded dump before importing (MySQL 8)', async () => {
    // MariaDB 11.4+ emits utf8mb4_uca1400_* collations Local's MySQL 8
    // can't import ("Unknown collation: 'utf8mb4_uca1400_ai_ci'").
    const runner = makeFakeRunner({
      pullDumpSql:
        'CREATE TABLE `wp_posts` (`id` bigint) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;\n',
    });
    const { deps } = makeDeps({ runner });

    const result = await executePull(pullParams(), deps);
    expect(result.success).toBe(true);

    const imported = runner.imports.find((i) => i.src.endsWith('-remote.sql'));
    expect(imported).toBeDefined();
    expect(imported!.content).toContain('utf8mb4_unicode_520_ci');
    expect(imported!.content).not.toContain('utf8mb4_uca1400_ai_ci');
  });

  it('keeps binary column bytes intact through the collation rewrite on pull', async () => {
    // Wordfence stores IPs as varbinary(16); mysqldump writes them as raw bytes
    // that are not valid UTF-8. Decoding the dump as utf8 turned them into
    // U+FFFD, collapsing distinct IPs into one → "Duplicate entry ... PRIMARY".
    const binaryIp = Buffer.from([0x00, 0x00, 0xff, 0xff, 0xc0, 0xa8, 0x80, 0x9f]);
    const dump = Buffer.concat([
      Buffer.from(
        "CREATE TABLE `wp_wfblockediplog` (`IP` varbinary(16)) COLLATE=utf8mb4_uca1400_ai_ci;\nINSERT INTO `wp_wfblockediplog` VALUES ('",
      ),
      binaryIp,
      Buffer.from("'),('åäö');\n"),
    ]);
    const runner = makeFakeRunner({ pullDumpSql: dump });
    const { deps } = makeDeps({ runner });

    const result = await executePull(pullParams(), deps);
    expect(result.success).toBe(true);

    const imported = runner.imports.find((i) => i.src.endsWith('-remote.sql'))!;
    expect(imported.bytes.includes(binaryIp)).toBe(true);
    expect(imported.content).toContain('utf8mb4_unicode_520_ci');
    expect(imported.content).toContain('åäö');
  });

  it('adopts the remote table prefix and drops stale local-prefix tables', async () => {
    const wpConfigPath = path.join(sitePath, 'app', 'public', 'wp-config.php');
    fs.writeFileSync(
      wpConfigPath,
      "<?php\ndefine('DB_HOST', 'localhost');\n$table_prefix = 'wp_';\n",
    );

    const { deps, calls } = makeDeps({
      runner: makeFakeRunner({
        remotePrefix: 'wp_pk_',
        // After import: the imported production tables + the old local ones.
        localTables: ['wp_options', 'wp_posts', 'wp_pk_options', 'wp_pk_posts'],
      }),
    });
    const result = await executePull(pullParams(), deps);
    expect(result.success).toBe(true);

    const labels = steps(calls);
    expect(labels).toContain('remote-config-prefix');
    expect(labels).toContain('mysql-show-tables');
    expect(labels).toContain('mysql-drop-tables');

    // The drop targets only the stale old-prefix tables, never the imported ones.
    const dropCall = calls.find((c) => c.step === 'mysql-drop-tables')!;
    const dropSql = dropCall.args[dropCall.args.indexOf('-e') + 1];
    expect(dropSql).toContain('`wp_options`');
    expect(dropSql).toContain('`wp_posts`');
    expect(dropSql).not.toContain('`wp_pk_options`');
    expect(dropSql).not.toContain('`wp_pk_posts`');

    // wp-config now points WordPress at the imported tables (persisted, not reverted).
    const wpConfig = fs.readFileSync(wpConfigPath, 'utf8');
    expect(wpConfig).toContain("$table_prefix = 'wp_pk_';");
    expect(wpConfig).not.toContain(socketPath); // socket edit still reverted
  });

  it('leaves the prefix untouched when local and remote already match', async () => {
    const wpConfigPath = path.join(sitePath, 'app', 'public', 'wp-config.php');
    fs.writeFileSync(
      wpConfigPath,
      "<?php\ndefine('DB_HOST', 'localhost');\n$table_prefix = 'wp_';\n",
    );

    const { deps, calls } = makeDeps({
      runner: makeFakeRunner({ remotePrefix: 'wp_', localTables: ['wp_options', 'wp_posts'] }),
    });
    const result = await executePull(pullParams(), deps);
    expect(result.success).toBe(true);

    const labels = steps(calls);
    expect(labels).toContain('remote-config-prefix'); // prefix was checked
    expect(labels).not.toContain('mysql-drop-tables'); // ...but nothing to reconcile
    expect(fs.readFileSync(wpConfigPath, 'utf8')).toContain("$table_prefix = 'wp_';");
  });

  it('a failed remote prefix lookup is skipped, not rolled back', async () => {
    const wpConfigPath = path.join(sitePath, 'app', 'public', 'wp-config.php');
    fs.writeFileSync(
      wpConfigPath,
      "<?php\ndefine('DB_HOST', 'localhost');\n$table_prefix = 'wp_';\n",
    );

    const { deps, calls } = makeDeps({
      runner: makeFakeRunner({ failAt: 'remote-config-prefix' }),
    });
    const result = await executePull(pullParams(), deps);

    // The import succeeded — a prefix-check blip must not undo it.
    expect(result.success).toBe(true);
    const labels = steps(calls);
    expect(labels).toContain('mysql-import');
    expect(labels).not.toContain('mysql-restore'); // no rollback
    expect(labels).not.toContain('mysql-drop-tables'); // reconciliation skipped
  });

  it('clears compiled Sage/Acorn caches after a pull, keeping the dirs + .gitkeep', async () => {
    const theme = path.join(sitePath, 'app', 'public', 'wp-content', 'themes', 'pk');
    const views = path.join(theme, 'storage', 'framework', 'views');
    const cache = path.join(theme, 'storage', 'framework', 'cache');
    const boot = path.join(theme, 'bootstrap', 'cache');
    for (const d of [views, cache, boot]) fs.mkdirSync(d, { recursive: true });
    // Compiled artifacts (baked production paths) — must be removed.
    fs.writeFileSync(path.join(views, 'a1b2c3.php'), '<?php /* /www/prod/... */');
    fs.writeFileSync(path.join(cache, 'config.php'), "<?php return ['base'=>'/www/prod'];");
    fs.writeFileSync(path.join(boot, 'packages.php'), '<?php return [];');
    // Non-.php scaffolding — must be kept so the dir still exists for Acorn.
    fs.writeFileSync(path.join(cache, '.gitkeep'), '');
    fs.writeFileSync(path.join(cache, '.gitignore'), '*');

    const { deps } = makeDeps();
    const result = await executePull(pullParams(), deps);
    expect(result.success).toBe(true);

    expect(fs.existsSync(path.join(views, 'a1b2c3.php'))).toBe(false);
    expect(fs.existsSync(path.join(cache, 'config.php'))).toBe(false);
    expect(fs.existsSync(path.join(boot, 'packages.php'))).toBe(false);
    // dirs + non-php scaffolding survive
    expect(fs.existsSync(cache)).toBe(true);
    expect(fs.existsSync(path.join(cache, '.gitkeep'))).toBe(true);
    expect(fs.existsSync(path.join(cache, '.gitignore'))).toBe(true);
  });

  it('cache clear is a no-op (and pull still succeeds) for a non-Sage site', async () => {
    // beforeEach's wp-config has no theme/storage dirs at all.
    const { deps } = makeDeps();
    const result = await executePull(pullParams(), deps);
    expect(result.success).toBe(true);
  });

  it('import failure rolls back the local DB from the pre-pull backup', async () => {
    const { deps, calls, notify } = makeDeps({
      runner: makeFakeRunner({ failAt: 'mysql-import' }),
    });
    const result = await executePull(pullParams(), deps);

    expect(result.success).toBe(false);
    expect(result.error).toContain('fake failure at mysql-import');
    expect(steps(calls)).toContain('mysql-restore'); // local DB restored
    expect(notify).toHaveBeenCalledWith(
      'SSH Sync',
      expect.stringContaining('was restored from backup'),
    );
    expect(deps.activeSyncs.size).toBe(0);
  });

  it('cancel during import triggers rollback and reports cancelled', async () => {
    const { deps, calls } = makeDeps({ runner: makeFakeRunner({ cancelAt: 'mysql-import' }) });
    const result = await executePull(pullParams(), deps);

    expect(result).toMatchObject({ success: false, cancelled: true });
    // Restore runs on a FRESH ActiveSync even though the original was cancelled
    expect(steps(calls)).toContain('mysql-restore');
  });

  it('aborts before import when the local backup looks empty/truncated', async () => {
    const { deps, calls } = makeDeps({ runner: makeFakeRunner({ stdoutBytes: 10 }) });
    const result = await executePull(pullParams(), deps);

    expect(result.success).toBe(false);
    expect(result.error).toContain('backup looks invalid');
    const labels = steps(calls);
    expect(labels).toContain('mysqldump');
    expect(labels).not.toContain('mysql-import'); // never overwrote the DB
    expect(labels).not.toContain('mysql-restore'); // nothing to roll back
  });

  it('aborts and leaves no sync registered when the remote pre-flight fails', async () => {
    const { deps, calls } = makeDeps({
      connectRemote: async () => {
        throw new Error('Could not connect to deploy@35.1.2.3 over SSH.');
      },
    });
    const result = await executePull(pullParams(), deps);

    expect(result).toEqual({
      success: false,
      error: 'Could not connect to deploy@35.1.2.3 over SSH.',
    });
    expect(calls).toHaveLength(0); // nothing ran
    expect(deps.activeSyncs.size).toBe(0);
  });

  it('refuses to start when a sync is already running for the site', async () => {
    const { deps, calls } = makeDeps();
    deps.activeSyncs.set(SITE_ID, { cancelled: false, child: null });

    const result = await executePull(pullParams(), deps);

    expect(result).toEqual({ success: false, error: 'A sync is already running for this site' });
    expect(calls).toHaveLength(0);
  });

  it('refuses a second concurrent sync started while the first is still in pre-flight', async () => {
    // Gate pre-flight so the first sync is suspended between the guard check and
    // registration — the exact window a TOCTOU race could exploit.
    let releasePreflight!: () => void;
    const preflightGate = new Promise<void>((res) => {
      releasePreflight = res;
    });
    let preflightCalls = 0;
    const { deps } = makeDeps({
      connectRemote: async () => {
        preflightCalls++;
        await preflightGate;
        return fakeConnection();
      },
    });

    const first = executePull(pullParams(), deps); // suspends inside pre-flight
    const second = executePull(pullParams(), deps); // must hit the guard, not pre-flight

    // A macrotask marker: a correctly-guarded second call settles on a microtask
    // and wins this race; a racing (buggy) second call is still suspended in its
    // own pre-flight when the marker fires.
    const pendingMarker = Symbol('pending');
    const settled = await Promise.race([
      second,
      new Promise((res) => setImmediate(() => res(pendingMarker))),
    ]);

    expect(settled).toEqual({ success: false, error: 'A sync is already running for this site' });
    expect(preflightCalls).toBe(1); // guard short-circuited before a 2nd pre-flight

    releasePreflight();
    expect((await first).success).toBe(true);
  });

  it('preserves the original sync error when wp-config restore fails in the finally', async () => {
    // fs whose unlinkSync throws only for the wp-config backup — simulates the
    // restore step failing inside the finally block.
    const fsThatFailsBackupUnlink = {
      ...fs,
      unlinkSync: (p: fs.PathLike, ...rest: any[]) => {
        if (String(p).endsWith('.ssh-sync-bak')) {
          throw new Error('simulated unlink failure');
        }
        return (fs.unlinkSync as any)(p, ...rest);
      },
    } as any;
    const { deps, calls } = makeDeps({
      fs: fsThatFailsBackupUnlink,
      runner: makeFakeRunner({ failAt: 'local-search-replace' }),
    });

    const result = await executePull(pullParams(), deps);

    expect(result.success).toBe(false);
    // The masking bug would surface 'simulated unlink failure' here instead.
    expect(result.error).toContain('fake failure at local-search-replace');
    expect(steps(calls)).toContain('mysql-restore'); // rollback still ran
  });
});

describe('executePush', () => {
  it('happy path: backup to this machine + files + DB + search-replace + cache command', async () => {
    const { deps, calls, progress, notify, recordSync } = makeDeps();
    const params = pushParams({ includeDatabase: true }, { cacheCommand: 'wp cache flush' });
    const result = await executePush(params, deps);

    expect(result).toEqual({ success: true, warning: null, note: null });

    const labels = steps(calls);
    expect(labels.indexOf('remote-db-export')).toBeLessThan(labels.indexOf('rsync')); // backup first
    expect(labels).toContain('rsync');
    expect(labels).toContain('mysqldump'); // local export
    expect(labels).toContain('remote-mktemp'); // private upload target
    expect(labels).toContain('remote-db-import');
    expect(labels).toContain('remote-search-replace');
    expect(labels).toContain('remote-cache');
    expect(labels).not.toContain('remote-db-restore'); // no rollback on success

    // The pre-push backup lives on this machine; every remote temp file is removed
    const kept = fs.readdirSync(backupsDir).filter((f) => f.startsWith(`${SITE_ID}-staging-`));
    expect(kept.filter((f) => f.endsWith('.sql'))).toHaveLength(1);
    expect(kept.filter((f) => f.endsWith('.json'))).toHaveLength(1);
    const cleanups = calls.filter((c) => c.step === 'remote-cleanup');
    expect(cleanups).toHaveLength(2); // the backup export and the uploaded dump
    for (const c of cleanups) expect(c.args[c.args.length - 1]).toContain(REMOTE_TEMP);

    expect(recordSync).toHaveBeenCalledWith(
      SITE_ID,
      'push',
      expect.objectContaining({ id: 'staging' }),
      expect.any(Number),
    );
    expect(notify).toHaveBeenCalledWith('SSH Sync', expect.stringContaining('Push complete'));
    expect(progress.some((p) => p.stage === 'done' && p.progress === 100)).toBe(true);
    expect(deps.activeSyncs.size).toBe(0);
  });

  const pulledRecord = (environmentId = 'staging') => ({
    environmentId,
    options: {
      options: {
        deactivated: ['updraftplus/updraftplus.php', 'gone-plugin/gone.php'],
        stripeTestmode: 'no',
      },
    },
    sitewideDeactivated: {},
  });
  const installPluginLocally = (folder: string) =>
    fs.mkdirSync(path.join(sitePath, 'app', 'public', 'wp-content', 'plugins', folder), {
      recursive: true,
    });

  it('a database push re-enables on the pulled server what the safe copy turned off', async () => {
    neutralizeRecords.set(SITE_ID, pulledRecord());
    installPluginLocally('updraftplus');
    const runner = makeFakeRunner();
    const { deps } = makeDeps({ runner });
    const result = await executePush(pushParams(), deps);
    expect(result.success).toBe(true);
    const labels = steps(runner.calls);
    expect(labels.indexOf('remote-restore-neutralized')).toBeGreaterThan(
      labels.indexOf('remote-search-replace'),
    );
    const restore = runner.calls.find((c) => c.step === 'remote-restore-neutralized')!;
    expect(restore.args[restore.args.length - 1]).toContain(
      '--skip-plugins --skip-themes eval-file -',
    );
    expect(fs.existsSync(restore.opts.stdinFile!)).toBe(false); // temp script removed
    expect(result.note).toBe(
      'Re-enabled on Staging what the safe local copy had turned off: updraftplus, Stripe live mode.',
    );
    // A plugin deleted locally stays off on the server, and the user is told
    expect(result.warning).toBe('Left off on Staging (deleted locally): gone-plugin.');
  });

  it('never restores on an environment other than the one the copy came from', async () => {
    neutralizeRecords.set(SITE_ID, pulledRecord('production'));
    installPluginLocally('updraftplus');
    const runner = makeFakeRunner();
    const { deps } = makeDeps({ runner });
    const result = await executePush(pushParams(), deps);
    expect(result.success).toBe(true);
    expect(steps(runner.calls)).not.toContain('remote-restore-neutralized');
  });

  it('a failed restore warns instead of rolling back a finished push', async () => {
    neutralizeRecords.set(SITE_ID, pulledRecord());
    installPluginLocally('updraftplus');
    const runner = makeFakeRunner({ failAt: 'remote-restore-neutralized' });
    const { deps } = makeDeps({ runner });
    const result = await executePush(pushParams(), deps);
    expect(result.success).toBe(true);
    expect(result.warning).toMatch(/re-enabling what the safe local copy turned off failed/);
    expect(steps(runner.calls)).not.toContain('remote-db-restore');
  });

  it('skips the restore when the table prefix could not be reconciled', async () => {
    neutralizeRecords.set(SITE_ID, pulledRecord());
    installPluginLocally('updraftplus');
    fs.writeFileSync(
      path.join(sitePath, 'app', 'public', 'wp-config.php'),
      "<?php\ndefine('DB_HOST', 'localhost');\n$table_prefix = 'wp_';\n",
    );
    const runner = makeFakeRunner({ remotePrefix: 'abc_', failAt: 'remote-config-set-prefix' });
    const { deps } = makeDeps({ runner });
    const result = await executePush(pushParams(), deps);
    expect(result.success).toBe(true);
    expect(steps(runner.calls)).not.toContain('remote-restore-neutralized');
    expect(result.warning).toMatch(/table prefix could not be updated/);
  });

  it('a files-only push never touches the server database for the safe copy', async () => {
    neutralizeRecords.set(SITE_ID, pulledRecord());
    const runner = makeFakeRunner();
    const { deps } = makeDeps({ runner });
    await executePush(pushParams({ includeDatabase: false }), deps);
    expect(steps(runner.calls)).not.toContain('remote-restore-neutralized');
  });

  it('refuses to push while another push holds the server lock', async () => {
    const runner = makeFakeRunner({ lockBusy: 'other-mac (site) since 2026-11-12T10:00:00Z' });
    const { deps } = makeDeps({ runner });
    const result = await executePush(pushParams(), deps);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Another push to Staging is running: other-mac/);
    const labels = steps(runner.calls);
    expect(labels).not.toContain('rsync');
    expect(labels).not.toContain('remote-db-export');
    // Not our lock: never released by us
    expect(labels).not.toContain('remote-unlock');
  });

  it('takes the lock first and always releases it', async () => {
    const runner = makeFakeRunner({ failAt: 'remote-db-import' });
    const { deps } = makeDeps({ runner });
    await executePush(pushParams(), deps);
    const labels = steps(runner.calls);
    expect(labels[0]).toBe('remote-lock');
    expect(labels).toContain('remote-unlock');
  });

  it('backs up replaced files, records added ones, and leaves nothing on the server', async () => {
    const runner = makeFakeRunner({
      remoteFilesBackupExists: true,
      pushOutFormat:
        'SSHSYNC|<f+++++++++|wp-content/new.php\nSSHSYNC|cd+++++++++|wp-content/newdir/\nSSHSYNC|<f.st......|wp-content/changed.php\n',
    });
    const { deps } = makeDeps({ runner });
    const result = await executePush(
      pushParams({ includeDatabase: false, files: ['wp-content/new.php'], deletions: ['old.php'] }),
      deps,
    );
    expect(result.success).toBe(true);
    const push = runner.calls.find((c) => c.step === 'rsync')!;
    expect(push.args).toContain('--backup');
    expect(push.args.some((a) => a.startsWith('--backup-dir=/home/deploy/.ssh-sync-files-'))).toBe(
      true,
    );
    const labels = steps(runner.calls);
    expect(labels).toContain('remote-move-to-backup'); // deletions are moved, not removed
    expect(labels).not.toContain('remote-rm');
    expect(labels).toContain('remote-files-backup-remove');
    const latest = latestPushManifest(backupsDir, SITE_ID, 'staging')!;
    expect(latest.manifest).toMatchObject({
      environmentId: 'staging',
      added: ['wp-content/new.php'],
      addedDirs: ['wp-content/newdir'],
      hasFilesBackup: true,
      hasDatabaseBackup: false,
    });
    expect(fs.existsSync(`${latest.base}-files/replaced.php`)).toBe(true);
  });

  it('puts the files back when the database step fails', async () => {
    const runner = makeFakeRunner({
      failAt: 'remote-db-import',
      remoteFilesBackupExists: true,
      pushOutFormat: 'SSHSYNC|<f+++++++++|wp-content/new.php\n',
    });
    const { deps, notify } = makeDeps({ runner });
    const result = await executePush(pushParams(), deps);
    expect(result.success).toBe(false);
    const labels = steps(runner.calls);
    expect(labels).toContain('remote-db-restore');
    // the downloaded backup goes back up, the added file is removed
    const restoreUpload = runner.calls.filter((c) => c.step === 'rsync').pop()!;
    expect(restoreUpload.args[restoreUpload.args.length - 2]).toMatch(/-files\/$/);
    const removal = runner.calls.find(
      (c) =>
        c.step === 'remote-cleanup' &&
        String(c.args[c.args.length - 1]).includes('wp-content/new.php'),
    );
    expect(removal).toBeDefined();
    expect(notify).toHaveBeenCalledWith('SSH Sync', expect.stringContaining('were put back'));
  });

  it('undo restores the files and the database of the last push, once', async () => {
    const first = makeFakeRunner({
      remoteFilesBackupExists: true,
      pushOutFormat: 'SSHSYNC|<f+++++++++|wp-content/new.php\n',
    });
    const { deps } = makeDeps({ runner: first });
    expect((await executePush(pushParams(), deps)).success).toBe(true);

    const undoRunner = makeFakeRunner();
    const undo = makeDeps({ runner: undoRunner });
    const result = await executeUndoPush(
      { localSiteId: SITE_ID, site: site(), environment: environment() },
      undo.deps,
    );
    expect(result).toMatchObject({ success: true, note: 'Files and database restored.' });
    const labels = steps(undoRunner.calls);
    // the import of the pre-push backup (labelled a restore by the fake runner)
    expect(labels).toContain('remote-db-restore');
    expect(labels).toContain('remote-unlock');
    // The manifest is gone: the same push cannot be undone twice
    expect(latestPushManifest(backupsDir, SITE_ID, 'staging')).toBeNull();
  });

  it('undo of a production database push needs the typed domain', async () => {
    const { deps } = makeDeps({ runner: makeFakeRunner() });
    await executePush(
      pushParams(
        { includeDatabase: true, migrationMode: true, confirmDomain: 'example.com' },
        { isProduction: true, id: 'staging' },
      ),
      deps,
    );
    const result = await executeUndoPush(
      { localSiteId: SITE_ID, site: site(), environment: environment({ isProduction: true }) },
      makeDeps({ runner: makeFakeRunner() }).deps,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Type example\.com to confirm/);
  });

  it('files-only push skips the database backup entirely', async () => {
    const { deps, calls } = makeDeps();
    const result = await executePush(pushParams({ includeDatabase: false }), deps);
    expect(result.success).toBe(true);
    const labels = steps(calls);
    expect(labels).toContain('rsync');
    expect(labels).not.toContain('remote-db-export');
    expect(labels).not.toContain('remote-db-import');
  });

  it('refuses a production database push without Migration mode, before connecting', async () => {
    const connectRemote = vi.fn(async () => fakeConnection());
    const { deps, calls } = makeDeps({ connectRemote });
    const result = await executePush(
      pushParams({ includeDatabase: true }, { isProduction: true }),
      deps,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Migration mode/);
    expect(connectRemote).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('allows a production database push in Migration mode with the typed domain', async () => {
    const { deps } = makeDeps();
    const result = await executePush(
      pushParams(
        { includeDatabase: true, migrationMode: true, confirmDomain: 'example.com' },
        { isProduction: true },
      ),
      deps,
    );
    expect(result.success).toBe(true);
  });

  it('does not restore the backup when the upload fails before the server DB changed', async () => {
    const { deps, calls } = makeDeps({ runner: makeFakeRunner({ failAt: 'scp' }) });
    // The first scp is the backup download; fail only uploads by failing the second one
    let scpSeen = 0;
    const runner = makeFakeRunner();
    deps.runCommand = async (sync, cmd, args, opts) => {
      if (cmd === 'scp' && ++scpSeen === 2) throw new Error('upload dropped');
      return runner.run(sync, cmd, args, opts);
    };
    const result = await executePush(pushParams(), deps);
    expect(result.success).toBe(false);
    expect(result.error).toContain('upload dropped');
    expect(steps(runner.calls)).not.toContain('remote-db-import');
    expect(steps(runner.calls)).not.toContain('remote-db-restore');
    expect(calls).toHaveLength(0);
  });

  it('a cancel during the cache command completes the push instead of rolling it back', async () => {
    const { deps, calls } = makeDeps({ runner: makeFakeRunner({ cancelAt: 'remote-cache' }) });
    const result = await executePush(
      pushParams({ includeDatabase: true }, { cacheCommand: 'wp cache flush' }),
      deps,
    );
    expect(result.success).toBe(true);
    expect(result.warning).toMatch(/Cancel arrived after the server was updated/);
    expect(steps(calls)).not.toContain('remote-db-restore');
  });

  it('runs the server DB import and search-replace even after a cancel request', async () => {
    // A cancel cannot stop `wp db import` on the server, so the import and the
    // search-replace run on their own ActiveSync and the push completes.
    const runner = makeFakeRunner();
    const { deps } = makeDeps({ runner });
    deps.runCommand = async (sync, cmd, args, opts) => {
      const result = await runner.run(sync, cmd, args, opts);
      if (String(args[args.length - 1]).includes('db import')) {
        deps.activeSyncs.get(SITE_ID)!.cancelled = true;
      }
      return result;
    };
    const result = await executePush(pushParams(), deps);
    expect(steps(runner.calls)).toContain('remote-search-replace');
    expect(steps(runner.calls)).not.toContain('remote-db-restore');
    expect(result.success).toBe(true);
    const sr = runner.calls.find((c) => c.step === 'remote-search-replace')!;
    expect(sr.args[sr.args.length - 1]).toContain('--skip-plugins --skip-themes search-replace');
  });

  it('downgrades MySQL 8 collations in the dump before uploading (MariaDB servers)', async () => {
    // Local (MySQL 8) emits utf8mb4_0900_* collations MariaDB can't import.
    const runner = makeFakeRunner({
      pushDumpSql:
        'CREATE TABLE `wp_posts` (`id` bigint) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;\n',
    });
    const { deps } = makeDeps({ runner });

    const result = await executePush(pushParams(), deps);
    expect(result.success).toBe(true);

    const upload = runner.uploads.find((u) => u.src.endsWith('-local.sql'));
    expect(upload).toBeDefined();
    expect(upload!.content).toContain('utf8mb4_unicode_520_ci');
    expect(upload!.content).not.toContain('utf8mb4_0900_ai_ci');
  });

  it('keeps binary column bytes intact through the collation rewrite on push', async () => {
    const binaryIp = Buffer.from([0x00, 0x00, 0xff, 0xff, 0xc0, 0xa8, 0x80, 0x9f]);
    const dump = Buffer.concat([
      Buffer.from(
        "CREATE TABLE `t` (`IP` varbinary(16)) COLLATE=utf8mb4_0900_ai_ci;\nINSERT INTO `t` VALUES ('",
      ),
      binaryIp,
      Buffer.from("'),('åäö');\n"),
      Buffer.alloc(200, 0x20),
    ]);
    const runner = makeFakeRunner({ pushDumpSql: dump });
    const { deps } = makeDeps({ runner });

    const result = await executePush(pushParams(), deps);
    expect(result.success).toBe(true);

    const upload = runner.uploads.find((u) => u.src.endsWith('-local.sql'))!;
    expect(upload.bytes.includes(binaryIp)).toBe(true);
    expect(upload.content).toContain('utf8mb4_unicode_520_ci');
    expect(upload.content).toContain('åäö');
  });

  it('reconciles the remote table_prefix to match Local when they differ', async () => {
    // Pushing a wp_-prefixed local DB into a wp_pk_-prefixed production would
    // leave the imported data invisible (remote wp-config still reads wp_pk_).
    fs.writeFileSync(
      path.join(sitePath, 'app', 'public', 'wp-config.php'),
      "<?php\ndefine('DB_HOST', 'localhost');\n$table_prefix = 'wp_';\n",
    );
    const { deps, calls } = makeDeps({ runner: makeFakeRunner({ remotePrefix: 'wp_pk_' }) });

    const result = await executePush(pushParams(), deps);
    expect(result.success).toBe(true);

    const setPrefix = calls.find((c) => c.step === 'remote-config-set-prefix');
    expect(setPrefix).toBeDefined();
    // The remote prefix is set to the LOCAL prefix (what the imported data uses).
    expect(setPrefix!.args[setPrefix!.args.length - 1]).toContain('table_prefix');
    expect(setPrefix!.args[setPrefix!.args.length - 1]).toContain('wp_');
  });

  it('skips the table_prefix reconcile when local and remote already match', async () => {
    fs.writeFileSync(
      path.join(sitePath, 'app', 'public', 'wp-config.php'),
      "<?php\ndefine('DB_HOST', 'localhost');\n$table_prefix = 'wp_';\n",
    );
    const { deps, calls } = makeDeps({ runner: makeFakeRunner({ remotePrefix: 'wp_' }) });

    const result = await executePush(pushParams(), deps);
    expect(result.success).toBe(true);
    expect(steps(calls)).not.toContain('remote-config-set-prefix');
  });

  it('import failure rolls back the remote DB from the pre-push backup', async () => {
    const { deps, calls, notify } = makeDeps({
      runner: makeFakeRunner({ failAt: 'remote-db-import' }),
    });
    const result = await executePush(pushParams(), deps);

    expect(result.success).toBe(false);
    expect(result.error).toContain('fake failure at remote-db-import');
    expect(steps(calls)).toContain('remote-db-restore'); // remote DB restored
    expect(notify).toHaveBeenCalledWith(
      'SSH Sync',
      expect.stringContaining('was restored from backup'),
    );
  });

  it('aborts before any change when the remote backup looks empty/truncated', async () => {
    const { deps, calls } = makeDeps({ runner: makeFakeRunner({ remoteDumpBytes: 10 }) });
    const result = await executePush(pushParams(), deps);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Remote database backup looks invalid');
    const labels = steps(calls);
    expect(labels).toContain('remote-db-export');
    expect(labels).not.toContain('rsync'); // server untouched
    expect(labels).not.toContain('remote-db-import');
  });

  it('refuses to start when a sync is already running for the site', async () => {
    const { deps, calls } = makeDeps();
    deps.activeSyncs.set(SITE_ID, { cancelled: false, child: null });

    const result = await executePush(pushParams(), deps);

    expect(result).toEqual({ success: false, error: 'A sync is already running for this site' });
    expect(calls).toHaveLength(0);
  });

  it('refuses a second concurrent sync started while the first is still in pre-flight', async () => {
    let releasePreflight!: () => void;
    const preflightGate = new Promise<void>((res) => {
      releasePreflight = res;
    });
    let preflightCalls = 0;
    const { deps } = makeDeps({
      connectRemote: async () => {
        preflightCalls++;
        await preflightGate;
        return fakeConnection();
      },
    });

    const first = executePush(pushParams(), deps);
    const second = executePush(pushParams(), deps);

    const pendingMarker = Symbol('pending');
    const settled = await Promise.race([
      second,
      new Promise((res) => setImmediate(() => res(pendingMarker))),
    ]);

    expect(settled).toEqual({ success: false, error: 'A sync is already running for this site' });
    expect(preflightCalls).toBe(1);

    releasePreflight();
    expect((await first).success).toBe(true);
  });

  it('aborts the push when the local site domain has shell-unsafe characters', async () => {
    const { deps, calls } = makeDeps();
    const params = pushParams();
    // A single quote would break out of the remote single-quoted search-replace
    // shell string — must be rejected before any destructive step.
    params.site.domain = "evil'.local";

    const result = await executePush(params, deps);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/domain/i);
    const labels = steps(calls);
    expect(labels).not.toContain('rsync');
    expect(labels).not.toContain('remote-search-replace');
    expect(labels).not.toContain('remote-db-import');
  });
});
