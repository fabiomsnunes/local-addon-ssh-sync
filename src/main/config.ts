import * as path from 'path';
import * as fs from 'fs';

import { DATA_DIR_NAME, HISTORY_LIMIT, PUSH_BACKUPS_TO_KEEP } from './constants';
import { ServerEnvironment, SiteProfile } from './types';

// Config paths — resolved once userDataPath is known
let CONFIG_DIR = '';
let PROFILES_FILE = '';
let TEMP_DIR = '';
let BACKUPS_DIR = '';

// Initialize from the Context API: store everything under Local's own user
// data dir (addons-data/ssh-sync).
export function initConfig(userDataPath: string): void {
  CONFIG_DIR = path.join(userDataPath, 'addons-data', DATA_DIR_NAME);
  PROFILES_FILE = path.join(CONFIG_DIR, 'profiles.json');
  TEMP_DIR = path.join(CONFIG_DIR, 'tmp');
  BACKUPS_DIR = path.join(CONFIG_DIR, 'backups');
}

export function getTempDir(): string {
  return TEMP_DIR;
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

// Keep the newest pre-push backups of one environment, delete the rest.
// Backup names start with `<siteId>-<environmentId>-` and end with a sortable
// timestamp, so a lexical sort is chronological.
export function prunePushBackups(
  backupsDir: string,
  localSiteId: string,
  environmentId: string,
  dfs: Pick<typeof fs, 'readdirSync' | 'unlinkSync'> = fs,
): void {
  const prefix = `${localSiteId}-${environmentId}-`;
  const backups = (dfs.readdirSync(backupsDir) as string[])
    // The timestamp right after the prefix keeps environment `a` from matching
    // the backups of environment `a-b`.
    .filter((f) => f.startsWith(prefix) && /^\d{4}-\d{2}-\d{2}T/.test(f.slice(prefix.length)))
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .reverse();
  for (const old of backups.slice(PUSH_BACKUPS_TO_KEEP)) {
    try {
      dfs.unlinkSync(path.join(backupsDir, old));
    } catch {
      // A backup we could not delete is harmless; the next push retries
    }
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
