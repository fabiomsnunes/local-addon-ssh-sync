import { describe, it, expect, vi } from 'vitest';
import {
  isValidHostname,
  isValidPort,
  isValidUsername,
  isValidDomain,
  validateEnvironmentInfo,
  expandPath,
  describePartialTransfer,
  sshArgs,
  rsyncProgressArgs,
  makeRsyncProgressParser,
  getDbCredentials,
  searchReplacePairs,
  isLikelyValidSqlDump,
  isTransientApiError,
  EXCLUDE_PATTERNS,
  EnvironmentInfo,
  RsyncInfo,
  parseItemizeLine,
  parseItemizeOutput,
  parseVerboseDryRun,
  safeRemoteRelPath,
  buildPushRsyncArgs,
  parseTablePrefix,
  setTablePrefix,
  normalizeTablePrefix,
  rsyncSshContext,
  downgradeMySQL8Collations,
  downgradeMariaDBCollations,
} from './index';

const env = (overrides: Partial<EnvironmentInfo> = {}): EnvironmentInfo => ({
  envId: 'env-1',
  envType: 'live',
  sshHost: '35.1.2.3',
  sshPort: '12345',
  sshUser: 'gbdbutik',
  remoteDomain: 'gbdbutik.se',
  ...overrides,
});

describe('injection guards (validators)', () => {
  it('accepts normal hosts', () => {
    expect(isValidHostname('35.1.2.3')).toBe(true);
    expect(isValidHostname('ssh.kinsta.cloud')).toBe(true);
  });

  it('rejects shell metacharacters in hostnames', () => {
    for (const bad of [
      'host;rm -rf /',
      'host$(id)',
      'host`id`',
      'host name',
      '-oProxyCommand=evil',
      '',
    ]) {
      expect(isValidHostname(bad)).toBe(false);
    }
  });

  it('validates ports as 1-65535', () => {
    expect(isValidPort('22')).toBe(true);
    expect(isValidPort('65535')).toBe(true);
    expect(isValidPort('0')).toBe(false);
    expect(isValidPort('65536')).toBe(false);
    expect(isValidPort('22; rm')).toBe(false);
    expect(isValidPort('abc')).toBe(false);
  });

  it('rejects dangerous usernames and domains', () => {
    expect(isValidUsername('gbdbutik')).toBe(true);
    expect(isValidUsername('user name')).toBe(false);
    expect(isValidUsername('user;id')).toBe(false);
    expect(isValidDomain('gbdbutik.se')).toBe(true);
    expect(isValidDomain("dom'ain.se")).toBe(false);
  });

  it('validateEnvironmentInfo requires every field to pass', () => {
    expect(validateEnvironmentInfo(env())).toBe(true);
    expect(validateEnvironmentInfo(env({ sshHost: 'host;evil' }))).toBe(false);
    expect(validateEnvironmentInfo(env({ sshPort: '99999' }))).toBe(false);
    expect(validateEnvironmentInfo(env({ sshUser: 'a b' }))).toBe(false);
    expect(validateEnvironmentInfo(env({ remoteDomain: '$(x).se' }))).toBe(false);
  });
});

describe('sshArgs', () => {
  it('builds args as an array (no shell string)', () => {
    expect(sshArgs(env(), 'wp db export /tmp/x.sql')).toEqual([
      '-p',
      '12345',
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-o',
      'ServerAliveInterval=60',
      '-o',
      'ServerAliveCountMax=120',
      'gbdbutik@35.1.2.3',
      'wp db export /tmp/x.sql',
    ]);
  });

  it('keeps the SSH connection alive on long syncs (keepalive)', () => {
    // A long mysqldump/import or a big rsync can idle the channel long enough
    // for a NAT/firewall to drop it. ServerAlive* makes ssh probe the peer.
    const args = sshArgs(env(), 'wp db export /tmp/x.sql');
    expect(args).toContain('ServerAliveInterval=60');
    expect(args).toContain('ServerAliveCountMax=120');
  });
});

