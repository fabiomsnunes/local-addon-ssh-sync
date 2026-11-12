import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { spawn, spawnSync } from 'child_process';
import * as net from 'net';

import { REMOTE_TEMP_PREFIX } from './constants';
import { remoteDomainFromUrl } from './validators';
import { ActiveSync, RemoteConnection, RunOptions, ServerEnvironment } from './types';

type RunCommand = (
  sync: ActiveSync,
  cmd: string,
  args: string[],
  opts?: RunOptions,
) => Promise<{ code: number; stderr: string }>;

// POSIX single-quoting: safe for any string inside a remote shell command.
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// Quote a user-entered remote path for `cd`, keeping a leading ~ expandable.
export function remoteCdPath(remotePath: string): string {
  if (remotePath === '~') return '~';
  if (remotePath.startsWith('~/')) return `~/${shellQuote(remotePath.slice(2))}`;
  return shellQuote(remotePath);
}

export function sshTarget(environment: ServerEnvironment): string {
  if (environment.sshAlias) return environment.sshAlias;
  return `${environment.sshUser}@${environment.sshHost}`;
}

// Options shared by ssh, scp and rsync's `-e` remote shell. Port goes in as
// `-o Port=` because scp spells the short flag differently (-P). With an alias,
// ~/.ssh/config owns the port. No option value may contain whitespace: rsync
// word-splits its -e string.
export function baseSshOptions(environment: ServerEnvironment, controlPath?: string): string[] {
  const options = [
    '-o',
    'StrictHostKeyChecking=accept-new',
    // Keep the connection alive on long-running steps (big rsync, slow
    // mysqldump/import) so an idle NAT/firewall can't drop the channel
    // mid-sync: probe every 60s, give up only after 120 missed probes.
    '-o',
    'ServerAliveInterval=60',
    '-o',
    'ServerAliveCountMax=120',
  ];
  if (!environment.sshAlias && environment.sshPort) {
    options.push('-o', `Port=${environment.sshPort}`);
  }
  if (controlPath) {
    // Clients only ride the master: if it is gone they fail instead of
    // authenticating again (and possibly prompting on Local's terminal).
    options.push(
      '-o',
      `ControlPath=${controlPath}`,
      '-o',
      'ControlMaster=no',
      '-o',
      'BatchMode=yes',
    );
  }
  return options;
}

export function sshArgs(connection: RemoteConnection, remoteCommand: string): string[] {
  return [...connection.sshOptions, connection.target, remoteCommand];
}

export function scpArgs(connection: RemoteConnection, from: string, to: string): string[] {
  return [...connection.sshOptions, from, to];
}

export function remoteFileSpec(connection: RemoteConnection, remoteFile: string): string {
  return `${connection.target}:${remoteFile}`;
}

// rsync's `-e` value (one string, word-split by rsync)
export function rsyncRemoteShell(connection: RemoteConnection): string {
  return ['ssh', ...connection.sshOptions].join(' ');
}

// rsync's remote side of the transfer: the WordPress root, trailing slash so
// its contents (not the folder itself) are synced.
export function rsyncRemoteRoot(connection: RemoteConnection): string {
  return `${connection.target}:${connection.remoteRoot}/`;
}

export function inRemoteRoot(connection: RemoteConnection, command: string): string {
  return `cd ${shellQuote(connection.remoteRoot)} && ${command}`;
}

export function remoteWp(
  connection: RemoteConnection,
  environment: ServerEnvironment,
  wpArgs: string,
): string {
  return inRemoteRoot(connection, `${environment.wpCommand} ${wpArgs}`);
}

// A private (0600) temp file in the SSH user's home: never a fixed name in a
// shared /tmp, where other accounts on the server could read or pre-create it.
export const REMOTE_MKTEMP = `mktemp "$HOME/${REMOTE_TEMP_PREFIX}XXXXXXXX"`;

const REMOTE_TEMP_FILE_RE = new RegExp(
  `^/[A-Za-z0-9_./@+-]*/${REMOTE_TEMP_PREFIX.replace(/\./g, '\\.')}[A-Za-z0-9]+$`,
);

// The path a remote mktemp printed (last line of stdout), validated before it
// is ever used in another remote command.
export function parseRemoteTempPath(stdout: string): string | null {
  const lines = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const last = lines[lines.length - 1] || '';
  return REMOTE_TEMP_FILE_RE.test(last) ? last : null;
}

// ---------------------------------------------------------------------------
// Connecting
// ---------------------------------------------------------------------------

// What the probe run right after connecting reports about the WordPress root.
export type RemoteProbeResult =
  | { ok: true; remoteRoot: string; siteUrl: string; remoteHome: string }
  | { ok: false; reason: 'path' | 'rsync' | 'wp' | 'unexpected' };

