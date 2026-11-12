import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { parseArgs } from './cli';
import {
  findLocalSite,
  startCliServer,
  cliLauncherScript,
  CliMessage,
  isStaleLocalOnly,
  lastPullFrom,
} from './cliProtocol';

describe('ssh-sync arguments', () => {
  it('pulls files and database, safely, by default', () => {
    expect(parseArgs(['pull', 'mysite', 'production'])).toEqual({
      command: 'pull',
      site: 'mysite',
      environment: 'production',
      includeDatabase: true,
      includeUploads: false,
      makeSafe: true,
    });
    expect(
      parseArgs(['pull', 'mysite', 'staging', '--no-db', '--uploads', '--unsafe']),
    ).toMatchObject({ includeDatabase: false, includeUploads: true, makeSafe: false });
  });

  it('push is a dry run without --yes and never deletes or sends the database by default', () => {
    expect(parseArgs(['push', 'mysite', 'staging'])).toEqual({
      command: 'push',
      site: 'mysite',
      environment: 'staging',
      includeDatabase: false,
      includeUploads: false,
      mode: 'newer',
      deletions: false,
      yes: false,
      production: false,
      includeStale: false,
    });
    expect(parseArgs(['undo', 'mysite', 'staging'])).toEqual({
      command: 'undo',
      site: 'mysite',
      environment: 'staging',
      yes: false,
      production: false,
    });
    expect(
      parseArgs(['pull', 'mysite', 'staging', '--accept-site-url=https://live.example.com']),
    ).toMatchObject({ acceptSiteUrl: 'https://live.example.com' });
    expect(
      parseArgs(['push', 'mysite', 'staging', '--yes', '--delete', '--db', '--all-modified']),
    ).toMatchObject({
      yes: true,
      deletions: true,
      includeDatabase: true,
      mode: 'all',
    });
  });

  it('rejects unknown options and missing arguments', () => {
    expect(parseArgs(['pull', 'mysite', 'production', '--force'])).toHaveProperty('error');
    expect(parseArgs(['pull', 'mysite'])).toHaveProperty('error');
    expect(parseArgs(['nope', 'mysite', 'x'])).toHaveProperty('error');
    expect(parseArgs(['envs', 'mysite'])).toEqual({ command: 'envs', site: 'mysite' });
  });
});

describe('isStaleLocalOnly', () => {
  it('flags only files that exist locally and predate the last pull', () => {
    const pull = Date.parse('2026-11-12T10:00:00Z');
    expect(isStaleLocalOnly({ op: 'add', localMtime: pull - 1000 }, pull)).toBe(true);
    expect(isStaleLocalOnly({ op: 'add', localMtime: pull + 1000 }, pull)).toBe(false);
    expect(isStaleLocalOnly({ op: 'update', localMtime: pull - 1000 }, pull)).toBe(false);
    expect(isStaleLocalOnly({ op: 'add', localMtime: pull - 1000 }, null)).toBe(false);
    expect(isStaleLocalOnly({ op: 'add' }, pull)).toBe(false);
    expect(
      lastPullFrom(
        [
          { mode: 'push', environmentId: 'a', at: '2026-11-12T11:00:00Z' },
          { mode: 'pull', environmentId: 'b', at: '2026-11-12T10:30:00Z' },
          { mode: 'pull', environmentId: 'a', at: '2026-11-12T10:00:00Z' },
        ],
        'a',
      ),
    ).toBe(pull);
  });
});

describe('findLocalSite', () => {
  const sites = JSON.stringify({
    abc123: {
      id: 'abc123',
      name: 'My Site',
      path: '/Users/x/Local Sites/my-site',
      domain: 'my-site.local',
      mysql: { database: 'local', user: 'root', password: 'root' },
      multiSite: '',
    },
  });

  it('matches by name, id or domain, case-insensitively', () => {
    for (const q of ['My Site', 'my site', 'abc123', 'my-site.local']) {
      expect(findLocalSite(sites, q)?.id).toBe('abc123');
    }
    expect(findLocalSite(sites, 'other')).toBeNull();
    expect(findLocalSite('not json', 'x')).toBeNull();
  });
});

describe('cli socket', () => {
  it('answers one request with streamed JSON lines and a private socket', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-sync-cli-'));
    const socketPath = path.join(dir, 'cli.sock');
    const server = startCliServer(socketPath, async (request, send) => {
      send({ type: 'progress', progress: 50, message: `half of ${request.site}` });
      send({ type: 'result', success: true, message: 'done' });
    });
    await new Promise((r) => server.once('listening', r));
    expect(fs.statSync(socketPath).mode & 0o077).toBe(0);

    const messages: CliMessage[] = await new Promise((resolve) => {
      let buffer = '';
      const c = net.connect(socketPath, () =>
        c.write(`${JSON.stringify({ command: 'envs', site: 'x' })}\n`),
      );
      c.on('data', (d) => (buffer += d));
      c.on('end', () =>
        resolve(
          buffer
            .trim()
            .split('\n')
            .map((l) => JSON.parse(l)),
        ),
      );
    });
    expect(messages).toEqual([
      { type: 'progress', progress: 50, message: 'half of x' },
      { type: 'result', success: true, message: 'done' },
    ]);
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('cli socket disconnect', () => {
  it('tells the handler when the client goes away mid-request', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-sync-cli-'));
    const socketPath = path.join(dir, 'cli.sock');
    let disconnected!: () => void;
    const gone = new Promise<void>((r) => (disconnected = r));
    const server = startCliServer(socketPath, async (_request, _send, onDisconnect) => {
      onDisconnect(disconnected);
      await gone;
    });
    await new Promise((r) => server.once('listening', r));
    const c = net.connect(socketPath, () => {
      c.write(`${JSON.stringify({ command: 'envs', site: 'x' })}\n`);
      setTimeout(() => c.destroy(), 50);
    });
    await gone;
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('cliLauncherScript', () => {
  it('quotes every path for sh', () => {
    const script = cliLauncherScript(
      "/Applications/Local's.app/Contents/MacOS/Local",
      '/x/lib/main/cli.js',
      '/Users/x/Library/Application Support/Local/addons-data/ssh-sync/cli.sock',
    );
    expect(script).toContain(`'/Applications/Local'\\''s.app/Contents/MacOS/Local'`);
    expect(script).toContain(
      `SSHSYNC_SOCKET='/Users/x/Library/Application Support/Local/addons-data/ssh-sync/cli.sock'`,
    );
    expect(script).toContain('ELECTRON_RUN_AS_NODE=1 exec');
  });
});
