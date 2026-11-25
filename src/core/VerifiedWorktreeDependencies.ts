import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { withSyncOp } from './InFlightSyncOpMarker.js';

export type VerifiedDependencyOutcome = 'disabled' | 'verified-clone' | 'private-install';

function absent(file: string): boolean {
  try {
    fs.lstatSync(file);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

/** A checkout never supplies the helper or its expected digest. */
export function provisionVerifiedWorktreeDependencies(
  agentHome: string,
  checkout: string,
  shareNodeModules: boolean,
): VerifiedDependencyOutcome {
  if (!shareNodeModules) return 'disabled';
  const state = path.join(agentHome, '.instar');
  const configPath = path.join(state, 'config.json');
  if (absent(configPath)) return 'disabled';
  let settings: { verifiedDependencyStore?: boolean; verifiedDependencyHelperSha256?: string } | undefined;
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { worktree?: typeof settings } | null;
    settings = config?.worktree;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return 'disabled';
  }
  if (settings?.verifiedDependencyStore !== true) return 'disabled';

  const destination = path.join(checkout, 'node_modules');
  const store = path.join(state, 'state', 'studio-worktree-dependencies');
  const helper = path.join(store, 'bin', 'verified-worktree-dependencies');
  if (!absent(destination)) throw new Error('Verified dependencies require an absent checkout node_modules');
  if (process.platform !== 'darwin' || absent(helper)) return 'private-install';

  const expected = settings.verifiedDependencyHelperSha256;
  const stat = fs.lstatSync(helper);
  if (
    typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected) ||
    !stat.isFile() || (stat.mode & 0o111) === 0 ||
    fs.realpathSync(helper) !== helper ||
    createHash('sha256').update(fs.readFileSync(helper)).digest('hex') !== expected
  ) {
    return 'private-install';
  }

  try {
    withSyncOp(() => execFileSync(helper, [checkout, store, fs.realpathSync(process.execPath)], {
      cwd: agentHome,
      env: { PATH: '/usr/bin:/bin', LANG: 'C' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300_000,
    }));
  } catch (error) {
    const failure = error as { status?: number };
    // The helper may signal a clean recipe miss only before writing a target
    // or after verifying that it removed its own staging directory.
    if (failure.status === 3 && absent(destination)) return 'private-install';
    throw new Error('Verified dependency provisioning failed; inspect the checkout before retrying', { cause: error });
  }

  if (!fs.lstatSync(destination).isDirectory() || fs.realpathSync(destination) !== destination) {
    throw new Error('Verified dependency provider did not create a private dependency directory');
  }
  return 'verified-clone';
}