describe('rsyncSshContext', () => {
  it('applies the same SSH keepalive to the rsync transport', () => {
    const { sshCommandForRsync } = rsyncSshContext({ path: '/tmp/site' } as any, env());
    expect(sshCommandForRsync).toContain('-o ServerAliveInterval=60');
    expect(sshCommandForRsync).toContain('-o ServerAliveCountMax=120');
    expect(sshCommandForRsync).toContain('-p 12345');
  });
});

describe('expandPath', () => {
  it('expands ~ to the home directory', () => {
    expect(expandPath('~/Local Sites/x')).not.toContain('~');
    expect(expandPath('~/x').startsWith('/')).toBe(true);
  });

  it('leaves absolute paths alone', () => {
    expect(expandPath('/var/www')).toBe('/var/www');
  });
});

describe('describePartialTransfer', () => {
  it('returns null for a clean run', () => {
    expect(describePartialTransfer({ code: 0, stderr: '' })).toBeNull();
  });

  it('describes skipped files on exit 23 (legacy filename encoding)', () => {
    const stderr = [
      'rsync: [receiver] mkstemp ".../uploads/2019/12/.Planetv\\#344xel.jpg.1YsZBf" failed: Illegal byte sequence (92)',
      'rsync: [receiver] mkstemp ".../uploads/2019/12/.Planetv\\#344xel-768x540.jpg.sJCw4G" failed: Illegal byte sequence (92)',
      'rsync error: some files/attrs were not transferred (see previous errors) (code 23) at main.c(1867)',
    ].join('\n');
    const warning = describePartialTransfer({ code: 23, stderr });
    expect(warning).toMatch(/^2 file/);
    expect(warning).toContain('skipped');
    expect(warning).toContain('Everything else synced');
  });

  it('still warns when no per-file lines were captured', () => {
    const warning = describePartialTransfer({ code: 24, stderr: '' });
    expect(warning).toContain('Some');
  });
});

describe('rsync progress', () => {
  const gnu: RsyncInfo = {
    bin: 'rsync',
    supportsProgress2: true,
    supportsProgress: true,
    supportsItemizeChanges: true,
    supportsOutFormat: true,
  };
  const openrsync: RsyncInfo = {
    bin: '/usr/bin/rsync',
    supportsProgress2: false,
    supportsProgress: true,
    supportsItemizeChanges: false,
    supportsOutFormat: false,
  };
  const ancient: RsyncInfo = {
    bin: 'rsync',
    supportsProgress2: false,
    supportsProgress: false,
    supportsItemizeChanges: false,
    supportsOutFormat: false,
  };

  it('picks the best progress flag per rsync flavor', () => {
    expect(rsyncProgressArgs(gnu)).toEqual(['--info=progress2', '--no-inc-recursive']);
    expect(rsyncProgressArgs(openrsync)).toEqual(['--progress']);
    expect(rsyncProgressArgs(ancient)).toEqual([]);
  });

  it('parses overall % from --info=progress2 output', () => {
    const onPercent = vi.fn();
    const parse = makeRsyncProgressParser(gnu, onPercent);
    parse('  1,234,567  42%  1.2MB/s  0:00:10');
    expect(onPercent).toHaveBeenLastCalledWith(42);
    parse('  9,999,999  100%  2MB/s  0:00:00');
    expect(onPercent).toHaveBeenLastCalledWith(100);
  });

  it('derives overall % from to-check counts (rsync 2.6.9)', () => {
    const onPercent = vi.fn();
    const parse = makeRsyncProgressParser(ancient, onPercent);
    parse('somefile.jpg\n  123 100%  0.5MB/s (xfer#1, to-check=75/100)');
    expect(onPercent).toHaveBeenLastCalledWith(25);
  });

  it('ignores bouncing per-file % when progress2 is unavailable', () => {
    const onPercent = vi.fn();
    const parse = makeRsyncProgressParser(openrsync, onPercent);
    parse('somefile.jpg 95%'); // per-file, would bounce
    expect(onPercent).not.toHaveBeenCalled();
  });
});

