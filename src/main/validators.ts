import * as path from 'path';
import * as os from 'os';

import { MIN_DUMP_BYTES } from './constants';
import { EnvironmentInfo, SiteInfo } from './types';

// Security: Validate SSH/shell values to prevent command injection
export function isValidHostname(host: string): boolean {
  // Allow IP addresses and hostnames
  const hostnameRegex = /^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]$|^[a-zA-Z0-9]$/;
  const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
  return hostnameRegex.test(host) || ipRegex.test(host);
}

export function isValidPort(port: string): boolean {
  // Digits only — parseInt alone would accept "22 -oProxyCommand=..." which
  // gets word-split inside rsync's -e "ssh -p <port> ..." remote shell string
  if (!/^\d{1,5}$/.test(port)) return false;
  const portNum = parseInt(port, 10);
  return portNum > 0 && portNum <= 65535;
}

export function isValidUsername(user: string): boolean {
  // SSH usernames: alphanumeric, underscores, hyphens
  return /^[a-zA-Z0-9_-]+$/.test(user);
}

export function isValidDomain(domain: string): boolean {
  // Domain names: alphanumeric, dots, hyphens (allow single char and be more lenient)
  if (!domain || domain.length === 0) return false;
  // Just check for dangerous shell characters
  return !/[;&|`$"'\\<>(){}[\]!#*?]/.test(domain);
}

export function validateEnvironmentInfo(env: EnvironmentInfo): boolean {
  return (
    isValidHostname(env.sshHost) &&
    isValidPort(env.sshPort) &&
    isValidUsername(env.sshUser) &&
    isValidDomain(env.remoteDomain)
  );
}

// Expand ~ to home directory
export function expandPath(p: string): string {
  if (p.startsWith('~')) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

export function isLikelyValidSqlDump(sizeBytes: number): boolean {
  return Number.isFinite(sizeBytes) && sizeBytes >= MIN_DUMP_BYTES;
}

// Transient errors worth retrying: no response at all (network drop, DNS, timeout)
// or a server-side/throttling status (>=500, 429). 4xx (auth, not-found) are not
// retried — they won't fix themselves.
export function isTransientApiError(error: any): boolean {
  if (!error) return false;
  const status = error.response?.status;
  if (status === undefined) return true; // no response — network/timeout
  return status >= 500 || status === 429;
}

// Resolve DB credentials from the site object (with Local's defaults)
export function getDbCredentials(site: SiteInfo): {
  database: string;
  user: string;
  password: string;
} {
  return {
    database: site.mysql?.database || 'local',
    user: site.mysql?.user || 'root',
    password: site.mysql?.password || 'root',
  };
}

// The WordPress table prefix lives in wp-config.php as `$table_prefix = 'wp_';`.
// A pulled production dump carries production's prefix; when it differs from the
// local site's, WordPress keeps reading the old (now empty) local tables and the
// pulled data is invisible. We read the local prefix (to compare) and rewrite it
// (to adopt the remote prefix so WordPress reads the imported tables).
const TABLE_PREFIX_RE = /(\$table_prefix\s*=\s*)(['"])([^'"]*)\2(\s*;)/;

export function parseTablePrefix(wpConfig: string): string | null {
  const m = wpConfig.match(TABLE_PREFIX_RE);
  return m ? m[3] : null;
}

export function setTablePrefix(wpConfig: string, prefix: string): string {
  // Replacement function (not a string) so a prefix containing `$` can never be
  // mis-parsed as a capture-group reference.
  return wpConfig.replace(
    TABLE_PREFIX_RE,
    (_m, pre, q, _old, post) => `${pre}${q}${prefix}${q}${post}`,
  );
}

// Local ships MySQL 8.x, whose default utf8mb4 collation family is
// `utf8mb4_0900_*` (ai_ci, as_cs, …). Kinsta runs MariaDB, which has no 0900
// collations, so importing a Local dump fails with "Unknown collation
// 'utf8mb4_0900_ai_ci'". Rewrite the whole family to utf8mb4_unicode_520_ci
// (the same target WP Engine's Magic Sync uses) before pushing — it is
// understood by both MariaDB and MySQL 5.7+. The charset (utf8mb4) is fine on
// both, so only the collation token is rewritten; covers both the
// `COLLATE=<name>` (CREATE TABLE) and `COLLATE <name>` (column) forms.
export function downgradeMySQL8Collations(sql: string): string {
  return sql.replace(/utf8mb4_0900_\w+/g, 'utf8mb4_unicode_520_ci');
}

// The mirror image for pull: Kinsta's MariaDB 11.4+ defaults utf8mb4 to the
// `utf8mb4_uca1400_*` family (ai_ci, as_cs, nopad_…), which Local's MySQL 8
// doesn't know → the pull import fails with "Unknown collation:
// 'utf8mb4_uca1400_ai_ci'". Rewrite the family to utf8mb4_unicode_520_ci (same
// target as above, understood by both engines) before piping the downloaded
// dump into Local's MySQL. Covers both the `COLLATE=<name>` and `COLLATE <name>`
// forms; no-op for dumps from older MariaDB.
export function downgradeMariaDBCollations(sql: string): string {
  return sql.replace(/utf8mb4_uca1400_\w+/g, 'utf8mb4_unicode_520_ci');
}

// `wp config get table_prefix` returns the bare value plus a trailing newline.
// Validate strictly before it reaches wp-config.php or a DROP TABLE loop — a
// WordPress prefix is letters, digits and underscores only.
export function normalizeTablePrefix(raw: string): string | null {
  const v = (raw || '').trim();
  if (!v || v.length > 64) return null;
  if (!/^[A-Za-z0-9_]+$/.test(v)) return null;
  return v;
}

// WP-CLI search-replace passes covering https, http, and protocol-relative URLs.
// The final pass handles the JSON-escaped slash form (`\/\/domain`) that appears
// when URLs are stored inside JSON — Gutenberg block attributes, plugin settings,
// cached API payloads. wp search-replace matches literal substrings, so plain
// `//domain` never matches `\/\/domain`; without this pass the source domain leaks
// across every push/pull. One `\/\/domain` pass suffices because it is a substring
// of `https:\/\/domain` and `http:\/\/domain` too (mirroring how `//domain` covers
// the plain protocol forms).
export function searchReplacePairs(fromDomain: string, toDomain: string): Array<[string, string]> {
  return [
    [`https://${fromDomain}`, `https://${toDomain}`],
    [`http://${fromDomain}`, `http://${toDomain}`],
    [`//${fromDomain}`, `//${toDomain}`],
    [`\\/\\/${fromDomain}`, `\\/\\/${toDomain}`],
  ];
}
