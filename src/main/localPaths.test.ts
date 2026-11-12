import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  initLocalPaths,
  getServicesPath,
  getMysqlSocketPath,
  findServiceBinary,
  findWpCliPhar,
} from './localPaths';

let sandbox: string;
const CUR_ARCH = `${process.platform}-${process.arch}`;
const OTHER_ARCH = `${process.platform}-${process.arch === 'arm64' ? 'x64' : 'arm64'}`;

// Create lightning-services/<service>/bin/<archDir>/bin/<bin> and write a stub.
function makeBinary(service: string, archDir: string, bin: string) {
  const dir = path.join(sandbox, 'lightning-services', service, 'bin', archDir, 'bin');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, bin), '#!/bin/sh\n');
  return path.join(dir, bin);
}

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'kinsta-localpaths-'));
  initLocalPaths(sandbox, path.join(sandbox, 'app', 'Contents', 'Resources', 'app.asar'));
});

afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('path helpers', () => {
  it('derives the services path and per-site mysql socket from userDataPath', () => {
    expect(getServicesPath()).toBe(path.join(sandbox, 'lightning-services'));
    expect(getMysqlSocketPath('site-9')).toBe(
      path.join(sandbox, 'run', 'site-9', 'mysql', 'mysqld.sock'),
    );
  });
});

describe('findServiceBinary', () => {
  it('returns null when lightning-services does not exist', () => {
    expect(findServiceBinary(['mysql-'], 'mysql')).toBeNull();
  });

  it('finds a binary matching the prefix in the current architecture', () => {
    const expected = makeBinary('mysql-8.0.35+4', CUR_ARCH, 'mysqldump');
    expect(findServiceBinary(['mysql-', 'mariadb-'], 'mysqldump')).toBe(expected);
  });

  it('prefers the highest-sorted (latest) version directory', () => {
    makeBinary('mysql-8.0.35+4', CUR_ARCH, 'mysql');
    const newer = makeBinary('mysql-8.0.40+1', CUR_ARCH, 'mysql');
    expect(findServiceBinary(['mysql-'], 'mysql')).toBe(newer); // 8.0.40 wins over 8.0.35
  });

  it('prefers the current architecture when both arch dirs are present', () => {
    makeBinary('php-8.3.0', OTHER_ARCH, 'php');
    const preferred = makeBinary('php-8.3.0', CUR_ARCH, 'php');
    expect(findServiceBinary(['php-'], 'php')).toBe(preferred);
  });

  it('returns null when no candidate binary exists', () => {
    makeBinary('mysql-8.0.35+4', CUR_ARCH, 'mysql'); // wrong bin name
    expect(findServiceBinary(['mysql-'], 'mysqldump')).toBeNull();
  });
});

describe('findWpCliPhar', () => {
  it('finds the wp-cli phar relative to appPath', () => {
    // appPath = <sandbox>/app/Contents/Resources/app.asar; the first candidate is
    // resolve(appPath, '..', 'extraResources', 'bin', 'wp-cli', 'wp-cli.phar')
    const pharDir = path.join(
      sandbox,
      'app',
      'Contents',
      'Resources',
      'extraResources',
      'bin',
      'wp-cli',
    );
    fs.mkdirSync(pharDir, { recursive: true });
    const phar = path.join(pharDir, 'wp-cli.phar');
    fs.writeFileSync(phar, '');
    expect(findWpCliPhar()).toBe(phar);
  });
});