describe('getDbCredentials', () => {
  const site = { id: 'x', path: '/x', domain: 'x.local' };

  it('uses the site mysql config when present', () => {
    expect(
      getDbCredentials({ ...site, mysql: { database: 'db1', user: 'u1', password: 'p1' } }),
    ).toEqual({ database: 'db1', user: 'u1', password: 'p1' });
  });

  it("falls back to Local's defaults", () => {
    expect(getDbCredentials(site)).toEqual({ database: 'local', user: 'root', password: 'root' });
  });
});

describe('searchReplacePairs', () => {
  it('covers https, http, protocol-relative, and JSON-escaped URLs', () => {
    expect(searchReplacePairs('gbdbutik.se', 'gbd-shop.local')).toEqual([
      ['https://gbdbutik.se', 'https://gbd-shop.local'],
      ['http://gbdbutik.se', 'http://gbd-shop.local'],
      ['//gbdbutik.se', '//gbd-shop.local'],
      ['\\/\\/gbdbutik.se', '\\/\\/gbd-shop.local'],
    ]);
  });

  it('the escaped \\/\\/ pass is a substring of escaped http(s) URLs, so one pass covers all', () => {
    const escapedFrom = searchReplacePairs('a.com', 'b.local')[3][0];
    expect(escapedFrom).toBe('\\/\\/a.com');
    // JSON-encoded URLs (e.g. block attributes, plugin settings) store slashes escaped
    expect('https:\\/\\/a.com'.includes(escapedFrom)).toBe(true);
    expect('http:\\/\\/a.com'.includes(escapedFrom)).toBe(true);
  });
});

describe('table prefix helpers', () => {
  const cfg = (prefix: string) =>
    `<?php\ndefine('DB_NAME', 'local');\n$table_prefix = '${prefix}';\nrequire ABSPATH;\n`;

  it('parses the table prefix from wp-config', () => {
    expect(parseTablePrefix(cfg('wp_'))).toBe('wp_');
    expect(parseTablePrefix(cfg('wp_pk_'))).toBe('wp_pk_');
    expect(parseTablePrefix('$table_prefix = "wp_dq_";')).toBe('wp_dq_'); // double quotes
    expect(parseTablePrefix("$table_prefix='nospace_';")).toBe('nospace_'); // no spaces
  });

  it('returns null when there is no table prefix line', () => {
    expect(parseTablePrefix("<?php\ndefine('DB_HOST', 'localhost');\n")).toBeNull();
  });

  it('rewrites the prefix while preserving quote style and surrounding code', () => {
    const out = setTablePrefix(cfg('wp_'), 'wp_pk_');
    expect(out).toContain("$table_prefix = 'wp_pk_';");
    expect(out).toContain("define('DB_NAME', 'local')"); // rest untouched
    expect(parseTablePrefix(out)).toBe('wp_pk_');
    // round-trips through a value that contains a literal $ safely
    expect(parseTablePrefix(setTablePrefix(cfg('wp_'), 'wp_x_'))).toBe('wp_x_');
  });

  it('normalizes/validates the remote `wp config get table_prefix` output', () => {
    expect(normalizeTablePrefix('wp_pk_\n')).toBe('wp_pk_'); // trailing newline trimmed
    expect(normalizeTablePrefix('  wp_  ')).toBe('wp_');
    expect(normalizeTablePrefix('')).toBeNull();
    expect(normalizeTablePrefix('wp_; DROP TABLE x')).toBeNull(); // injection rejected
    expect(normalizeTablePrefix('wp-bad')).toBeNull(); // hyphen not allowed
    expect(normalizeTablePrefix('a'.repeat(65))).toBeNull(); // absurdly long
  });
});

