import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  initConfig,
  getTempDir,
  getBackupsDir,
  loadProfiles,
  getProfile,
  findEnvironment,
  saveEnvironments,
  deleteProfile,
  recordSync,
  prunePushBackups,
} from './config';
import { HISTORY_LIMIT, PUSH_BACKUPS_TO_KEEP } from './constants';
import { ServerEnvironment } from './types';

let sandbox: string;

const environment = (overrides: Partial<ServerEnvironment> = {}): ServerEnvironment => ({
  id: 'production',
  label: 'Production',
  sshAlias: 'example',
  auth: 'key',
  remotePath: '/var/www/example.com',
  remoteUrl: 'https://example.com',
  wpCommand: 'wp',
  extraExcludes: [],
  isProduction: true,
  ...overrides,
});

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-sync-config-'));
  initConfig(sandbox);
});

afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('config paths', () => {
  it('keeps temp dumps and backups inside addons-data/ssh-sync', () => {
    const dataDir = path.join(sandbox, 'addons-data', 'ssh-sync');
    expect(getTempDir()).toBe(path.join(dataDir, 'tmp'));
    expect(getBackupsDir()).toBe(path.join(dataDir, 'backups'));
  });
});

describe('profiles', () => {
  it('returns {} before anything is saved, then round-trips environments', () => {
    expect(loadProfiles()).toEqual({});
    saveEnvironments('site-1', [environment()]);
    expect(getProfile('site-1')?.environments).toEqual([environment()]);
    expect(findEnvironment('site-1', 'production')?.label).toBe('Production');
    expect(findEnvironment('site-1', 'staging')).toBeNull();
    expect(findEnvironment('other-site', 'production')).toBeNull();
  });

  it('keeps history and timestamps when the environments are edited', () => {
    saveEnvironments('site-1', [environment()]);
    recordSync('site-1', 'pull', environment(), 1000);
    saveEnvironments('site-1', [environment({ label: 'Live' })]);
    const profile = getProfile('site-1')!;
    expect(profile.environments[0].label).toBe('Live');
    expect(profile.lastPullAt).toBeTruthy();
    expect(profile.history).toHaveLength(1);
  });

  it('deletes a profile and reports whether one existed', () => {
    saveEnvironments('site-1', [environment()]);
    expect(deleteProfile('site-1')).toBe(true);
    expect(deleteProfile('site-1')).toBe(false);
    expect(getProfile('site-1')).toBeNull();
  });

  it('writes the profiles file readable by the owner only', () => {
    saveEnvironments('site-1', [environment()]);
    const file = path.join(sandbox, 'addons-data', 'ssh-sync', 'profiles.json');
    expect(fs.statSync(file).mode & 0o077).toBe(0);
  });
});

describe('recordSync', () => {
  it('sets the matching timestamp and prepends a history entry', () => {
    saveEnvironments('site-1', [environment()]);
    recordSync('site-1', 'push', environment(), 2500);
    const profile = getProfile('site-1')!;
    expect(profile.lastPushAt).toBeTruthy();
    expect(profile.lastPullAt).toBeUndefined();
    expect(profile.history![0]).toMatchObject({
      mode: 'push',
      environmentId: 'production',
      environmentLabel: 'Production',
      durationMs: 2500,
    });
  });

  it('caps history at the limit, most recent first', () => {
    saveEnvironments('site-1', [environment()]);
    for (let i = 0; i < HISTORY_LIMIT + 3; i++) {
      recordSync('site-1', 'pull', environment(), i);
    }
    const history = getProfile('site-1')!.history!;
    expect(history).toHaveLength(HISTORY_LIMIT);
    expect(history[0].durationMs).toBe(HISTORY_LIMIT + 2);
  });

  it('is a no-op for a site without a profile', () => {
    recordSync('nope', 'pull', environment(), 1);
    expect(getProfile('nope')).toBeNull();
  });
});

describe('prunePushBackups', () => {
  it('keeps only the newest backups of that environment', () => {
    const dir = path.join(sandbox, 'backups');
    fs.mkdirSync(dir);
    const names = [
      'site-1-production-2026-11-01T10-00-00-000Z.sql',
      'site-1-production-2026-11-02T10-00-00-000Z.sql',
      'site-1-production-2026-11-03T10-00-00-000Z.sql',
      'site-1-production-2026-11-04T10-00-00-000Z.sql',
      'site-1-staging-2026-11-01T10-00-00-000Z.sql',
      'site-1-production-eu-2026-10-01T10-00-00-000Z.sql',
      'site-2-production-2026-11-01T10-00-00-000Z.sql',
    ];
    for (const n of names) fs.writeFileSync(path.join(dir, n), 'x');

    prunePushBackups(dir, 'site-1', 'production');

    const left = fs.readdirSync(dir).sort();
    expect(left.filter((n) => n.startsWith('site-1-production-2'))).toHaveLength(
      PUSH_BACKUPS_TO_KEEP,
    );
    expect(left).not.toContain('site-1-production-2026-11-01T10-00-00-000Z.sql');
    expect(left).toContain('site-1-staging-2026-11-01T10-00-00-000Z.sql');
    expect(left).toContain('site-1-production-eu-2026-10-01T10-00-00-000Z.sql');
    expect(left).toContain('site-2-production-2026-11-01T10-00-00-000Z.sql');
  });
});
