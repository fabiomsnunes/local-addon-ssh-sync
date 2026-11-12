// `ssh-sync`: the terminal client. Runs with Local's Electron as Node (see
// cliLauncherScript) and forwards one request to the running add-on.
import * as net from 'net';

import { CliMessage, CliRequest } from './cliProtocol';

const USAGE = `Usage: ssh-sync <command> <site> [environment] [options]

Commands:
  envs <site>                     List the site's server environments
  test <site> <env>               Connect and check the WordPress folder
  pull <site> <env>               Pull files and database into Local
      --no-db                       Files only
      --uploads                     Include wp-content/uploads
      --unsafe                      Do not make the local copy safe
  push <site> <env>               Show what a push would change (dry run)
      --yes                         Push the listed files
      --delete                      Also delete the listed remote-only files
      --db                          Also push the database (never to production)
      --uploads                     Include wp-content/uploads
      --all-modified                Every changed file, not only newer ones

<site> is the Local site name, id or domain; <env> the environment name or id.
Local must be running.`;

export function parseArgs(argv: string[]): CliRequest | { error: string } {
  const [command, site, environment, ...rest] = argv;
  const flags = new Set(rest.filter((a) => a.startsWith('--')));
  const unknown = [...flags].filter(
    (f) =>
      !['--no-db', '--uploads', '--unsafe', '--yes', '--delete', '--db', '--all-modified'].includes(
        f,
      ),
  );
  if (!command || command === 'help' || command === '--help') return { error: USAGE };
  if (unknown.length) return { error: `Unknown option ${unknown[0]}\n\n${USAGE}` };
  if (!site) return { error: `Missing <site>\n\n${USAGE}` };
  if (command === 'envs') return { command, site };
  if (!environment) return { error: `Missing <env>\n\n${USAGE}` };
  if (command === 'test') return { command, site, environment };
  if (command === 'pull') {
    return {
      command,
      site,
      environment,
      includeDatabase: !flags.has('--no-db'),
      includeUploads: flags.has('--uploads'),
      makeSafe: !flags.has('--unsafe'),
    };
  }
  if (command === 'push') {
    return {
      command,
      site,
      environment,
      includeDatabase: flags.has('--db'),
      includeUploads: flags.has('--uploads'),
      mode: flags.has('--all-modified') ? 'all' : 'newer',
      deletions: flags.has('--delete'),
      yes: flags.has('--yes'),
    };
  }
  return { error: `Unknown command ${command}\n\n${USAGE}` };
}

function run(): void {
  const request = parseArgs(process.argv.slice(2));
  if ('error' in request) {
    process.stderr.write(`${request.error}\n`);
    process.exit(request.error === USAGE ? 0 : 2);
  }
  const socketPath = process.env.SSHSYNC_SOCKET;
  if (!socketPath) {
    process.stderr.write(
      'SSHSYNC_SOCKET is not set: reinstall the command from SSH Sync in Local.\n',
    );
    process.exit(2);
  }

  const tty = Boolean(process.stdout.isTTY);
  let lastProgress = '';
  let buffer = '';
  let exitCode = 1;
  const socket = net.connect(socketPath!);
  socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
  socket.on('error', () => {
    process.stderr.write('Could not reach SSH Sync: is Local running with the add-on enabled?\n');
    process.exit(1);
  });
  socket.on('data', (chunk) => {
    buffer += chunk.toString();
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, newline)) as CliMessage;
      buffer = buffer.slice(newline + 1);
      if (message.type === 'progress') {
        const line = `${String(message.progress).padStart(3)}% ${message.message}`;
        if (tty) process.stdout.write(`\r\x1b[K${line}`);
        else if (message.message !== lastProgress) process.stdout.write(`${line}\n`);
        lastProgress = message.message;
      } else if (message.type === 'output') {
        if (tty && lastProgress) process.stdout.write('\r\x1b[K');
        process.stdout.write(`${message.text}\n`);
      } else {
        if (tty && lastProgress) process.stdout.write('\n');
        if (message.message) {
          (message.success ? process.stdout : process.stderr).write(`${message.message}\n`);
        }
        exitCode = message.success ? 0 : 1;
      }
    }
  });
  socket.on('end', () => process.exit(exitCode));
}

if (require.main === module) run();