describe('parseItemizeLine (push preview diff, %i|%l|%M|%n format)', () => {
  it('classifies a brand new file as add with mtime from %M', () => {
    const row = parseItemizeLine('<f+++++++++|1234|2026/06/05-12:30:00|wp-content/themes/x/a.php');
    expect(row).toMatchObject({
      path: 'wp-content/themes/x/a.php',
      op: 'add',
      isDir: false,
      sizeBytes: 1234,
    });
    expect(row?.localMtime).toBe(new Date('2026/06/05 12:30:00').getTime());
  });

  it('classifies a changed file as update', () => {
    expect(parseItemizeLine('<f.st......|987|2025/01/02-08:00:00|style.css')).toMatchObject({
      path: 'style.css',
      op: 'update',
      isDir: false,
      sizeBytes: 987,
    });
    expect(parseItemizeLine('<fcst......|10|2025/01/02-08:00:00|x.js')?.op).toBe('update');
  });

  it('classifies a new directory as add + isDir with size 0 and no mtime', () => {
    const row = parseItemizeLine('cd+++++++++|0|2026/06/05-12:00:00|wp-content/uploads/2026/');
    expect(row).toEqual({
      path: 'wp-content/uploads/2026',
      op: 'add',
      isDir: true,
      sizeBytes: 0,
    });
  });

  it('parses deletions in both output forms', () => {
    expect(parseItemizeLine('*deleting|0|2024/01/01-00:00:00|old/file.php')).toEqual({
      path: 'old/file.php',
      op: 'delete',
      isDir: false,
      sizeBytes: 0,
    });
    expect(parseItemizeLine('*deleting   old/dir/')).toEqual({
      path: 'old/dir',
      op: 'delete',
      isDir: true,
      sizeBytes: 0,
    });
  });

  it('skips attribute-only changes and chatter', () => {
    expect(parseItemizeLine('.f...p.....|10|2025/01/01-00:00:00|x.php')).toBeNull();
    expect(parseItemizeLine('.d..t......|0|2025/01/01-00:00:00|somedir/')).toBeNull();
    expect(parseItemizeLine('sending incremental file list')).toBeNull();
    expect(parseItemizeLine('sent 1,024 bytes  received 100 bytes')).toBeNull();
    expect(parseItemizeLine('')).toBeNull();
    expect(parseItemizeLine('<d.........|0|2025/01/01-00:00:00|./')).toBeNull();
  });

  it('keeps | characters inside filenames intact', () => {
    expect(parseItemizeLine('<f+++++++++|5|2025/01/01-00:00:00|weird|name.txt')?.path).toBe(
      'weird|name.txt',
    );
  });

  it('survives an unparseable %M field', () => {
    const row = parseItemizeLine('<f+++++++++|5|?|x.txt');
    expect(row).toMatchObject({ path: 'x.txt', op: 'add' });
    expect(row?.localMtime).toBeUndefined();
  });

  it('parseItemizeOutput maps a whole block', () => {
    const out = [
      'sending incremental file list',
      '<f+++++++++|100|2026/06/05-10:00:00|a.txt',
      '*deleting|0|2024/01/01-00:00:00|b.txt',
      '.f...p.....|1|2025/01/01-00:00:00|c.txt',
      'sent 99 bytes',
    ].join('\n');
    const rows = parseItemizeOutput(out);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ path: 'a.txt', op: 'add', sizeBytes: 100 });
    expect(rows[1]).toEqual({ path: 'b.txt', op: 'delete', isDir: false, sizeBytes: 0 });
  });
});

describe('parseVerboseDryRun (degraded preview)', () => {
  it('classifies deleting lines and plain paths', () => {
    const out = [
      'sending incremental file list',
      'deleting old.php',
      'wp-content/themes/x/a.php',
      'wp-content/uploads/2026/',
      'sent 1024 bytes  received 20 bytes',
      'total size is 123  speedup is 1.0',
      '',
    ].join('\n');
    expect(parseVerboseDryRun(out)).toEqual([
      { path: 'old.php', op: 'delete', isDir: false, sizeBytes: 0 },
      { path: 'wp-content/themes/x/a.php', op: 'update', isDir: false, sizeBytes: 0 },
      { path: 'wp-content/uploads/2026', op: 'update', isDir: true, sizeBytes: 0 },
    ]);
  });
});

