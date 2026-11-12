import * as path from 'path';
import * as fs from 'fs';
import type { SafeStorage } from 'electron';

import { DATA_DIR_NAME, HISTORY_LIMIT, PUSH_BACKUPS_TO_KEEP } from './constants';
import { ServerEnvironment, SiteProfile } from './types';
import type { NeutralizeRecord } from './safeClone';

// Config paths — resolved once userDataPath is known
let CONFIG_DIR = '';
let PROFILES_FILE = '';
let TEMP_DIR = '';
let BACKUPS_DIR = '';
let SECRETS_FILE = '';

// Electron's safeStorage (macOS Keychain / OS credential store), set at startup
let safeStorage: SafeStorage | null = null;

// Initialize from the Context API: store everything under Local's own user
// data dir (addons-data/ssh-sync).
export function initConfig(userDataPath: string, newSafeStorage: SafeStorage | null = null): void {
  safeStorage = newSafeStorage;
  CONFIG_DIR = path.join(userDataPath, 'addons-data', DATA_DIR_NAME);
  PROFILES_FILE = path.join(CONFIG_DIR, 'profiles.json');
  TEMP_DIR = path.join(CONFIG_DIR, 'tmp');
  BACKUPS_DIR = path.join(CONFIG_DIR, 'backups');
  SECRETS_FILE = path.join(CONFIG_DIR, 'secrets.json');
}

export function getTempDir(): string {
  return TEMP_DIR;
}

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function getBackupsDir(): string {
  return BACKUPS_DIR;
}

export function ensureConfigDir(): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(TEMP_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(BACKUPS_DIR, { recursive: true, mode: 0o700 });
}

export function loadProfiles(): Record<string, SiteProfile> {
  ensureConfigDir();
  if (fs.existsSync(PROFILES_FILE)) {
    return JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8'));
  }
  return {};
}

export function saveProfiles(profiles: Record<string, SiteProfile>): void {
  ensureConfigDir();
  fs.writeFileSync(PROFILES_FILE, JSON.stringify(profiles, null, 2), { mode: 0o600 });
}

export function getProfile(localSiteId: string): SiteProfile | null {
  return loadProfiles()[localSiteId] || null;
}

export function findEnvironment(
  localSiteId: string,
  environmentId: string,
): ServerEnvironment | null {
  const profile = getProfile(localSiteId);
  return profile?.environments.find((e) => e.id === environmentId) || null;
}

export function saveEnvironments(localSiteId: string, environments: ServerEnvironment[]): void {
  const profiles = loadProfiles();
  const profile = profiles[localSiteId] || { localSiteId, environments: [] };
  profiles[localSiteId] = { ...profile, environments };
  saveProfiles(profiles);
}

export function deleteProfile(localSiteId: string): boolean {
  const profiles = loadProfiles();
  if (!profiles[localSiteId]) return false;
  delete profiles[localSiteId];
  saveProfiles(profiles);
  return true;
}

export function recordSync(
  localSiteId: string,
  mode: 'pull' | 'push',
  environment: ServerEnvironment,
  durationMs: number,
): void {
  const profiles = loadProfiles();
  const profile = profiles[localSiteId];
  if (!profile) return;
  const at = new Date().toISOString();
  if (mode === 'pull') {
    profile.lastPullAt = at;
  } else {
    profile.lastPushAt = at;
  }
  profile.history = [
    {
      mode,
      environmentId: environment.id,
      environmentLabel: environment.label,
      at,
      durationMs,
    },
    ...(profile.history || []),
  ].slice(0, HISTORY_LIMIT);
  saveProfiles(profiles);
}

// Keep the backups of the newest pushes to one environment, delete the rest.
// Each push leaves <prefix><stamp>.sql, <prefix><stamp>-files/ and
// <prefix><stamp>.json; the stamp right after the prefix also keeps
// environment `a` from matching the backups of environment `a-b`.
export function prunePushBackups(
  backupsDir: string,
  localSiteId: string,
  environmentId: string,
  dfs: Pick<typeof fs, 'readdirSync' | 'rmSync'> = fs,
): void {
  const prefix = `${localSiteId}-${environmentId}-`;
  const artifact = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)(\.sql|\.json|-files)$/;
  const byStamp = new Map<string, string[]>();
  for (const name of dfs.readdirSync(backupsDir) as string[]) {
    if (!name.startsWith(prefix)) continue;
    const match = name.slice(prefix.length).match(artifact);
    if (!match) continue;
    byStamp.set(match[1], [...(byStamp.get(match[1]) || []), name]);
  }
  const stamps = [...byStamp.keys()].sort().reverse();
  for (const stamp of stamps.slice(PUSH_BACKUPS_TO_KEEP)) {
    for (const name of byStamp.get(stamp)!) {
      try {
        dfs.rmSync(path.join(backupsDir, name), { recursive: true, force: true });
      } catch {
        // A backup we could not delete is harmless; the next push retries
      }
    }
  }
}

