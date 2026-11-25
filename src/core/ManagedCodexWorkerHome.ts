import fs from 'node:fs';
import path from 'node:path';
import { assertGraphLocalPath, ensureGraphLocalDirectory } from './GraphLocalFiles.js';

function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function workerHomePath(stateDir: string, workspaceDir: string, launchId: string) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(launchId)) {
    throw new Error('invalid managed launch ID');
  }
  const stateRoot = fs.realpathSync(stateDir);
  const workspace = fs.realpathSync(workspaceDir);
  const root = path.join(stateRoot, 'local', 'managed-codex-workers');
  const home = path.join(root, launchId);
  if (contains(workspace, home) || contains(home, workspace)) {
    throw new Error('managed Codex home overlaps the worker workspace');
  }
  assertGraphLocalPath(stateRoot, home);
  return { stateRoot, root, home };
}

function privateHomeIdentity(home: string): string {
  const stat = fs.lstatSync(home, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || !process.getuid || stat.uid !== BigInt(process.getuid())
      || (stat.mode & 0o077n) !== 0n) throw new Error('managed Codex home is not private');
  return [stat.dev, stat.ino, stat.birthtimeNs].join(':');
}

/** A launch consumes a fresh private home, separate from its writable workspace. */
export function createManagedCodexWorkerHome(stateDir: string, workspaceDir: string, launchId: string): { home: string; homeIdentity: string } {
  const { stateRoot, root, home } = workerHomePath(stateDir, workspaceDir, launchId);
  ensureGraphLocalDirectory(stateRoot, root);
  privateHomeIdentity(root);
  fs.mkdirSync(home, { mode: 0o700 });
  return { home, homeIdentity: privateHomeIdentity(home) };
}

/** Re-resolve a home only from the server-owned launch identity. */
export function readManagedCodexWorkerHome(stateDir: string, workspaceDir: string, launchId: string, homeIdentity: string,
): string | undefined {
  try {
    const { root, home } = workerHomePath(stateDir, workspaceDir, launchId);
    privateHomeIdentity(root);
    if (privateHomeIdentity(home) === homeIdentity) return home;
  } catch {
    return undefined;
  }
}
