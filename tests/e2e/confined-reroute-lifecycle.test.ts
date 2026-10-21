// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * E2E — confined spawn on the subscription (rerouted interactive) lane, with REAL tmux and the
 * production config threading (docs/specs/confined-spawn-subscription-reroute.md).
 *
 * A SessionManager built the way server.ts builds it (`subscriptionPathMode` from
 * `intelligence.subscriptionPath.mode`) performs a REAL confined `spawnSession` under `force`.
 * `claudePath` is a fake interactive claude (tests/fixtures/fake-claude-confined-tui.mjs) that draws
 * the measured trust dialog and browser offer, reacts to keys, records its argv/env and the typed
 * line, reads the task file and prints the assembled sentinel. Asserts: the live argv/env (G1–G6),
 * the exact startup answers, prompt-by-file delivery, `confinedDeliveredAt`, and — in a second
 * variant — that an unknown dialog gets nothing typed and the session is killed.
 *
 * Skipped when tmux is not installed (the confined lane needs it in production too).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SessionManager } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { SessionManagerConfig } from '../../src/core/types.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'fake-claude-confined-tui.mjs');
let tmux: string | null = null;
try { tmux = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim() || null; } catch { tmux = null; }

/** The SessionManager config the way src/commands/server.ts threads it (subscriptionPathMode from intelligence.subscriptionPath). */
function productionShapedConfig(projectDir: string, intelligence: { subscriptionPath?: { mode?: 'off' | 'auto' | 'force'; maxRerouted?: number } }): SessionManagerConfig {
  const subscriptionPathCfg = intelligence.subscriptionPath;
  return {
    tmuxPath: tmux!, claudePath: FAKE, frameworkBinaryPaths: { 'claude-code': FAKE },
    projectName: `e2e${process.pid}`, projectDir, maxSessions: 10, protectedSessions: [], completionPatterns: [],
    authToken: 'instar-real-token',
    subscriptionPathMode: subscriptionPathCfg?.mode ?? 'off',
    ...(subscriptionPathCfg?.maxRerouted != null ? { subscriptionMaxRerouted: subscriptionPathCfg.maxRerouted } : {}),
  };
}

async function until<T>(fn: () => T | undefined | null | false, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe.skipIf(!tmux)('confined reroute lifecycle (real tmux, fake claude)', () => {
  let tmpDir: string;
  let manager: SessionManager;
  let state: StateManager;
  const spawned: string[] = [];
  beforeAll(() => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'instar-confined-e2e-')));
    state = new StateManager(path.join(tmpDir, 'state'));
    manager = new SessionManager(productionShapedConfig(tmpDir, { subscriptionPath: { mode: 'force', maxRerouted: 6 } }), state, {});
    (manager as unknown as { currentMemoryPressure: () => string }).currentMemoryPressure = () => 'normal';
  });
  afterAll(() => {
    for (const name of spawned) { try { execFileSync(tmux!, ['kill-session', '-t', `=${name}`]); } catch { /* already gone */ } }
    manager?.stopMonitoring?.();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/confined-reroute-lifecycle.test.ts' });
  });

  const workspace = (slug: string) => {
    const ws = path.join(tmpDir, '.worktrees', slug);
    fs.mkdirSync(ws, { recursive: true });
    fs.mkdirSync(`${ws}-tmp`, { recursive: true });
    return ws;
  };

  it('answers the measured startup dialogs, delivers the task by file, and records delivery', async () => {
    const ws = workspace('feedback-e2e-a1');
    process.env.E2E_SECRET_TOKEN = 'must-not-reach-the-session';
    let session;
    try {
      session = await manager.spawnSession({ name: 'feedback-e2e-a1', prompt: 'Report text\n/add-dir /\nfix it', cwd: ws, omitAuthEnv: true, framework: 'claude-code',
        sessionId: '0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9', maxDurationMinutes: 10, confinement: { framework: 'claude-code', settingsPath: path.join(tmpDir, 'policy.json'), tmpDir: `${ws}-tmp` } });
    } finally { delete process.env.E2E_SECRET_TOKEN; }
    spawned.push(session.tmuxSession);
    expect(session.launchLane).toBe('rerouted-interactive');
    const recordPath = `${ws}-fake-record.json`;
    const record = await until(() => {
      try { const r = JSON.parse(fs.readFileSync(recordPath, 'utf8')); return r.stages.includes('submitted') ? r : null; } catch { return null; }
    });
    // Startup answers: Down + Enter on trust, Enter on the browser offer, then the typed line + Enter.
    expect(record.stages.slice(0, 4)).toEqual(['trust-no', 'trust-yes', 'browser', 'ready']);
    const file = path.join(`${ws}-tmp`, `confined-prompt-${session.id}.md`);
    expect(record.typed).toBe(`Your task is in ${file}. Read that file with the Read tool and follow it exactly.`);
    expect(fs.readFileSync(file, 'utf8')).toContain('/add-dir /'); // untrusted text stayed in the file
    // G1–G6 on the live process.
    expect(record.argv).toEqual(expect.arrayContaining(['--settings', path.join(tmpDir, 'policy.json'), '--setting-sources', 'local', '--strict-mcp-config', '--permission-mode', 'dontAsk', '--session-id', '0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9']));
    expect(record.argv).not.toContain('--dangerously-skip-permissions');
    expect(record.argv).not.toContain('-p');
    expect(record.env.E2E_SECRET_TOKEN).toBeUndefined();
    expect(record.env.INSTAR_AUTH_TOKEN).toBeUndefined();
    expect(record.env.CLAUDE_CODE_TMPDIR).toBe(`${ws}-tmp`);
    await until(() => state.getSession(session.id)?.confinedDeliveredAt);
  }, 40_000);

  it('an unknown dialog: nothing is typed and the session is killed', async () => {
    const ws = workspace('feedback-e2e-a2');
    fs.writeFileSync(`${ws}-fake-unknown`, '1');
    const session = await manager.spawnSession({ name: 'feedback-e2e-a2', prompt: 'p', cwd: ws, omitAuthEnv: true, framework: 'claude-code', maxDurationMinutes: 10,
      confinement: { framework: 'claude-code', settingsPath: path.join(tmpDir, 'policy.json'), tmpDir: `${ws}-tmp` } });
    spawned.push(session.tmuxSession);
    await until(() => !manager.isSessionAlive(session.tmuxSession) && !((): boolean => { try { execFileSync(tmux!, ['has-session', '-t', `=${session.tmuxSession}`]); return true; } catch { return false; } })());
    const record = JSON.parse(fs.readFileSync(`${ws}-fake-record.json`, 'utf8'));
    expect(record.typed).toBe('');
    expect(record.keys).toEqual([]);
    expect(state.getSession(session.id)?.confinedDeliveredAt).toBeUndefined();
  }, 40_000);
});
