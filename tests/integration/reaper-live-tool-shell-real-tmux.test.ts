/**
 * Real-tmux integration for the reaper idle-coordinator fix: the production
 * `SessionManager.hasLiveToolShell` / `hasActiveProcesses` probes run against a
 * REAL tmux pane whose process tree mirrors a coordinating Claude Code session
 * (pane process → `sh -c 'source …/.claude/shell-snapshots/snapshot-…'` tool
 * shell), and against a pane with no such shell. Skips if tmux is unavailable.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { SessionManager } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const which = spawnSync('which', ['tmux'], { encoding: 'utf-8' });
const tmuxPath = which.status === 0 ? which.stdout.trim() : '';
const tag = `${process.pid}-${Math.floor(process.hrtime()[1] % 100000)}`;
const BUSY = `reaper-shell-busy-${tag}`;
const BETWEEN = `reaper-shell-between-${tag}`;
const IDLE = `reaper-shell-idle-${tag}`;

describe.skipIf(!tmuxPath)('reaper live-tool-shell probes vs real tmux', () => {
  let dir: string;
  let manager: SessionManager;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reaper-shell-'));
    const snap = path.join(dir, '.claude', 'shell-snapshots', 'snapshot-zsh-1-abc.sh');
    fs.mkdirSync(path.dirname(snap), { recursive: true });
    fs.writeFileSync(snap, '');
    // A watch loop that is mid-`sleep` (tool shell with a child).
    const busy = `sh -c ". ${snap}; while :; do sleep 60; done" & wait`;
    // A tool shell between children (blocked in a builtin, no child process).
    const between = `sh -c ". ${snap}; read x" & wait`;
    spawnSync(tmuxPath, ['new-session', '-d', '-s', BUSY, busy], { stdio: 'ignore' });
    spawnSync(tmuxPath, ['new-session', '-d', '-s', BETWEEN, between], { stdio: 'ignore' });
    spawnSync(tmuxPath, ['new-session', '-d', '-s', IDLE, 'sleep 600'], { stdio: 'ignore' });
    const stateDir = path.join(dir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    manager = new SessionManager({
      tmuxPath,
      claudePath: '/usr/local/bin/claude',
      projectDir: dir,
      maxSessions: 5,
      protectedSessions: [],
      completionPatterns: [],
    }, new StateManager(stateDir));
    await new Promise((r) => setTimeout(r, 500)); // let the panes fork their children
  });

  afterAll(() => {
    for (const s of [BUSY, BETWEEN, IDLE]) spawnSync(tmuxPath, ['kill-session', '-t', `=${s}`], { stdio: 'ignore' });
    manager?.stopMonitoring();
    try {
      SafeFsExecutor.safeRmSync(dir, {
        recursive: true,
        force: true,
        operation: 'tests/integration/reaper-live-tool-shell-real-tmux.test.ts:afterAll',
      });
    } catch { /* best-effort */ }
  });

  it('detects a running tool shell (watch loop) under the pane', () => {
    expect(manager.hasLiveToolShell(BUSY)).toBe(true);
    expect(manager.hasActiveProcesses(BUSY)).toBe(true);
  });

  it('detects a tool shell between children, and hasActiveProcesses counts it', () => {
    expect(manager.hasLiveToolShell(BETWEEN)).toBe(true);
    expect(manager.hasActiveProcesses(BETWEEN)).toBe(true);
  });

  it('a pane with no tool shell reads as none', () => {
    expect(manager.hasLiveToolShell(IDLE)).toBe(false);
    expect(manager.hasActiveProcesses(IDLE)).toBe(false);
  });
});
