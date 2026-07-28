/**
 * Unit tests for the URL-provenance sibling-node trust in convergence-check.sh.
 *
 * A multi-machine agent runs on >1 machine, each at its own subdomain under the
 * operator's tunnel domain (laptop echo.dawn-tunnel.dev, mini
 * echo-mini.dawn-tunnel.dev). The URL-provenance guard previously trusted only
 * the agent's EXACT own tunnel host, so a legitimate message addressing a
 * sibling node was flagged as an "unfamiliar domain". The fix trusts any host
 * sharing the agent's tunnel PARENT domain, with safety guards against trusting
 * a 2-label apex or a look-alike suffix.
 *
 * These tests execute the REAL shipped template script against a temp config.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, '../../src/templates/scripts/convergence-check.sh');

/** Run convergence-check.sh with a given CLAUDE_PROJECT_DIR + stdin message.
 *  Returns the process exit code (0 = converged/allowed, non-zero = issues). */
function runCheck(projectDir: string, message: string): { code: number; out: string } {
  try {
    const out = execFileSync('bash', [SCRIPT], {
      input: message,
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
      encoding: 'utf-8',
    });
    return { code: 0, out };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string };
    return { code: e.status ?? -1, out: e.stdout ?? '' };
  }
}

describe('convergence-check URL-provenance sibling-node trust', () => {
  let dir: string;

  function writeConfig(cfg: Record<string, unknown>): void {
    fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.instar', 'config.json'), JSON.stringify(cfg));
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-sibling-'));
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/convergence-check-sibling-trust.test.ts cleanup' });
  });

  it('script is syntactically valid bash', () => {
    // bash -n exits 0 on a parseable script; throws otherwise.
    expect(() => execFileSync('bash', ['-n', SCRIPT])).not.toThrow();
  });

  it('trusts a sibling node under the same tunnel parent domain (the fix)', () => {
    writeConfig({ tunnel: { hostname: 'echo.dawn-tunnel.dev' }, projectName: 'echo', port: 4042 });
    const { code } = runCheck(dir, 'Status at https://echo-mini.dawn-tunnel.dev/health now.\n');
    expect(code).toBe(0);
  });

  it('still trusts the agent\'s own exact tunnel host (unchanged)', () => {
    writeConfig({ tunnel: { hostname: 'echo.dawn-tunnel.dev' }, projectName: 'echo', port: 4042 });
    const { code } = runCheck(dir, 'My dashboard is at https://echo.dawn-tunnel.dev/dashboard now.\n');
    expect(code).toBe(0);
  });

  it('still BLOCKS a fabricated unrelated host', () => {
    writeConfig({ tunnel: { hostname: 'echo.dawn-tunnel.dev' }, projectName: 'echo', port: 4042 });
    const { code, out } = runCheck(dir, 'See https://totally-fake-host.xyz/data now.\n');
    expect(code).not.toBe(0);
    expect(out).toContain('URL_PROVENANCE');
  });

  it('BLOCKS a look-alike suffix attack (parent is not a true DNS suffix)', () => {
    writeConfig({ tunnel: { hostname: 'echo.dawn-tunnel.dev' }, projectName: 'echo', port: 4042 });
    const { code, out } = runCheck(dir, 'Try https://echo.dawn-tunnel.dev.evil.com/x now.\n');
    expect(code).not.toBe(0);
    expect(out).toContain('URL_PROVENANCE');
  });

  it('does NOT over-trust when the own host is a bare 2-label apex (no parent derived)', () => {
    writeConfig({ tunnel: { hostname: 'dawn-tunnel.dev' }, projectName: 'echo', port: 4042 });
    // With a 2-label own host, no parent is derived, so an arbitrary host under
    // that apex is NOT auto-trusted — it falls through to the unfamiliar flag.
    const { code, out } = runCheck(dir, 'See https://anything-else.dawn-tunnel.dev/x now.\n');
    expect(code).not.toBe(0);
    expect(out).toContain('URL_PROVENANCE');
  });
});