describe('safeRemoteRelPath (remote rm quoting)', () => {
  it('accepts normal relative paths, including spaces and åäö', () => {
    expect(safeRemoteRelPath('wp-content/themes/x/a.php')).toBe("'wp-content/themes/x/a.php'");
    expect(safeRemoteRelPath('dir with space/f.txt')).toBe("'dir with space/f.txt'");
    expect(safeRemoteRelPath('uploads/2019/Planetväxel.jpg')).toBe(
      "'uploads/2019/Planetväxel.jpg'",
    );
  });

  it('rejects traversal, absolute paths and shell metacharacters', () => {
    for (const bad of [
      '../etc/passwd',
      'a/../../etc',
      '/etc/passwd',
      '~/secrets',
      "a'; rm -rf ~",
      'a`id`.txt',
      'a$(id).txt',
      'a;b.txt',
      'a&b.txt',
      'a>b.txt',
      'a*.txt',
      'a\nb.txt',
      'a\\b.txt',
      'a//b.txt',
      '',
    ]) {
      expect(safeRemoteRelPath(bad), `should reject: ${JSON.stringify(bad)}`).toBeNull();
    }
  });
});

describe('buildPushRsyncArgs', () => {
  const rsync: RsyncInfo = {
    bin: 'rsync',
    supportsProgress2: true,
    supportsProgress: true,
    supportsItemizeChanges: true,
    supportsOutFormat: true,
  };
  const base = {
    rsync,
    excludeArgs: ['--exclude=.git'],
    sshCommand: 'ssh -p 22',
    localPublicPath: '/x/app/public',
    remoteHost: 'u@h',
  };

  it('full push keeps --delete', () => {
    const args = buildPushRsyncArgs({ ...base, mode: 'all' });
    expect(args).toContain('--delete');
    expect(args).not.toContain('--update');
    expect(args.join(' ')).not.toContain('--files-from');
  });

  it('newer mode adds --update', () => {
    expect(buildPushRsyncArgs({ ...base, mode: 'newer' })).toContain('--update');
  });

  it('selective push uses --files-from and drops --delete', () => {
    const args = buildPushRsyncArgs({ ...base, mode: 'all', filesFromPath: '/tmp/files.txt' });
    expect(args).toContain('--files-from=/tmp/files.txt');
    expect(args).not.toContain('--delete');
  });

  it('always ends with -e ssh, source, destination', () => {
    const args = buildPushRsyncArgs({ ...base, mode: 'all' });
    expect(args.slice(-4)).toEqual(['-e', 'ssh -p 22', '/x/app/public/', 'u@h:~/public/']);
  });
});

describe('isLikelyValidSqlDump', () => {
  it('rejects empty/truncated dumps and accepts real ones', () => {
    expect(isLikelyValidSqlDump(0)).toBe(false);
    expect(isLikelyValidSqlDump(50)).toBe(false);
    expect(isLikelyValidSqlDump(199)).toBe(false);
    expect(isLikelyValidSqlDump(200)).toBe(true);
    expect(isLikelyValidSqlDump(5_000_000)).toBe(true);
  });
  it('rejects non-finite sizes', () => {
    expect(isLikelyValidSqlDump(NaN)).toBe(false);
    expect(isLikelyValidSqlDump(Infinity)).toBe(false);
  });
});

describe('isTransientApiError', () => {
  it('treats network errors (no response) as transient', () => {
    expect(isTransientApiError({ code: 'ECONNABORTED' })).toBe(true);
    expect(isTransientApiError(new Error('socket hang up'))).toBe(true);
  });
  it('treats 5xx and 429 as transient', () => {
    expect(isTransientApiError({ response: { status: 500 } })).toBe(true);
    expect(isTransientApiError({ response: { status: 503 } })).toBe(true);
    expect(isTransientApiError({ response: { status: 429 } })).toBe(true);
  });
  it('does NOT retry 4xx (auth, not-found, bad request)', () => {
    expect(isTransientApiError({ response: { status: 401 } })).toBe(false);
    expect(isTransientApiError({ response: { status: 404 } })).toBe(false);
    expect(isTransientApiError({ response: { status: 400 } })).toBe(false);
  });
  it('handles null/undefined safely', () => {
    expect(isTransientApiError(null)).toBe(false);
    expect(isTransientApiError(undefined)).toBe(false);
  });
});

