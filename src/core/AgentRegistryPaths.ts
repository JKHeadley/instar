import os from 'node:os';
import path from 'node:path';

/** Explicit process-local isolation for real startup trials. Inherited by
 * child processes without changing HOME or the production default. All
 * registry files, migration sources and locks share this one directory. */
export function agentRegistryDir(): string {
  const override = process.env.INSTAR_TEST_REGISTRY_DIR;
  if (override === undefined) return path.join(os.homedir(), '.instar');
  if (!override || override.includes('\0') || !path.isAbsolute(override) || path.resolve(override) === path.parse(override).root) {
    throw new Error('INSTAR_TEST_REGISTRY_DIR must be a nonempty absolute directory path');
  }
  return path.resolve(override);
}

export function agentRegistryPath(): string {
  return path.join(agentRegistryDir(), 'registry.json');
}
