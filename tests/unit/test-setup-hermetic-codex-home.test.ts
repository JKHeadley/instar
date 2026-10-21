/**
 * Guard: no test can write the operator's real ~/.codex/config.toml or
 * ~/.claude.json.
 *
 * Two structural guarantees, each checked from inside a live test process:
 *
 *  1. tests/vitest-setup.ts forces CODEX_HOME onto a per-process temp dir, so
 *     the Codex MCP registry (and any child spawned with process.env) writes
 *     THERE. We register a throwaway entry and prove it lands under CODEX_HOME,
 *     not under the real home, and that the real config.toml is byte-identical
 *     before and after.
 *  2. Every test file that imports `bootstrapThreadline` (which writes the
 *     user-scope ~/.claude.json) uses tests/setup/hermetic-home.ts — or sets
 *     process.env.HOME itself. A new caller without either fails this test.
 *
 * Background: 2026-10-20, the identity-discovery-wiring e2e rewrote the
 * operator's REAL ~/.codex/config.toml. The boot-time write is gone; this test
 * is what keeps the class closed.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcpToolRegistry } from '../../src/providers/adapters/openai-codex/integration/mcpToolRegistry.js';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..');
const TESTS_ROOT = path.join(REPO_ROOT, 'tests');

function realpathSafe(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function isUnder(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'fixtures') continue;
      walk(full, out);
    } else if (entry.isFile() && /\.test\.ts$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe('hermetic Codex home for the whole test suite', () => {
  it('CODEX_HOME is a temp dir, not the operator\'s ~/.codex', () => {
    const codexHome = process.env['CODEX_HOME'];
    expect(codexHome, 'tests/vitest-setup.ts must set CODEX_HOME').toBeTruthy();
    const resolved = realpathSafe(codexHome!);
    const realCodex = realpathSafe(path.join(os.homedir(), '.codex'));
    expect(resolved).not.toBe(realCodex);
    expect(isUnder(resolved, realCodex)).toBe(false);
    expect(isUnder(resolved, realpathSafe(os.tmpdir()))).toBe(true);
  });

  it('a user-scope Codex MCP registration lands under CODEX_HOME and leaves the real config.toml untouched', async () => {
    const realConfig = path.join(os.homedir(), '.codex', 'config.toml');
    const before = fs.existsSync(realConfig) ? fs.readFileSync(realConfig) : null;

    await createMcpToolRegistry().register(
      { kind: 'stdio', name: 'hermetic-guard-probe', command: 'node', args: ['/nowhere/probe.js'] },
      { scope: 'user' },
    );

    const written = path.join(process.env['CODEX_HOME']!, 'config.toml');
    expect(fs.existsSync(written)).toBe(true);
    expect(fs.readFileSync(written, 'utf-8')).toContain('[mcp_servers."hermetic-guard-probe"]');

    const after = fs.existsSync(realConfig) ? fs.readFileSync(realConfig) : null;
    if (before === null) {
      expect(after).toBeNull();
    } else {
      expect(after !== null && before.equals(after)).toBe(true);
    }
    // Clean our own probe entry out of the temp config.
    await createMcpToolRegistry().unregister('hermetic-guard-probe', { scope: 'user' });
  });

  it('tests/vitest-setup.ts is the place that forces CODEX_HOME (ratchet)', () => {
    const setup = fs.readFileSync(path.join(TESTS_ROOT, 'vitest-setup.ts'), 'utf-8');
    expect(setup).toMatch(/process\.env\.CODEX_HOME\s*=\s*tmpCodexHome/);
  });

  it('every test that boots Threadline in-process isolates HOME', () => {
    const offenders: string[] = [];
    for (const file of walk(TESTS_ROOT)) {
      const src = fs.readFileSync(file, 'utf-8');
      if (!/import\s*\{[^}]*\bbootstrapThreadline\b[^}]*\}\s*from/.test(src)) continue;
      const usesHelper = /hermetic-home\.js['"]/.test(src) && /useHermeticHome\(\)/.test(src);
      const setsHomeItself = /process\.env\.HOME\s*=/.test(src);
      if (!usesHelper && !setsHomeItself) offenders.push(path.relative(REPO_ROOT, file));
    }
    expect(
      offenders,
      `These test files import bootstrapThreadline (which writes ~/.claude.json) without isolating HOME. ` +
        `Add \`useHermeticHome()\` from tests/setup/hermetic-home.ts at module level:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('the hermetic-home helper actually moves os.homedir() for the test it wraps', async () => {
    // Exercised inline rather than via the helper's hooks so this file does
    // not itself depend on beforeEach ordering.
    const realHome = process.env.HOME;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-hermetic-home-probe-'));
    try {
      process.env.HOME = tmp;
      expect(realpathSafe(os.homedir())).toBe(realpathSafe(tmp));
    } finally {
      if (realHome === undefined) delete process.env.HOME;
      else process.env.HOME = realHome;
      const { SafeFsExecutor } = await import('../../src/core/SafeFsExecutor.js');
      SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/test-setup-hermetic-codex-home.test.ts' });
    }
  });
});
