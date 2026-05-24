/**
 * Integration test (P2 / spec §4.2d): prove the shimmed dangerous-command-guard.sh
 * actually BLOCKS a destructive command delivered the way Codex delivers it —
 * JSON on stdin, NO positional arg — while preserving Claude's arg path.
 *
 * This is the gate-script-level "does it really block" proof that precedes the
 * full live codey E2E (P5). It exercises the REAL generated script (written by
 * refreshHooksAndSettings from source), not a mock.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { refreshHooksAndSettings } from '../../src/commands/init.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let dir: string;
let guard: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-block-'));
  const stateDir = path.join(dir, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 4321, projectName: 'block-test', agentName: 'Block Test', enabledFrameworks: ['codex-cli'] }));
  refreshHooksAndSettings(dir, stateDir);
  guard = path.join(dir, '.instar', 'hooks', 'instar', 'dangerous-command-guard.sh');
});

afterAll(() => {
  SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/codex-dangerous-command-block.test.ts:cleanup' });
});

/** Run the guard with a Codex-shaped stdin payload and NO arg (cwd = project dir). */
function runCodex(command: string) {
  return spawnSync('bash', [guard], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'shell', cwd: dir, tool_input: { command } }),
    cwd: dir,
    encoding: 'utf-8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: '' },
  });
}

describe('Codex dangerous-command-guard (stdin payload)', () => {
  it('the guard script was generated and is executable', () => {
    expect(fs.existsSync(guard)).toBe(true);
  });

  it('BLOCKS a catastrophic command delivered via Codex stdin (no arg) — exit 2', () => {
    const res = runCodex('rm -rf /');
    expect(res.status, `expected block (exit 2), got ${res.status}; stderr=${res.stderr}`).toBe(2);
    expect(res.stderr).toMatch(/BLOCKED/i);
  });

  it('PASSES a benign command via Codex stdin — exit 0', () => {
    const res = runCodex('ls -la');
    expect(res.status).toBe(0);
  });

  it('still BLOCKS via the Claude arg path (regression) — exit 2', () => {
    const res = spawnSync('bash', [guard, 'rm -rf /'], { cwd: dir, encoding: 'utf-8' });
    expect(res.status).toBe(2);
  });

  it('empty/garbage stdin does not crash or false-block — exit 0', () => {
    const res = spawnSync('bash', [guard], { input: 'not json', cwd: dir, encoding: 'utf-8', env: { ...process.env, CLAUDE_PROJECT_DIR: '' } });
    expect(res.status).toBe(0);
  });
});