describe('downgradeMySQL8Collations', () => {
  // Local ships MySQL 8.x, whose default utf8mb4 collation is utf8mb4_0900_*.
  // Kinsta runs MariaDB, which doesn't know those collations → `wp db import`
  // fails with "Unknown collation". Rewrite them to a widely-supported one.
  it('rewrites the MySQL 8 default collation in CREATE TABLE (COLLATE=)', () => {
    const sql =
      'CREATE TABLE `wp_posts` (...) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;';
    expect(downgradeMySQL8Collations(sql)).toBe(
      'CREATE TABLE `wp_posts` (...) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci;',
    );
  });

  it('rewrites the column-level form (COLLATE <name>)', () => {
    const sql = '`name` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL';
    expect(downgradeMySQL8Collations(sql)).toBe(
      '`name` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_520_ci NOT NULL',
    );
  });

  it('covers the whole utf8mb4_0900_* family (e.g. accent/case-sensitive)', () => {
    expect(downgradeMySQL8Collations('COLLATE=utf8mb4_0900_as_cs')).toBe(
      'COLLATE=utf8mb4_unicode_520_ci',
    );
  });

  it('rewrites every occurrence', () => {
    const sql = 'a utf8mb4_0900_ai_ci b utf8mb4_0900_ai_ci';
    expect(downgradeMySQL8Collations(sql)).toBe(
      'a utf8mb4_unicode_520_ci b utf8mb4_unicode_520_ci',
    );
  });

  it('leaves already-compatible collations untouched', () => {
    const sql = 'COLLATE=utf8mb4_unicode_ci ... COLLATE utf8mb4_general_ci';
    expect(downgradeMySQL8Collations(sql)).toBe(sql);
  });
});

describe('downgradeMariaDBCollations', () => {
  // The mirror image of the push case: Kinsta's MariaDB 11.4+ defaults utf8mb4
  // to utf8mb4_uca1400_*, which Local's MySQL 8 doesn't know → the pull import
  // fails with "Unknown collation: 'utf8mb4_uca1400_ai_ci'".
  it('rewrites the MariaDB 11.4 default collation in CREATE TABLE (COLLATE=)', () => {
    const sql =
      'CREATE TABLE `wp_posts` (...) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;';
    expect(downgradeMariaDBCollations(sql)).toBe(
      'CREATE TABLE `wp_posts` (...) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci;',
    );
  });

  it('rewrites the column-level form (COLLATE <name>)', () => {
    const sql = '`name` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_uca1400_ai_ci NOT NULL';
    expect(downgradeMariaDBCollations(sql)).toBe(
      '`name` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_520_ci NOT NULL',
    );
  });

  it('covers the whole utf8mb4_uca1400_* family (accent/case-sensitive, nopad)', () => {
    expect(downgradeMariaDBCollations('COLLATE=utf8mb4_uca1400_as_cs')).toBe(
      'COLLATE=utf8mb4_unicode_520_ci',
    );
    expect(downgradeMariaDBCollations('COLLATE=utf8mb4_uca1400_nopad_ai_ci')).toBe(
      'COLLATE=utf8mb4_unicode_520_ci',
    );
  });

  it('rewrites every occurrence', () => {
    const sql = 'a utf8mb4_uca1400_ai_ci b utf8mb4_uca1400_ai_ci';
    expect(downgradeMariaDBCollations(sql)).toBe(
      'a utf8mb4_unicode_520_ci b utf8mb4_unicode_520_ci',
    );
  });

  it('leaves already-compatible collations untouched', () => {
    const sql = 'COLLATE=utf8mb4_unicode_ci ... COLLATE utf8mb4_unicode_520_ci';
    expect(downgradeMariaDBCollations(sql)).toBe(sql);
  });
});

