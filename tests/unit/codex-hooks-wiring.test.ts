/**
 * Wiring-integrity test for the Codex enforcement-hook layer (P1b).
 *
 * Per convergence finding #1 (spec §11) and the "verify wired, not just
 * defined" lesson (PR #334 shipped dead code with a false "wired" claim):
 * a unit test of installCodexHooks in isolation is NOT enough. This test
 * proves the production init/refresh path (`refreshHooksAndSettings`, which
 * both `instar init` and the update path call) actually INVOKES
 * installCodexHooks for a codex-cli agent — and does NOT for a claude-only
 * agent (framework gating).
 *
 * Real temp dirs + real file I/O, mirroring refresh-jobs.test.ts. No mocks.
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { refreshHooksAndSettings } from '../../src/commands/init.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const created: string[] = [];

function createProject(enabledFrameworks: string[]): { dir: string; stateDir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-wiring-'));
  created.push(dir);
  const stateDir = path.join(dir, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'config.json'),
    JSON.stringify({ port: 4321, projectName: 'wiring-test', agentName: 'Wiring Test', enabledFrameworks }),
  );
  return { dir, stateDir };
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/codex-hooks-wiring.test.ts:cleanup' });
  }
});

describe('Codex enforcement-hook wiring (refreshHooksAndSettings)', () => {
  it('WIRES installCodexHooks for a codex-cli agent — .codex/hooks.json is created with instar gates', () => {
    const { dir, stateDir } = createProject(['codex-cli']);
    refreshHooksAndSettings(dir, stateDir);

    const hooksPath = path.join(dir, '.codex', 'hooks.json');
    expect(fs.existsSync(hooksPath), 'init/refresh path did not invoke installCodexHooks').toBe(true);

    const cfg = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'));
    // Proof it's instar's gates, not an empty stub.
    expect(cfg.hooks.PreToolUse).toBeDefined();
    const preCommands = cfg.hooks.PreToolUse.flatMap((g: any) => g.hooks.map((h: any) => h.command));
    expect(preCommands.some((c: string) => c.includes('.instar/hooks/instar/external-operation-gate.js'))).toBe(true);
    expect(cfg.hooks.Stop).toBeDefined();
    expect(cfg.hooks.PermissionRequest).toBeDefined();
  });

  it('does NOT write .codex/hooks.json for a claude-only agent (framework gating)', () => {
    const { dir, stateDir } = createProject(['claude-code']);
    refreshHooksAndSettings(dir, stateDir);
    expect(fs.existsSync(path.join(dir, '.codex', 'hooks.json'))).toBe(false);
  });

  it('wires both frameworks when both are enabled', () => {
    const { dir, stateDir } = createProject(['claude-code', 'codex-cli']);
    refreshHooksAndSettings(dir, stateDir);
    expect(fs.existsSync(path.join(dir, '.codex', 'hooks.json'))).toBe(true);
  });
});
