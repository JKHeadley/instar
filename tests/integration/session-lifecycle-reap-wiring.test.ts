/**
 * Event-path integration for UNIFIED-SESSION-LIFECYCLE P0/P3/P4: a real
 * SessionManager with its terminateSession authority wired (as server.ts does)
 * to a ReapGuard + ReapNotifier + ReapLog. Proves, through the real emit path:
 *  - an autonomous terminal reap → reap-log 'reaped' + exactly one user notice;
 *  - a recovery-bounce reap → logged but SILENT;
 *  - an operator reap → logged but SILENT, and bypasses guard + protected;
 *  - a guarded (relay-lease) session → terminate refused, logged 'skipped', survives;
 *  - a standby (non-lease-holder) → terminate refused, survives;
 *  - a protected session → autonomous reap refused, survives.
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
    execFileSync: vi.fn().mockImplementation((_c: string, args?: string[]) => handle(args)),
    execFile: vi.fn().mockImplementation(
      (_c: string, args: string[], _o: unknown, cb?: (e: Error | null, r: { stdout: string }) => void) => {
        if (typeof _o === 'function') cb = _o as typeof cb;
        try { const out = handle(args); if (cb) cb(null, { stdout: String(out) }); }
        catch (e) { if (cb) cb(e as Error, { stdout: '' }); }
      },
    ),
  };
});

import { SessionManager } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import { ReapGuard } from '../../src/core/ReapGuard.js';
import { ReapNotifier } from '../../src/monitoring/ReapNotifier.js';
import { ReapLog } from '../../src/monitoring/ReapLog.js';
import type { SessionManagerConfig, Session } from '../../src/core/types.js';

describe('session-lifecycle reap wiring (integration)', () => {
  let tmpDir: string;
  let stateDir: string;
  let state: StateManager;
  let manager: SessionManager;
  let log: ReapLog;
  let notices: Array<{ topicId: number; text: string }>;
  let notifier: ReapNotifier;
  let awake = true;
  let relayLeased: string | null = null;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reap-wiring-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    state = new StateManager(path.join(stateDir, 'state'));
    const config: SessionManagerConfig = {
      tmuxPath: '/usr/bin/tmux', claudePath: '/usr/local/bin/claude', projectDir: tmpDir,
      maxSessions: 5, protectedSessions: ['proj-server'], completionPatterns: ['done'],
    };
    manager = new SessionManager(config, state);
    mockTmuxSessions.clear();
    awake = true; relayLeased = null;

    const guard = new ReapGuard(
      {
        protectedSessions: () => ['proj-server'],
        isRecoveryActive: () => false,
        hasPendingInjection: () => false,
        isRelayLeaseActive: (id) => id === relayLeased,
        topicBinding: () => null,
        recentUserMessage: () => false,
        activeCommitmentForTopic: () => false,
        activeSubagentCount: () => 0,
        buildOrAutonomousActive: () => false,
        hasActiveProcesses: () => false,
      },
      { minAgeMs: 0 },
    );
    manager.setReapGuard(guard);
    manager.setAwakeChecker(() => awake);

    log = new ReapLog(stateDir, () => 'm1');
    notices = [];
    notifier = new ReapNotifier(
      { resolveTopic: () => null, lifelineTopic: () => 555, send: (topicId, text) => { notices.push({ topicId, text }); } },
      { enabled: true, coalesceWindowMs: 60_000, maxBuffer: 100 },
    );

    manager.on('sessionReaped', (e: { session: Session; reason: string; disposition?: 'terminal' | 'recovery-bounce'; origin?: 'operator' | 'autonomous' }) => {
      log.recordReaped({ session: e.session.name, tmuxSession: e.session.tmuxSession, reason: e.reason, disposition: e.disposition, origin: e.origin });
      notifier.onReaped({ session: e.session, reason: e.reason, disposition: e.disposition, origin: e.origin });
    });
    manager.on('reapBlocked', (e: { session: Session; reason: string; skipped: string; origin?: 'operator' | 'autonomous' }) => {
      log.recordSkipped({ session: e.session.name, tmuxSession: e.session.tmuxSession, reason: e.reason, skipped: e.skipped, origin: e.origin });
    });
  });

  afterEach(() => {
    manager.stopMonitoring();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/session-lifecycle-reap-wiring.test.ts' });
  });

  const spawn = (name: string) => manager.spawnSession({ name, prompt: 'p' });

  it('autonomous terminal reap → logged "reaped" + exactly one user notice', async () => {
    const s = await spawn('job-a');
    const r = await manager.terminateSession(s.id, 'idle-zombie', { disposition: 'terminal' });
    expect(r.terminated).toBe(true);
    await notifier.flush();
    expect(notices).toHaveLength(1);
    expect(notices[0].text).toContain('job-a');
    const entries = log.read();
    expect(entries.at(-1)).toMatchObject({ type: 'reaped', session: 'job-a', reason: 'idle-zombie', disposition: 'terminal' });
  });

  it('recovery-bounce reap → logged but SILENT', async () => {
    const s = await spawn('job-b');
    await manager.terminateSession(s.id, 'context-exhaustion', { disposition: 'recovery-bounce' });
    await notifier.flush();
    expect(notices).toHaveLength(0);
    expect(log.read().at(-1)).toMatchObject({ type: 'reaped', disposition: 'recovery-bounce' });
  });

  it('operator reap → logged, SILENT, and bypasses guard + protected', async () => {
    // Protected + relay-leased: an autonomous reap would be refused twice over,
    // but an operator kill must always happen.
    relayLeased = 'will-set';
    const protectedSession: Session = {
      id: 'op-1', name: 'proj-server', status: 'running', tmuxSession: 'proj-server',
      startedAt: new Date().toISOString(), prompt: 'p',
    } as Session;
    state.saveSession(protectedSession);
    mockTmuxSessions.add('proj-server');
    const r = await manager.terminateSession('op-1', 'operator-kill', { origin: 'operator', finalStatus: 'killed' });
    expect(r.terminated).toBe(true);
    await notifier.flush();
    expect(notices).toHaveLength(0); // operator kills are silent
    expect(log.read().at(-1)).toMatchObject({ type: 'reaped', origin: 'operator' });
    expect(state.getSession('op-1')!.status).toBe('killed');
  });

  it('guarded (relay-lease) session → refused, logged "skipped", survives', async () => {
    const s = await spawn('job-c');
    relayLeased = s.id;
    const r = await manager.terminateSession(s.id, 'idle-zombie');
    expect(r.terminated).toBe(false);
    expect(r.skipped).toBe('relay-lease');
    expect(state.getSession(s.id)!.status).toBe('running'); // survived
    await notifier.flush();
    expect(notices).toHaveLength(0);
    expect(log.read().at(-1)).toMatchObject({ type: 'skipped', skipped: 'relay-lease' });
  });

  it('standby machine (non-lease-holder) → refused, survives, logged "skipped"', async () => {
    const s = await spawn('job-d');
    awake = false;
    const r = await manager.terminateSession(s.id, 'idle-zombie');
    expect(r.terminated).toBe(false);
    expect(r.skipped).toBe('not-lease-holder');
    expect(state.getSession(s.id)!.status).toBe('running');
    expect(log.read().at(-1)).toMatchObject({ type: 'skipped', skipped: 'not-lease-holder' });
  });

  it('protected session → autonomous reap refused, survives', async () => {
    const protectedSession: Session = {
      id: 'prot-1', name: 'proj-server', status: 'running', tmuxSession: 'proj-server',
      startedAt: new Date().toISOString(), prompt: 'p',
    } as Session;
    state.saveSession(protectedSession);
    const r = await manager.terminateSession('prot-1', 'idle-zombie');
    expect(r.terminated).toBe(false);
    expect(r.skipped).toBe('protected');
    expect(state.getSession('prot-1')!.status).toBe('running');
    expect(log.read().at(-1)).toMatchObject({ type: 'skipped', skipped: 'protected' });
  });

  // ── active-process relaxation parity (the 1,532× skipped:active-process bug) ──
  // Proves the REAL terminateSession + REAL ReapGuard agree on the bypass: an
  // active-process veto refuses an autonomous reap, but the reaper's relaxation
  // (carried via bypassActiveProcessKeep) actually lands the kill end-to-end.
  it('active-process keep refuses an autonomous reap; bypassActiveProcessKeep lands it', async () => {
    // Re-wire a guard whose ONLY live veto is active-process (e.g. the standing MCP stack).
    manager.setReapGuard(new ReapGuard(
      {
        protectedSessions: () => ['proj-server'],
        isRecoveryActive: () => false,
        hasPendingInjection: () => false,
        isRelayLeaseActive: (id) => id === relayLeased,
        topicBinding: () => null,
        recentUserMessage: () => false,
        activeCommitmentForTopic: () => false,
        activeSubagentCount: () => 0,
        buildOrAutonomousActive: () => false,
        hasActiveProcesses: () => true,
      },
      { minAgeMs: 0 },
    ));
    const s = await spawn('ap-wire');

    // Without the bypass: the authority re-vetoes (the original stalemate).
    const refused = await manager.terminateSession(s.id, 'reaped-idle');
    expect(refused).toEqual({ terminated: false, skipped: 'active-process' });
    expect(state.getSession(s.id)!.status).toBe('running');
    expect(log.read().at(-1)).toMatchObject({ type: 'skipped', skipped: 'active-process' });

    // With the bypass (what performReap now sends): the kill actually lands.
    const reaped = await manager.terminateSession(s.id, 'reaped-idle', { bypassActiveProcessKeep: true });
    expect(reaped.terminated).toBe(true);
    expect(state.getSession(s.id)!.status).toBe('completed');
    expect(log.read().at(-1)).toMatchObject({ type: 'reaped', reason: 'reaped-idle' });
  });

  // ── F8 lease carve-out (post-transfer closeout, roadmap 0.6) ──────────────
  // The audited failure: after a topic moved away, the OLD machine (no longer
  // the lease holder) tried to close its own leftover session and the lease
  // gate vetoed every attempt (skipped:'not-lease-holder' ×5 → breaker gave
  // up → duplicate session survived). The carve-out lifts ONLY the lease gate.
  it('F8: standby machine + bypassLeaseForTopicMovedCloseout → closeout LANDS, reap-log records the honest reason', async () => {
    const s = await spawn('moved-topic-leftover');
    awake = false; // this machine lost the lease when the topic moved away
    const reason = 'topic moved to Mac Mini — closing the leftover session on this machine (post-transfer closeout)';
    const r = await manager.terminateSession(s.id, reason, { bypassLeaseForTopicMovedCloseout: true });
    expect(r.terminated).toBe(true);
    expect(state.getSession(s.id)!.status).toBe('completed'); // ZERO leftover sessions
    expect(log.read().at(-1)).toMatchObject({ type: 'reaped', session: 'moved-topic-leftover', reason });
  });

  it('F8: the carve-out does NOT weaken the protected gate — a protected session still never auto-closes', async () => {
    awake = false;
    const protectedSession: Session = {
      id: 'prot-f8', name: 'proj-server', status: 'running', tmuxSession: 'proj-server',
      startedAt: new Date().toISOString(), prompt: 'p',
    } as Session;
    state.saveSession(protectedSession);
    mockTmuxSessions.add('proj-server');
    const r = await manager.terminateSession('prot-f8', 'topic moved to Mac Mini — closing the leftover session on this machine (post-transfer closeout)', { bypassLeaseForTopicMovedCloseout: true });
    expect(r.terminated).toBe(false);
    expect(r.skipped).toBe('protected');
    expect(state.getSession('prot-f8')!.status).toBe('running');
    expect(log.read().at(-1)).toMatchObject({ type: 'skipped', skipped: 'protected' });
  });

  it('F8: the carve-out does NOT weaken the KEEP-guards — a relay-leased session still refuses', async () => {
    const s = await spawn('moved-but-guarded');
    relayLeased = s.id; // a live KEEP-guard reason
    awake = false;
    const r = await manager.terminateSession(s.id, 'topic moved to Mac Mini — closing the leftover session on this machine (post-transfer closeout)', { bypassLeaseForTopicMovedCloseout: true });
    expect(r.terminated).toBe(false);
    expect(r.skipped).toBe('relay-lease'); // vetoed by the guard, NOT by the lease
    expect(state.getSession(s.id)!.status).toBe('running');
    expect(log.read().at(-1)).toMatchObject({ type: 'skipped', skipped: 'relay-lease' });
  });

  it('F8 boundary: a standby terminate WITHOUT the flag keeps today\'s not-lease-holder veto', async () => {
    const s = await spawn('ordinary-standby-kill');
    awake = false;
    const r = await manager.terminateSession(s.id, 'idle-zombie');
    expect(r).toEqual({ terminated: false, skipped: 'not-lease-holder' });
    expect(state.getSession(s.id)!.status).toBe('running');
  });
});