const PROBE_MARKER = 'SSHSYNC_PROBE';

export function remoteProbeCommand(environment: ServerEnvironment): string {
  return [
    `cd ${remoteCdPath(environment.remotePath)} 2>/dev/null || { echo ${PROBE_MARKER}=path; exit 0; }`,
    `printf '${PROBE_MARKER}_ROOT=%s\\n' "$(pwd -P)"`,
    // Our own dumps left by a sync that died mid-transfer (dropped connection,
    // Local closed) hold a full database: sweep any older than two hours.
    `find "$HOME" -maxdepth 1 -type f -name '${REMOTE_TEMP_PREFIX}*' -mmin +120 -delete 2>/dev/null`,
    `command -v rsync >/dev/null 2>&1 || { echo ${PROBE_MARKER}=rsync; exit 0; }`,
    `${environment.wpCommand} --skip-plugins --skip-themes core is-installed >/dev/null 2>&1 || { echo ${PROBE_MARKER}=wp; exit 0; }`,
    // The site WordPress says lives here, to catch a folder that belongs to
    // another site on the same server
    `printf '${PROBE_MARKER}_URL=%s\\n' "$(${environment.wpCommand} --skip-plugins --skip-themes option get siteurl 2>/dev/null)"`,
    `printf '${PROBE_MARKER}_HOME=%s\\n' "$HOME"`,
    `echo ${PROBE_MARKER}=ok`,
  ].join('; ');
}

export function parseRemoteProbe(stdout: string): RemoteProbeResult {
  const status = stdout.match(new RegExp(`${PROBE_MARKER}=(\\w+)`));
  if (!status) return { ok: false, reason: 'unexpected' };
  if (status[1] !== 'ok') {
    const reason = status[1] as 'path' | 'rsync' | 'wp';
    return ['path', 'rsync', 'wp'].includes(reason)
      ? { ok: false, reason }
      : { ok: false, reason: 'unexpected' };
  }
  const root = stdout.match(new RegExp(`${PROBE_MARKER}_ROOT=(.*)`));
  const remoteRoot = root ? root[1].trim() : '';
  // The root goes into rsync's remote spec and every remote command: refuse
  // anything outside a conservative character set.
  if (!/^\/[A-Za-z0-9_./@+-]*$/.test(remoteRoot)) return { ok: false, reason: 'unexpected' };
  const siteUrl = (stdout.match(new RegExp(`${PROBE_MARKER}_URL=(.*)`)) || [])[1]?.trim() || '';
  const remoteHome = (stdout.match(new RegExp(`${PROBE_MARKER}_HOME=(.*)`)) || [])[1]?.trim() || '';
  if (!/^\/[A-Za-z0-9_./@+-]*$/.test(remoteHome)) return { ok: false, reason: 'unexpected' };
  return { ok: true, remoteRoot, siteUrl, remoteHome };
}

// The probed siteurl must be the configured site (host and path; http/https
// and a trailing slash do not matter). A different one means the folder
// belongs to another site on the same server: refuse before any transfer.
export function siteUrlMismatch(environment: ServerEnvironment, siteUrl: string): string | null {
  const expected = remoteDomainFromUrl(environment.remoteUrl);
  const actual = remoteDomainFromUrl(siteUrl);
  if (expected && actual && expected.toLowerCase() === actual.toLowerCase()) return null;
  return `The WordPress in "${environment.remotePath}" is ${siteUrl || 'a site without a readable siteurl'}, not ${environment.remoteUrl}. Fix the WordPress folder or the site URL of ${environment.label}.`;
}

export function describeProbeFailure(
  reason: Exclude<RemoteProbeResult, { ok: true }>['reason'],
  environment: ServerEnvironment,
): string {
  switch (reason) {
    case 'path':
      return `The WordPress folder "${environment.remotePath}" does not exist on the server.`;
    case 'rsync':
      return 'rsync is not installed on the server. SSH Sync needs it to transfer files.';
    case 'wp':
      return `WP-CLI failed in "${environment.remotePath}": check the WP-CLI command ("${environment.wpCommand}") and that WordPress is installed there.`;
    default:
      return 'The server answered in an unexpected way. Check the folder path and try again.';
  }
}

let controlDir: string | null = null;

// Open connections, so quitting Local mid-sync can still close their masters
const openConnections = new Set<RemoteConnection>();

// Masters still starting up (not yet a RemoteConnection) can be closed too
const startingMasters = new Set<() => Promise<void>>();

export async function closeAllConnections(): Promise<void> {
  await Promise.all([
    ...[...openConnections].map((connection) => connection.close()),
    ...[...startingMasters].map((close) => close()),
  ]);
}

