/**
 * SessionManager.terminateSession — the single-writer kill path
 * (SESSION-REAPER-SPEC §3.6). Verifies compare-and-set idempotency,
 * exactly-once event emission, protected-session refusal, the reaping lease,
 * and the relay-lease accessor.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const mockTmuxSessions = new Set<string>();

vi.mock('node:child_process', () => {
  const handle = (args?: string[]) => {
    if (!args) return '';
    if (args[0] === 'new-session') {
      const sIdx = args.indexOf('-s');
      if (sIdx >= 0 && args[sIdx + 1]) mockTmuxSessions.add(args[sIdx + 1]);
      return '';
    }
    if (args[0] === 'kill-session') {
      const target = args[2]?.replace(/^=/, '');
      if (target) mockTmuxSessions.delete(target);
      return '';
    }
    if (args[0] === 'has-session') {
      const target = args[2]?.replace(/^=/, '');
      if (target && !mockTmuxSessions.has(target)) throw new Error('no session');
      return '';
    }
    return '';
  };
  return {
    execFileSync: vi.fn().mockImplementation((_cmd: string, args?: string[]) => handle(args)),
    execFile: vi.fn().mockImplementation(
      (_cmd: string, args: string[], _opts: unknown, cb?: (e: Error | null, r: { stdout: string }) => void) => {
        if (typeof _opts === 'function') cb = _opts as typeof cb;
        try { const out = handle(args); if (cb) cb(null, { stdout: String(out) }); }
        catch (e) { if (cb) cb(e as Error, { stdout: '' }); }
      },
    ),
  };
});

import { SessionManager } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { SessionManagerConfig } from '../../src/core/types.js';

describe('SessionManager.terminateSession (single-writer CAS)', () => {
  let tmpDir: string;
  let state: StateManager;
  let manager: SessionManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-terminate-'));
    const stateDir = path.join(tmpDir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    state = new StateManager(stateDir);
    const config: SessionManagerConfig = {
      tmuxPath: '/usr/bin/tmux',
      claudePath: '/usr/local/bin/claude',
      projectDir: tmpDir,
      maxSessions: 5,
      protectedSessions: ['my-project-server'],
      completionPatterns: ['Session complete'],
    };
    manager = new SessionManager(config, state);
    mockTmuxSessions.clear();
  });

  afterEach(() => {
    manager.stopMonitoring();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/session-manager-terminate.test.ts' });
  });

  const spawn = (name: string) => manager.spawnSession({ name, prompt: 'p' });

  it('terminates a running session exactly once, sets endedReason, emits sessionComplete once', async () => {
    const s = await spawn('job-a');
    let completeCount = 0;
    let beforeCount = 0;
    manager.on('sessionComplete', () => { completeCount++; });
    manager.on('beforeSessionKill', () => { beforeCount++; });

    const r1 = await manager.terminateSession(s.id, 'reaped-idle');
    expect(r1.terminated).toBe(true);
    expect(completeCount).toBe(1);
    expect(beforeCount).toBe(1);

    const saved = state.getSession(s.id)!;
    expect(saved.status).toBe('completed');
    expect(saved.endedReason).toBe('reaped-idle');
    expect(saved.endedAt).toBeTruthy();
  });

  it('is idempotent — a second terminate is a no-op (CAS on already-terminal)', async () => {
    const s = await spawn('job-b');
    let completeCount = 0;
    manager.on('sessionComplete', () => { completeCount++; });

    const r1 = await manager.terminateSession(s.id, 'reaped-idle');
    const r2 = await manager.terminateSession(s.id, 'reaped-idle');
    expect(r1.terminated).toBe(true);
    expect(r2.terminated).toBe(false);
    expect(r2.skipped).toBe('already-completed');
    expect(completeCount).toBe(1); // exactly once across both calls
  });

  it('refuses to terminate a protected session', async () => {
    // Manually persist a protected session record.
    const protectedSession = {
      id: 'prot-1', name: 'server', status: 'running' as const,
      tmuxSession: 'my-project-server', startedAt: new Date().toISOString(), prompt: 'p',
    };
    state.saveSession(protectedSession);
    const r = await manager.terminateSession('prot-1', 'reaped-idle');
    expect(r.terminated).toBe(false);
    expect(r.skipped).toBe('protected');
    expect(state.getSession('prot-1')!.status).toBe('running');
  });

  it('returns not-found for an unknown session', async () => {
    const r = await manager.terminateSession('does-not-exist', 'reaped-idle');
    expect(r).toEqual({ terminated: false, skipped: 'not-found' });
  });

  it('concurrent terminate calls kill once (in-flight guard / no double-emit)', async () => {
    const s = await spawn('job-c');
    let completeCount = 0;
    manager.on('sessionComplete', () => { completeCount++; });
    const [a, b] = await Promise.all([
      manager.terminateSession(s.id, 'reaped-idle'),
      manager.terminateSession(s.id, 'idle-zombie'),
    ]);
    const terminatedCount = [a, b].filter(r => r.terminated).length;
    expect(terminatedCount).toBe(1);
    expect(completeCount).toBe(1);
  });

  it('reaping lease: markReaping/isReaping/clearReaping', async () => {
    const s = await spawn('job-d');
    expect(manager.isReaping(s.id)).toBe(false);
    manager.markReaping(s.id);
    expect(manager.isReaping(s.id)).toBe(true);
    manager.clearReaping(s.id);
    expect(manager.isReaping(s.id)).toBe(false);
  });

  it('terminate clears any reaping lease', async () => {
    const s = await spawn('job-e');
    manager.markReaping(s.id);
    await manager.terminateSession(s.id, 'reaped-idle');
    expect(manager.isReaping(s.id)).toBe(false);
  });

  it('isRelayLeaseActive reflects grant/expiry/clear', async () => {
    const s = await spawn('job-f');
    expect(manager.isRelayLeaseActive(s.id)).toBe(false);
    manager.grantRelayLease(s.id, 60_000);
    expect(manager.isRelayLeaseActive(s.id)).toBe(true);
    manager.clearRelayLease(s.id);
    expect(manager.isRelayLeaseActive(s.id)).toBe(false);
    // expired lease reads inactive
    manager.grantRelayLease(s.id, -1);
    expect(manager.isRelayLeaseActive(s.id)).toBe(false);
  });

  it('killSession sets endedReason and preserves its unconditional-kill contract', async () => {
    const s = await spawn('job-g');
    expect(manager.killSession(s.id)).toBe(true);
    expect(state.getSession(s.id)!.status).toBe('killed');
    expect(state.getSession(s.id)!.endedReason).toBe('manual-kill');
    // Contract preserved: killSession destroys the pane regardless of status
    // (it does NOT early-return on terminal status — only the in-flight guard
    // protects against racing terminateSession).
    expect(manager.killSession(s.id)).toBe(true);
  });
});
