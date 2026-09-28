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

/** `ps -eo pid,ppid,command` descendants of `root` (throws if ps cannot run). */
function descendants(root: string): Array<{ pid: string; command: string }> {
  const ps = spawnSync('ps', ['-eo', 'pid,ppid,command'], { encoding: 'utf-8' });
  if (ps.status !== 0) throw new Error(`ps failed: ${ps.stderr}`);
  const rows = ps.stdout.split('\n').slice(1)
    .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null);
  const out: Array<{ pid: string; command: string }> = [];
  const queue = [root];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const m of rows) {
      if (m[2] === parent) { out.push({ pid: m[1], command: m[3] }); queue.push(m[1]); }
    }
  }
  return out;
}

function panePid(session: string): string {
  const r = spawnSync(tmuxPath, ['list-panes', '-t', `=${session}:`, '-F', '#{pane_pid}'], { encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`tmux session ${session} is gone: ${r.stderr}`);
  return r.stdout.trim();
}

describe.skipIf(!tmuxPath)('reaper live-tool-shell probes vs real tmux', () => {
  let dir: string;
  let manager: SessionManager;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reaper-shell-'));
    const snap = path.join(dir, '.claude', 'shell-snapshots', 'snapshot-zsh-1-abc.sh');
    fs.mkdirSync(path.dirname(snap), { recursive: true });
    fs.writeFileSync(snap, '');
    // A deliberately OPEN input the between-children shell blocks on: opened
    // read-write (`<>`) so the open never waits and `read` never sees EOF.
    const fifo = path.join(dir, 'hold.fifo');
    const mk = spawnSync('mkfifo', [fifo]);
    if (mk.status !== 0) throw new Error('mkfifo failed');
    // A watch loop that is mid-`sleep` (tool shell with a child).
    const busy = `sh -c ". ${snap}; while :; do sleep 60; done" & wait`;
    // A tool shell between children (blocked in a builtin, no child process).
    const between = `sh -c ". ${snap}; read x <> ${fifo}" & wait`;
    for (const [name, cmd] of [[BUSY, busy], [BETWEEN, between], [IDLE, 'sleep 600']] as const) {
      const r = spawnSync(tmuxPath, ['new-session', '-d', '-s', name, cmd], { encoding: 'utf-8' });
      if (r.status !== 0) throw new Error(`tmux new-session ${name} failed: ${r.stderr}`);
    }
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

  // Every positive case first proves its subject exists: a vanished pane or a
  // denied ps must fail here, never read as "shell alive".
  const toolShells = (session: string) =>
    descendants(panePid(session)).filter((p) => p.command.includes('/shell-snapshots/snapshot-'));

  it('detects a running tool shell (watch loop) under the pane', () => {
    const shells = toolShells(BUSY);
    expect(shells).toHaveLength(1);
    expect(descendants(shells[0].pid).some((p) => /\bsleep 60\b/.test(p.command))).toBe(true);
    expect(manager.hasLiveToolShell(BUSY)).toBe(true);
    expect(manager.hasActiveProcesses(BUSY)).toBe(true);
  });

  it('detects a tool shell between children, and hasActiveProcesses counts it', () => {
    const shells = toolShells(BETWEEN);
    expect(shells).toHaveLength(1);
    expect(descendants(shells[0].pid)).toHaveLength(0); // blocked in `read`, no child
    expect(manager.hasLiveToolShell(BETWEEN)).toBe(true);
    expect(manager.hasActiveProcesses(BETWEEN)).toBe(true);
  });

  it('a pane with no tool shell reads as none', () => {
    expect(panePid(IDLE)).toMatch(/^\d+$/);
    expect(toolShells(IDLE)).toHaveLength(0);
    expect(manager.hasLiveToolShell(IDLE)).toBe(false);
    expect(manager.hasActiveProcesses(IDLE)).toBe(false);
  });

  it('a vanished session makes the probe THROW, never report a shell', () => {
    expect(() => manager.hasLiveToolShell(`reaper-shell-missing-${tag}`)).toThrow();
  });
});
