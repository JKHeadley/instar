import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

export const liveGeminiSmokeEnabled = process.env.INSTAR_TEST_LIVE_GEMINI === '1';

/**
 * Run the real command in an empty workspace with its own Gemini trust file.
 * The surrounding verifier keeps its normal home for browser and other tests.
 * Set INSTAR_TEST_LIVE_GEMINI=1 in an already trusted, credentialed checkout
 * to exercise the live model assertion.
 */
export async function withGeminiSmokeWorkspace<T>(run: () => Promise<T>): Promise<T> {
  if (liveGeminiSmokeEnabled) return run();

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'instar-gemini-smoke-'));
  const previousCwd = process.cwd();
  const home = path.join(root, 'home');
  const isolatedEnv = {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, 'config'),
    XDG_DATA_HOME: path.join(home, 'data'),
    XDG_CACHE_HOME: path.join(home, 'cache'),
    XDG_STATE_HOME: path.join(home, 'state'),
    GEMINI_SYSTEM_MD: undefined,
  };
  const previousEnv = Object.keys(isolatedEnv).map((key) => [key, process.env[key]] as const);
  try {
    const settings = path.join(home, '.gemini');
    const workspace = path.join(root, 'workspace');
    await fs.mkdir(settings, { recursive: true, mode: 0o700 });
    await fs.mkdir(workspace, { mode: 0o700 });
    const trustedPath = await fs.realpath(workspace);
    await fs.writeFile(
      path.join(settings, 'trustedFolders.json'),
      JSON.stringify({ [trustedPath]: 'TRUST_FOLDER' }),
      { mode: 0o600 },
    );

    process.chdir(trustedPath);
    for (const [key, value] of Object.entries(isolatedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await run();
  } finally {
    process.chdir(previousCwd);
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await SafeFsExecutor.safeRm(root, { recursive: true, force: true, operation: 'test:gemini-smoke-workspace:cleanup' });
  }
}
