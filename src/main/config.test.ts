import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SafeStorage } from 'electron';
import {
  initConfig,
  getTempDir,
  loadConfig,
  saveConfig,
  loadSiteLinks,
  saveSiteLinks,
  recordSync,
  getApiKey,
  saveApiKey,
  deleteApiKey,
  migrateConfigFiles,
} from './config';

// A stand-in for Electron's safeStorage: reversible "encryption" so getApiKey
// round-trips saveApiKey without a real keychain.
const fakeSafeStorage = (available = true): SafeStorage =>
  ({
    isEncryptionAvailable: () => available,
    encryptString: (s: string) => Buffer.from('enc:' + s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, ''),
  }) as unknown as SafeStorage;

let sandbox: string;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'kinsta-config-'));
  // initConfig resolves CONFIG_DIR to <userDataPath>/addons-data/kinsta-sync
  initConfig(sandbox, fakeSafeStorage());
});

afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const link = (over: Partial<any> = {}) => ({
  localSiteId: 's1',
  kinstaSiteId: 'k1',
  kinstaSiteName: 'Nuclear Sweden',
  kinstaSiteSlug: 'nuclearsweden',
  ...over,
});

describe('config + site links', () => {
  it('getTempDir points inside the resolved config dir', () => {
    expect(getTempDir()).toBe(path.join(sandbox, 'addons-data', 'kinsta-sync', 'tmp'));
  });

  it('loadConfig returns {} before anything is saved, then round-trips', () => {
    expect(loadConfig()).toEqual({});
    saveConfig({ companyId: 'co-123' });
    expect(loadConfig()).toEqual({ companyId: 'co-123' });
  });

  it('loadSiteLinks returns {} before anything is saved, then round-trips', () => {
    expect(loadSiteLinks()).toEqual({});
    saveSiteLinks({ s1: link() });
    expect(loadSiteLinks().s1.kinstaSiteSlug).toBe('nuclearsweden');
  });
});

describe('API key storage', () => {
  it('round-trips an encrypted API key and deletes it', () => {
    expect(getApiKey()).toBeNull();
    expect(saveApiKey('secret-key')).toBe(true);
    expect(getApiKey()).toBe('secret-key');
    deleteApiKey();
    expect(getApiKey()).toBeNull();
  });

  it('refuses to save when encryption is unavailable', () => {
    initConfig(sandbox, fakeSafeStorage(false));
    expect(saveApiKey('secret')).toBe(false);
    expect(getApiKey()).toBeNull();
  });
});

describe('recordSync', () => {
  it('sets the matching timestamp and prepends a history entry', () => {
    saveSiteLinks({ s1: link() });
    recordSync('s1', 'pull', 'staging', 1234);
    const after = loadSiteLinks().s1;
    expect(after.lastPullAt).toBeTruthy();
    expect(after.lastPushAt).toBeUndefined();
    expect(after.history?.[0]).toMatchObject({
      mode: 'pull',
      envType: 'staging',
      durationMs: 1234,
    });
  });

  it('caps history at the limit, most recent first', () => {
    saveSiteLinks({ s1: link() });
    for (let i = 0; i < 12; i++) recordSync('s1', i % 2 === 0 ? 'pull' : 'push', 'staging', i);
    const after = loadSiteLinks().s1;
    expect(after.history).toHaveLength(10); // HISTORY_LIMIT
    expect(after.history?.[0].durationMs).toBe(11); // newest (i=11, push)
    expect(after.lastPushAt).toBeTruthy();
    expect(after.lastPullAt).toBeTruthy();
  });

  it('is a no-op for an unlinked site', () => {
    saveSiteLinks({});
    expect(() => recordSync('missing', 'pull', 'staging', 1)).not.toThrow();
    expect(loadSiteLinks()).toEqual({});
  });
});

describe('migrateConfigFiles', () => {
  it('copies missing files, never overwrites existing ones, and renames the legacy dir away', () => {
    const legacy = path.join(sandbox, 'legacy');
    const target = path.join(sandbox, 'target');
    fs.mkdirSync(legacy, { recursive: true });
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'config.json'), JSON.stringify({ companyId: 'OLD' }));
    fs.writeFileSync(path.join(legacy, 'sites.json'), '{}');
    // target already has config.json — must be preserved
    fs.writeFileSync(path.join(target, 'config.json'), JSON.stringify({ companyId: 'KEEP' }));

    migrateConfigFiles(legacy, target);

    expect(JSON.parse(fs.readFileSync(path.join(target, 'config.json'), 'utf8'))).toEqual({
      companyId: 'KEEP', // not overwritten
    });
    expect(fs.existsSync(path.join(target, 'sites.json'))).toBe(true); // copied
    expect(fs.existsSync(legacy)).toBe(false); // renamed away
    expect(fs.existsSync(legacy + '.migrated')).toBe(true);
  });
});