// The newest push to an environment that can still be undone
export function latestPushManifest(
  backupsDir: string,
  localSiteId: string,
  environmentId: string,
): { base: string; manifest: any } | null {
  const prefix = `${localSiteId}-${environmentId}-`;
  let names: string[];
  try {
    names = fs.readdirSync(backupsDir);
  } catch {
    return null;
  }
  const latest = names
    .filter(
      (n) =>
        n.startsWith(prefix) && /^\d{4}-\d{2}-\d{2}T[\d-]+Z\.json$/.test(n.slice(prefix.length)),
    )
    .sort()
    .pop();
  if (!latest) return null;
  try {
    return {
      base: path.join(backupsDir, latest.replace(/\.json$/, '')),
      manifest: JSON.parse(fs.readFileSync(path.join(backupsDir, latest), 'utf8')),
    };
  } catch {
    return null;
  }
}

// Leftover dumps from an interrupted session hold full database contents:
// remove them on startup. (Pre-push backups live in BACKUPS_DIR and stay.)
export function cleanupTempFiles(): void {
  if (!fs.existsSync(TEMP_DIR)) return;

  try {
    for (const file of fs.readdirSync(TEMP_DIR)) {
      if (file.endsWith('.sql') || file.endsWith('.txt')) {
        try {
          fs.unlinkSync(path.join(TEMP_DIR, file));
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  } catch {
    // Ignore errors
  }
}

// ---------------------------------------------------------------------------
// SSH passwords: encrypted with safeStorage, keyed by environment id, never
// returned to the renderer and never stored in profiles.json.
// ---------------------------------------------------------------------------

function loadSecrets(): Record<string, string> {
  if (!SECRETS_FILE || !fs.existsSync(SECRETS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveSecrets(secrets: Record<string, string>): void {
  ensureConfigDir();
  fs.writeFileSync(SECRETS_FILE, JSON.stringify(secrets, null, 2), { mode: 0o600 });
}

// On Linux without a keyring Electron falls back to `basic_text`, a hardcoded
// key: as good as plain text, so passwords are refused there.
export function canStorePasswords(): boolean {
  if (!safeStorage || !safeStorage.isEncryptionAvailable()) return false;
  const backend = (
    safeStorage as SafeStorage & { getSelectedStorageBackend?: () => string }
  ).getSelectedStorageBackend?.();
  return backend !== 'basic_text';
}

// Refuses (returns false) when the OS cannot encrypt: a password is never
// written in plain text.
export function savePassword(environmentId: string, password: string): boolean {
  if (!canStorePasswords()) return false;
  const secrets = loadSecrets();
  secrets[environmentId] = safeStorage!.encryptString(password).toString('base64');
  saveSecrets(secrets);
  return true;
}

export function getPassword(environmentId: string): string | null {
  const encrypted = loadSecrets()[environmentId];
  if (!encrypted || !canStorePasswords()) return null;
  try {
    return safeStorage!.decryptString(Buffer.from(encrypted, 'base64'));
  } catch {
    return null;
  }
}

export function hasPassword(environmentId: string): boolean {
  return Boolean(loadSecrets()[environmentId]);
}

// Drop the passwords of every environment not in `keepIds`
export function prunePasswords(keepIds: Set<string>): void {
  const secrets = loadSecrets();
  const kept = Object.fromEntries(Object.entries(secrets).filter(([id]) => keepIds.has(id)));
  if (Object.keys(kept).length !== Object.keys(secrets).length) saveSecrets(kept);
}

// What the safe-copy step changed in a Local site's database, so a database
// push can put it back on the server (see safeClone.ts). No secrets inside.
function neutralizeRecordFile(localSiteId: string): string {
  return path.join(CONFIG_DIR, 'neutralized', `${localSiteId.replace(/[^A-Za-z0-9_-]/g, '')}.json`);
}

export function saveNeutralizeRecord(localSiteId: string, record: NeutralizeRecord | null): void {
  const file = neutralizeRecordFile(localSiteId);
  if (!record) {
    try {
      fs.unlinkSync(file);
    } catch {
      // none saved
    }
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(record, null, 2), { mode: 0o600 });
}

export function loadNeutralizeRecord(localSiteId: string): NeutralizeRecord | null {
  try {
    return JSON.parse(fs.readFileSync(neutralizeRecordFile(localSiteId), 'utf8'));
  } catch {
    return null;
  }
}
