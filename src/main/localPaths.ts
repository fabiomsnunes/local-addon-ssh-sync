import * as path from 'path';
import * as fs from 'fs';

// ---------------------------------------------------------------------------
// Local-installation paths (derived from the Context API, not hardcoded)
// ---------------------------------------------------------------------------

// Set from context via initLocalPaths() in the exported entry point
let userDataPath = '';
let appPath = '';

export function initLocalPaths(newUserDataPath: string, newAppPath: string): void {
  userDataPath = newUserDataPath;
  appPath = newAppPath;
}

export function getServicesPath(): string {
  return path.join(userDataPath, 'lightning-services');
}

export function getMysqlSocketPath(localSiteId: string): string {
  return path.join(userDataPath, 'run', localSiteId, 'mysql', 'mysqld.sock');
}

// Find a binary (mysql/mysqldump/php) inside Local's lightning-services
export function findServiceBinary(prefixes: string[], binName: string): string | null {
  const servicesPath = getServicesPath();
  if (!fs.existsSync(servicesPath)) return null;
  const dirs = fs
    .readdirSync(servicesPath)
    .filter((d) => prefixes.some((p) => d.startsWith(p)))
    .sort()
    .reverse();
  const archDirs =
    process.arch === 'arm64'
      ? [`${process.platform}-arm64`, `${process.platform}-x64`]
      : [`${process.platform}-x64`, `${process.platform}-arm64`];
  for (const dir of dirs) {
    for (const archDir of archDirs) {
      const candidate = path.join(servicesPath, dir, 'bin', archDir, 'bin', binName);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export function findWpCliPhar(): string | null {
  const candidates = [
    // appPath is typically <App>/Contents/Resources/app.asar
    appPath && path.resolve(appPath, '..', 'extraResources', 'bin', 'wp-cli', 'wp-cli.phar'),
    appPath && path.resolve(appPath, '..', '..', 'extraResources', 'bin', 'wp-cli', 'wp-cli.phar'),
    (process as any).resourcesPath &&
      path.join((process as any).resourcesPath, 'extraResources', 'bin', 'wp-cli', 'wp-cli.phar'),
    '/Applications/Local.app/Contents/Resources/extraResources/bin/wp-cli/wp-cli.phar',
  ].filter(Boolean) as string[];
  return candidates.find((c) => fs.existsSync(c)) || null;
}
