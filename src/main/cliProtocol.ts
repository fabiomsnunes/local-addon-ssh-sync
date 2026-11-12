import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';

import { SiteInfo } from './types';

// The `ssh-sync` command talks to the add-on's main process over a unix socket
// in the add-on's data dir: one JSON request line in, JSON lines out
// (progress events, then one result). Same engine, same guards, same history
// as the UI.

export type CliRequest =
  | { command: 'envs'; site: string }
  | { command: 'test'; site: string; environment: string }
  | {
      command: 'pull';
      site: string;
      environment: string;
      includeDatabase: boolean;
      includeUploads: boolean;
      makeSafe: boolean;
      acceptSiteUrl?: string;
    }
  | {
      command: 'push';
      site: string;
      environment: string;
      includeDatabase: boolean;
      includeUploads: boolean;
      mode: 'newer' | 'all';
      deletions: boolean;
      yes: boolean;
      production: boolean;
      includeStale: boolean;
      acceptSiteUrl?: string;
    }
  | {
      command: 'undo';
      site: string;
      environment: string;
      yes: boolean;
      production: boolean;
      acceptSiteUrl?: string;
    };

export type CliMessage =
  | { type: 'progress'; progress: number; message: string }
  | { type: 'output'; text: string }
  | { type: 'result'; success: boolean; message?: string };

export const CLI_SOCKET_NAME = 'cli.sock';

// Local's own sites.json (userData) is the source of truth for site paths,
// domains and database credentials. A site is matched by name, id or domain.
export function findLocalSite(sitesJson: string, nameIdOrDomain: string): SiteInfo | null {
  let sites: Record<string, any>;
  try {
    sites = JSON.parse(sitesJson);
  } catch {
    return null;
  }
  const wanted = nameIdOrDomain.trim().toLowerCase();
  const match = Object.values(sites).find(
    (s: any) =>
      String(s.id).toLowerCase() === wanted ||
      String(s.name).toLowerCase() === wanted ||
      String(s.domain).toLowerCase() === wanted,
  );
  if (!match) return null;
  return {
    id: match.id,
    name: match.name,
    path: match.path,
    domain: match.domain,
    multiSite: match.multiSite,
    mysql: match.mysql,
  };
}

export function readLocalSite(userDataPath: string, nameIdOrDomain: string): SiteInfo | null {
  try {
    return findLocalSite(
      fs.readFileSync(path.join(userDataPath, 'sites.json'), 'utf8'),
      nameIdOrDomain,
    );
  } catch {
    return null;
  }
}

export function startCliServer(
  socketPath: string,
  handle: (
    request: CliRequest,
    send: (message: CliMessage) => void,
    onDisconnect: (callback: () => void) => void,
  ) => Promise<void>,
): net.Server {
  try {
    fs.unlinkSync(socketPath); // a stale socket from a crashed session
  } catch {
    // none
  }
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    let handled = false;
    // A client that goes away (Ctrl-C, closed terminal) cancels its sync
    const disconnectCallbacks: Array<() => void> = [];
    let finished = false;
    socket.on('close', () => {
      if (!finished) disconnectCallbacks.forEach((callback) => callback());
    });
    const send = (message: CliMessage) => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
    };
    socket.on('data', (chunk) => {
      if (handled) return;
      buffer += chunk.toString();
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      handled = true;
      let request: CliRequest;
      try {
        request = JSON.parse(buffer.slice(0, newline));
      } catch {
        send({ type: 'result', success: false, message: 'Malformed request.' });
        socket.end();
        return;
      }
      handle(request, send, (callback) => disconnectCallbacks.push(callback))
        .catch((e: any) => send({ type: 'result', success: false, message: e?.message }))
        .finally(() => {
          finished = true;
          socket.end();
        });
    });
    socket.on('error', () => socket.destroy());
  });
  server.listen(socketPath, () => {
    try {
      fs.chmodSync(socketPath, 0o600);
    } catch {
      // best effort: the data dir itself is 0700
    }
  });
  return server;
}

// The launcher installed next to Local's own `localwp`: runs the client with
// Local's Electron as Node, pointed at this installation's socket.
export function cliLauncherScript(
  electronPath: string,
  cliScript: string,
  socketPath: string,
): string {
  const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
  return [
    '#!/bin/sh',
    '# SSH Sync for Local: pull and push sites over SSH from the terminal.',
    `SSHSYNC_SOCKET=${q(socketPath)} ELECTRON_RUN_AS_NODE=1 exec ${q(electronPath)} ${q(cliScript)} "$@"`,
    '',
  ].join('\n');
}

// A file only in Local, older than the last pull from that environment, was
// most likely deleted on the server since (or is a leftover of the Local
// install): pushing it would bring it back. Needs the mtime from the preview.
export function isStaleLocalOnly(
  row: { op: string; isDir?: boolean; localMtime?: number },
  lastPullMs: number | null,
): boolean {
  return (
    row.op === 'add' &&
    !row.isDir &&
    lastPullMs !== null &&
    typeof row.localMtime === 'number' &&
    row.localMtime < lastPullMs
  );
}

export function lastPullFrom(
  history: { mode: string; environmentId: string; at: string }[] | undefined,
  environmentId: string,
): number | null {
  const pull = (history || []).find((h) => h.mode === 'pull' && h.environmentId === environmentId);
  return pull ? Date.parse(pull.at) : null;
}
