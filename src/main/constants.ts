export const PRODUCT_NAME = 'SSH Sync';

// Folder under Local's addons-data where profiles, secrets and dumps live
export const DATA_DIR_NAME = 'ssh-sync';

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
  // Host-specific persistent-cache drop-ins. object-cache.php wires WordPress to
  // the host's Redis/Memcached, advanced-cache.php to its page-cache engine —
  // both are provisioned per host. Syncing either way would point one host at
  // the other's (unreachable) cache backend and break caching / fatal the site.
  'wp-content/object-cache.php',
  'wp-content/advanced-cache.php',
  // Local-generated helper file in the webroot — never part of the WP site
  'local-xdebuginfo.php',
  // Our own safety mu-plugin for pulled copies (safeClone.ts): never pushed
  'wp-content/mu-plugins/ssh-sync-local-safety.php',
];

export const HISTORY_LIMIT = 10;

// A valid WP database dump (mysqldump / `wp db export`) always carries the
// header/footer boilerplate, so it is comfortably larger than this. A 0-byte or
// truncated file means the backup failed — restoring from it would be worse than
// useless, so we refuse to proceed with the destructive import.
export const MIN_DUMP_BYTES = 200;

// Remote database exports kept on this machine per environment, newest first
export const PUSH_BACKUPS_TO_KEEP = 3;

// Remote temp files (database dumps in transit) are created with mktemp in the
// SSH user's home under this prefix and removed as soon as they are transferred.
export const REMOTE_TEMP_PREFIX = '.ssh-sync-';
