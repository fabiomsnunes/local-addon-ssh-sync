import * as path from 'path';
import * as os from 'os';

export const KINSTA_API_BASE = 'https://api.kinsta.com/v2';

// Legacy config location (pre userDataPath migration)
export const LEGACY_CONFIG_DIR = path.join(os.homedir(), '.kinsta-sync');

// Files/folders to exclude during sync
export const EXCLUDE_PATTERNS = [
  '.git',
  '.git/',
  'node_modules/',
  '.DS_Store',
  '*.log',
  '.env',
  '.sass-cache/',
  // Anchor the page-cache exclude to wp-content/cache (W3TC/WP-Super-Cache/etc.).
  // A blanket 'cache/' matches at ANY depth and strips wp-content/themes/<sage>/
  // storage/framework/cache — which Roots/Acorn (Sage) themes REQUIRE to exist,
  // so the pulled site fatals to a blank page. (Bedrock/Laravel themes likewise.)
  'wp-content/cache/',
  '.cache/',
  '/vendor/',
  '*.sql',
  '*.sql.gz',
  '.idea/',
  '.vscode/',
  'Thumbs.db',
  'wp-config.php',
  // Every copy of wp-config carries the same DB credentials and salts as the
  // original, so it is exactly as host-specific — syncing one either way leaks
  // them across environments. Covers .bak/.save/.orig/.bak-<tool> suffixes,
  // wp-config-backup.php style renames, editor tilde files, and WP core's
  // version-bound wp-config-sample.php.
  'wp-config.php.*',
  'wp-config-*.php',
  'wp-config.php~',
  // Backup copies of ANY file: editor/tool safety copies such as foo.php.bak,
  // foo.php.bak-20260828-225646, foo.php.bak-claude, foo.php.orig, foo.php~.
  // They are never part of a site, and a stale copy next to an mu-plugin is
  // dead code shipped to production (seen on Bernsborg, 2026-09-16).
  '*.bak',
  '*.bak.*',
  '*.bak-*',
  '*.orig',
  '*~',
  '.htaccess',
  'php.ini',
  '.user.ini',
  'wp-content/mu-plugins/kinsta-mu-plugins/',
  'wp-content/mu-plugins/kinsta-mu-plugins.php',
  // Host-specific persistent-cache drop-ins. object-cache.php wires WordPress to
  // the host's Redis/Memcached, advanced-cache.php to its page-cache engine —
  // both are provisioned per host. Syncing either way would point one host at
  // the other's (unreachable) cache backend and break caching / fatal the site.
  'wp-content/object-cache.php',
  'wp-content/advanced-cache.php',
  // Local-generated helper file in the webroot — never part of the WP site
  'local-xdebuginfo.php',
];

export const HISTORY_LIMIT = 10;

// A valid WP database dump (mysqldump / `wp db export`) always carries the
// header/footer boilerplate, so it is comfortably larger than this. A 0-byte or
// truncated file means the backup failed — restoring from it would be worse than
// useless, so we refuse to proceed with the destructive import.
export const MIN_DUMP_BYTES = 200;

export const KINSTA_BACKUP_TAG = 'kinsta-sync-pre-push';
export const MANUAL_BACKUP_LIMIT = 5;

// Remote pre-push DB dump (home dir, outside ~/public). The automatic rollback
// restores from this exact path — keep the export, size-check, and restore in
// lockstep so a typo can't silently break the rollback net.
export const REMOTE_PUSH_BACKUP = '~/kinsta-sync-pre-push-backup.sql';