// Short per-user folder for the multiplexing sockets: unix socket paths are
// capped at ~104 bytes on macOS, which rules out Local's
// "Application Support" data dir (and its space breaks rsync's -e splitting).
function getControlDir(): string {
  if (!controlDir || !fs.existsSync(controlDir)) {
    controlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-sync-'));
  }
  return controlDir;
}

// Our control dirs hold only sockets and the password-free askpass helper.
// Removed on quit; ones left by a crash are swept at the next start.
export function removeControlDir(): void {
  if (!controlDir) return;
  try {
    fs.rmSync(controlDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
  controlDir = null;
}

export function sweepStaleControlDirs(olderThanMs = 24 * 60 * 60 * 1000): void {
  const tmp = os.tmpdir();
  let entries: string[];
  try {
    entries = fs.readdirSync(tmp);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!/^ssh-sync-[A-Za-z0-9]{6}$/.test(entry)) continue;
    const dir = path.join(tmp, entry);
    try {
      // Only folders that look like ours: master sockets, askpass sockets
      // and the helper, nothing else
      const ours = fs
        .readdirSync(dir)
        .every((name) => /^(cm|ap)-[0-9a-f]{8}$/.test(name) || name === 'askpass.sh');
      if (ours && Date.now() - fs.statSync(dir).mtimeMs > olderThanMs) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      // another process's dir, or already gone
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function masterIsReady(target: string, controlPath: string): boolean {
  const check = spawnSync('ssh', ['-o', `ControlPath=${controlPath}`, '-O', 'check', target], {
    stdio: 'ignore',
  });
  return check.status === 0;
}

// The multiplexed master of one sync. ControlPersist=no overrides a user's own
// `ControlPersist` (common in `Host *`), which would otherwise fork the master
// into the background, out of our reach, and leave it running after the sync.
export function masterSshArgs(environment: ServerEnvironment, controlPath: string): string[] {
  const authOptions =
    environment.auth === 'password'
      ? [
          // The password arrives through SSH_ASKPASS (see askpassEnvironment);
          // one attempt only, so a wrong password fails fast instead of
          // counting towards the server's fail2ban limit.
          '-o',
          'PubkeyAuthentication=no',
          '-o',
          'PreferredAuthentications=password,keyboard-interactive',
          '-o',
          'NumberOfPasswordPrompts=1',
        ]
      : [
          // Key auth never prompts: a missing key or unknown passphrase fails
          // fast instead of hanging on a prompt nobody can see.
          '-o',
          'BatchMode=yes',
        ];
  return [
    ...baseSshOptions(environment),
    '-o',
    `ControlPath=${controlPath}`,
    '-o',
    'ControlMaster=yes',
    '-o',
    'ControlPersist=no',
    '-o',
    'ConnectTimeout=15',
    ...authOptions,
    '-N',
    sshTarget(environment),
  ];
}

// The SSH_ASKPASS helper ssh runs when it needs the password. It holds no
// secret: it reads the password from a one-shot unix socket the main process
// serves in the private control dir, so the password never appears in argv,
// in an environment variable or in a file.
const ASKPASS_SCRIPT = `#!/bin/sh
ELECTRON_RUN_AS_NODE=1 exec "$SSHSYNC_ASKPASS_NODE" -e 'const s=require("net").connect(process.env.SSHSYNC_ASKPASS_SOCKET);s.pipe(process.stdout);s.on("error",()=>process.exit(1))'
`;

export function askpassHelperPath(): string {
  const helper = path.join(getControlDir(), 'askpass.sh');
  if (!fs.existsSync(helper)) {
    fs.writeFileSync(helper, ASKPASS_SCRIPT, { mode: 0o700 });
  }
  return helper;
}

export function askpassEnvironment(helper: string, socketPath: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    SSH_ASKPASS: helper,
    // OpenSSH >= 8.4: use the helper even with no display or a terminal
    SSH_ASKPASS_REQUIRE: 'force',
    DISPLAY: process.env.DISPLAY || ':0',
    SSHSYNC_ASKPASS_NODE: process.execPath,
    SSHSYNC_ASKPASS_SOCKET: socketPath,
  };
}

// Answers the helper with the password, at most `maxAnswers` times, then
// closes: a wrong password is tried once, not once per auth method.
export function serveAskpass(socketPath: string, password: string, maxAnswers = 1): net.Server {
  let answers = 0;
  const server = net.createServer((socket) => {
    answers += 1;
    socket.end(`${password}\n`);
    if (answers >= maxAnswers) server.close();
  });
  server.listen(socketPath);
  return server;
}

// Start the multiplexed master for this sync as our own child process, wait
// until it accepts clients, then probe the WordPress root.
export async function openRemoteConnection(
  environment: ServerEnvironment,
  runCommand: RunCommand,
  password: string | null = null,
): Promise<RemoteConnection> {
  const target = sshTarget(environment);
  if (environment.auth === 'password' && !password) {
    throw new Error(
      `No password saved for ${environment.label}. Edit the environment and enter it.`,
    );
  }
  const connectionId = randomBytes(4).toString('hex');
  const controlPath = path.join(getControlDir(), `cm-${connectionId}`);
  const masterArgs = masterSshArgs(environment, controlPath);

  let askpassServer: net.Server | null = null;
  let masterEnv: NodeJS.ProcessEnv = process.env;
  if (environment.auth === 'password') {
    const askpassSocket = path.join(getControlDir(), `ap-${connectionId}`);
    askpassServer = serveAskpass(askpassSocket, password!);
    masterEnv = askpassEnvironment(askpassHelperPath(), askpassSocket);
  }
  const stopAskpass = () => {
    askpassServer?.close();
    askpassServer = null;
  };

  const master = spawn('ssh', masterArgs, {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: masterEnv,
    // No controlling terminal, so ssh can never fall back to prompting on a tty
    detached: environment.auth === 'password',
  });
  let masterStderr = '';
  let masterExited = false;
  master.stderr!.on('data', (d: Buffer) => {
    masterStderr = (masterStderr + d.toString()).slice(-2000);
  });
  master.on('exit', () => {
    masterExited = true;
  });
  master.on('error', (e) => {
    masterExited = true;
    masterStderr += e.message;
  });

  // Ask through the socket even when our child already exited: the master
  // may still be alive elsewhere if ssh forked it after all.
  let registered: RemoteConnection | null = null;
  const close = async (): Promise<void> => {
    stopAskpass();
    if (registered) openConnections.delete(registered);
    spawnSync('ssh', ['-o', `ControlPath=${controlPath}`, '-O', 'exit', target], {
      stdio: 'ignore',
    });
    if (!masterExited) master.kill('SIGTERM');
    try {
      fs.unlinkSync(controlPath);
    } catch {
      // ssh normally removes its socket on exit
    }
  };

  startingMasters.add(close);
  const deadline = Date.now() + 20_000;
  while (!masterIsReady(target, controlPath)) {
    if (masterExited || Date.now() > deadline) {
      startingMasters.delete(close);
      await close();
      const detail = masterStderr.trim().split('\n').slice(-3).join('\n');
      throw new Error(`Could not connect to ${target} over SSH.${detail ? `\n${detail}` : ''}`);
    }
    await sleep(200);
  }
  // Authenticated: the password is no longer needed by anyone
  stopAskpass();

  startingMasters.delete(close);
  const connection: RemoteConnection = {
    target,
    sshOptions: baseSshOptions(environment, controlPath),
    remoteRoot: '',
    remoteHome: '',
    siteUrl: '',
    close,
  };
  registered = connection;
  openConnections.add(connection);

  let probeOutput = '';
  try {
    await runCommand(
      { cancelled: false, child: null },
      'ssh',
      sshArgs(connection, remoteProbeCommand(environment)),
      { onStdout: (chunk) => (probeOutput += chunk) },
    );
  } catch (e: any) {
    await close();
    throw new Error(`Connected to ${target}, but the server check failed: ${e.message}`);
  }
  const probe = parseRemoteProbe(probeOutput);
  if (!probe.ok) {
    await close();
    throw new Error(describeProbeFailure(probe.reason, environment));
  }
  const mismatch = siteUrlMismatch(environment, probe.siteUrl);
  if (mismatch) {
    await close();
    throw new Error(mismatch);
  }
  connection.remoteRoot = probe.remoteRoot;
  connection.remoteHome = probe.remoteHome;
  connection.siteUrl = probe.siteUrl;
  return connection;
}

// Host aliases declared in an ssh_config file, without wildcard patterns or
// negations (those are defaults, not connectable hosts).
export function parseSshConfigHosts(config: string): string[] {
  const hosts = new Set<string>();
  for (const raw of config.split('\n')) {
    const match = raw.trim().match(/^Host\s+(.+)$/i);
    if (!match) continue;
    for (const name of match[1].split(/\s+/)) {
      if (!/[*?!]/.test(name) && isConnectableAlias(name)) hosts.add(name);
    }
  }
  return [...hosts].sort((a, b) => a.localeCompare(b));
}

function isConnectableAlias(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);
}

export function listSshConfigHosts(
  configPath = path.join(os.homedir(), '.ssh', 'config'),
): string[] {
  try {
    return parseSshConfigHosts(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return [];
  }
}