describe('EXCLUDE_PATTERNS', () => {
  it('protects host-specific and dangerous files', () => {
    for (const required of [
      'wp-config.php',
      '.htaccess',
      '*.sql',
      'node_modules/',
      'wp-content/mu-plugins/kinsta-mu-plugins/',
      'local-xdebuginfo.php',
      // Host-specific persistent-cache drop-ins: object-cache.php points at the
      // host's Redis/Memcached, advanced-cache.php at its page cache. Syncing
      // either way would point one host at the other's cache backend.
      'wp-content/object-cache.php',
      'wp-content/advanced-cache.php',
    ]) {
      expect(EXCLUDE_PATTERNS).toContain(required);
    }
  });

  it('does NOT exclude uploads (that is a per-sync option)', () => {
    expect(EXCLUDE_PATTERNS.some((p) => p.includes('uploads'))).toBe(false);
  });

  /**
   * rsync matches a slash-less --exclude pattern against a path's basename at
   * any depth, and `*` never crosses a `/`. This mirrors just enough of that to
   * assert on REAL filenames rather than on the pattern strings themselves —
   * a pattern list can look right and still miss the file it was added for.
   */
  const isExcluded = (relPath: string): boolean => {
    const basename = relPath.split('/').pop() ?? relPath;
    return EXCLUDE_PATTERNS.some((pattern) => {
      const target = pattern.includes('/') ? relPath : basename;
      const source = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
      return new RegExp(`^${source}$`).test(target);
    });
  };

  it('excludes every copy of wp-config, not just wp-config.php itself', () => {
    // A backup carries the same DB credentials and salts as the original, so it
    // is exactly as host-specific — syncing one either way leaks them across
    // environments. wp-config-sample.php is WP core boilerplate and version-bound.
    for (const filename of [
      'wp-config.php',
      'wp-config.php.bak-claude',
      'wp-config.php.bak',
      'wp-config.php.save',
      'wp-config.php.orig',
      'wp-config.php~',
      'wp-config-sample.php',
      'wp-config-backup.php',
    ]) {
      expect(isExcluded(filename)).toBe(true);
    }
  });

  it('does not let the wp-config patterns swallow unrelated files', () => {
    for (const filename of [
      'wp-login.php',
      'wp-settings.php',
      'wp-content/themes/acme/config.php',
    ]) {
      expect(isExcluded(filename)).toBe(false);
    }
  });

  it('excludes backup copies of any file, at any depth', () => {
    // Editor/tool safety copies are never part of a site; a stale one next to
    // an mu-plugin is dead code shipped to production.
    for (const filename of [
      'wp-content/mu-plugins/bernsborg-site.php.bak-20260828-225646',
      'wp-content/mu-plugins/bernsborg-site.php.bak-claude',
      'wp-content/themes/acme/functions.php.bak',
      'wp-content/themes/acme/style.css.bak.2',
      'wp-content/plugins/acme/acme.php.orig',
      'wp-content/themes/acme/functions.php~',
      '.htaccess.bak',
    ]) {
      expect(isExcluded(filename)).toBe(true);
    }
  });

  it('does not let the backup patterns swallow files that merely contain "bak"', () => {
    for (const filename of [
      'wp-content/plugins/backup-plugin/backup.php',
      'wp-content/themes/acme/bakery.php',
      'wp-content/uploads/2026/09/bak.jpg',
      'wp-content/themes/acme/original.css',
    ]) {
      expect(isExcluded(filename)).toBe(false);
    }
  });

  it('does NOT blanket-exclude cache/ (would strip Sage/Acorn storage/framework/cache)', () => {
    // A bare 'cache/' matches at any depth and breaks Roots/Acorn themes; the
    // page-cache exclude must be anchored to wp-content/cache.
    expect(EXCLUDE_PATTERNS).not.toContain('cache/');
    expect(EXCLUDE_PATTERNS).toContain('wp-content/cache/');
  });
});
