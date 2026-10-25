/**
 * Real-consumer E2E. Opt-in because it spends a real Codex subscription turn.
 * This is intentionally not an argv-only test: the spawned CLI must execute
 * curl inside its workspace-write sandbox and return the server's actual code.
 * Run with RUN_REAL_CODEX_NETWORK_E2E=1 and REAL_HEALTH_TEST_URL set.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildHeadlessLaunch } from '../../src/core/frameworkSessionLaunch.js';

const runReal = process.env.RUN_REAL_CODEX_NETWORK_E2E === '1';

describe.skipIf(!runReal)('Codex worker → local Instar API lifecycle', () => {
  it('reaches /health from a real workspace-write worker despite a false user config', () => {
    const url = process.env.REAL_HEALTH_TEST_URL;
    if (!url) throw new Error('REAL_HEALTH_TEST_URL is required');
    const output = path.join(os.tmpdir(), `instar-codex-network-${process.pid}.txt`);
    const spec = buildHeadlessLaunch('codex-cli', {
      binaryPath: process.env.CODEX_BINARY ?? '/usr/local/bin/codex',
      model: process.env.CODEX_E2E_MODEL ?? 'gpt-5.6-luna',
      prompt: `Run exactly: curl -s -o /dev/null -w '%{http_code}' ${url}. Reply only HEALTH_HTTP=<the output>.`,
    });
    // Prove portability independently of this host's hand-edited config: use a
    // fresh CODEX_HOME containing auth only and no config.toml.
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-codex-home-'));
    fs.copyFileSync(path.join(os.homedir(), '.codex', 'auth.json'), path.join(codexHome, 'auth.json'));
    const args = [...spec.argv.slice(1, -1)];
    execFileSync(spec.argv[0], [...args, '-o', output, spec.argv.at(-1)!], {
      cwd: process.cwd(), timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CODEX_HOME: codexHome },
    });
    const result = fs.readFileSync(output, 'utf8').trim();
    console.log(`REAL_CODEX_WORKER_RESULT=${result}`);
    expect(result).toBe('HEALTH_HTTP=200');
  }, 130_000);
});
