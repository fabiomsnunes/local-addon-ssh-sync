import * as path from 'path';
import * as fs from 'fs';
import type { SafeStorage } from 'electron';

import { LEGACY_CONFIG_DIR, HISTORY_LIMIT } from './constants';
import { KinstaConfig, SiteLink } from './types';

// Set from context via initConfig() in the exported entry point
let safeStorage: SafeStorage | null = null;

// Config paths — resolved once userDataPath is known
let CONFIG_DIR = LEGACY_CONFIG_DIR;
let CONFIG_FILE = '';
let KEY_FILE = '';
let SITES_FILE = '';
let TEMP_DIR = '';

// userDataPath captured by initConfig(), used by resolveConfigPaths()
let userDataPath = '';

export function resolveConfigPaths(): void {
  // Store under Local's own user data dir (idiomatic per the Context API)
  CONFIG_DIR = userDataPath
    ? path.join(userDataPath, 'addons-data', 'kinsta-sync')
    : LEGACY_CONFIG_DIR;
  CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
  KEY_FILE = path.join(CONFIG_DIR, '.api-key.enc');
  SITES_FILE = path.join(CONFIG_DIR, 'sites.json');
  TEMP_DIR = path.join(CONFIG_DIR, 'tmp');
}

// Initialize config state from the Context API: capture userDataPath and the
// safeStorage instance, then resolve the config paths.
export function initConfig(newUserDataPath: string, newSafeStorage: SafeStorage): void {
  userDataPath = newUserDataPath;
  safeStorage = newSafeStorage;
  resolveConfigPaths();
}

// Accessor for the temp dir (defaultPullPushDeps needs it)
export function getTempDir(): string {
  return TEMP_DIR;
}

// One-time migration from ~/.kinsta-sync to userDataPath.
// IMPORTANT: the legacy dir is renamed away afterwards — if it stays, every
// startup would re-copy "missing" files and resurrect deleted credentials
// (e.g. the API key after a disconnect).
export function migrateLegacyConfig(): void {
  if (CONFIG_DIR === LEGACY_CONFIG_DIR) return;
  if (!fs.existsSync(LEGACY_CONFIG_DIR)) return;
  ensureConfigDir();
  migrateConfigFiles(LEGACY_CONFIG_DIR, CONFIG_DIR);
}

// Copy any config files missing from targetDir, then rename the legacy dir away
// so migration runs exactly once. Exported (and parameterized) so it can be
// unit-tested with temp dirs instead of the real ~/.kinsta-sync.
export function migrateConfigFiles(legacyDir: string, targetDir: string): void {
  for (const file of ['config.json', '.api-key.enc', 'sites.json']) {
    const from = path.join(legacyDir, file);
    const to = path.join(targetDir, file);
    if (fs.existsSync(from) && !fs.existsSync(to)) {
      fs.copyFileSync(from, to);
      console.log(`[Kinsta] Migrated ${file} to ${targetDir}`);
    }
  }
  // Keep the old dir as a backup, but make sure migration never runs again
  try {
    fs.renameSync(legacyDir, `${legacyDir}.migrated`);
    console.log(`[Kinsta] Legacy config dir renamed to ${legacyDir}.migrated`);
  } catch (e) {
    console.error('[Kinsta] Could not rename legacy config dir:', e);
  }
}

// Config helpers
export function ensureConfigDir(): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

export function loadConfig(): KinstaConfig {
  ensureConfigDir();
  if (fs.existsSync(CONFIG_FILE)) {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  }
  return {};
}

export function saveConfig(config: KinstaConfig): void {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// Secure API key storage using Electron's safeStorage
export function getApiKey(): string | null {
  if (!fs.existsSync(KEY_FILE)) {
    return null;
  }
  try {
    const encryptedData = fs.readFileSync(KEY_FILE);
    if (safeStorage && safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(encryptedData);
    }
    // Security: Don't read unencrypted keys
    console.error('Cannot read API key: encryption not available');
    return null;
  } catch {
    return null;
  }
}

export function saveApiKey(apiKey: string): boolean {
  ensureConfigDir();
  try {
    if (safeStorage && safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(apiKey);
      fs.writeFileSync(KEY_FILE, encrypted);
      // Set restrictive permissions
      fs.chmodSync(KEY_FILE, 0o600);
      return true;
    } else {
      // Security: Refuse to save if encryption is not available
      console.error('Cannot save API key: encryption not available');
      return false;
    }
  } catch (e) {
    console.error('Failed to save API key:', e);
    return false;
  }
}

export function deleteApiKey(): void {
  if (fs.existsSync(KEY_FILE)) {
    fs.unlinkSync(KEY_FILE);
  }
}

export function loadSiteLinks(): Record<string, SiteLink> {
  ensureConfigDir();
  if (fs.existsSync(SITES_FILE)) {
    return JSON.parse(fs.readFileSync(SITES_FILE, 'utf8'));
  }
  return {};
}

export function saveSiteLinks(links: Record<string, SiteLink>): void {
  ensureConfigDir();
  fs.writeFileSync(SITES_FILE, JSON.stringify(links, null, 2));
}

export function recordSync(
  localSiteId: string,
  mode: 'pull' | 'push',
  envType: string,
  durationMs: number,
): void {
  const links = loadSiteLinks();
  const link = links[localSiteId];
  if (!link) return;
  const at = new Date().toISOString();
  if (mode === 'pull') {
    link.lastPullAt = at;
  } else {
    link.lastPushAt = at;
  }
  link.history = [{ mode, envType, at, durationMs }, ...(link.history || [])].slice(
    0,
    HISTORY_LIMIT,
  );
  saveSiteLinks(links);
}

// Security: Clean up old temp files on startup
export function cleanupTempFiles(): void {
  if (!fs.existsSync(TEMP_DIR)) return;

  try {
    const files = fs.readdirSync(TEMP_DIR);
    for (const file of files) {
      if (file.endsWith('.sql')) {
        const filePath = path.join(TEMP_DIR, file);
        try {
          fs.unlinkSync(filePath);
          console.log(`[Kinsta] Cleaned up temp file: ${file}`);
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  } catch {
    // Ignore errors
  }
}
