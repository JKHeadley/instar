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
const mockChildProcessControl = vi.hoisted(() => ({
  killError: null as Error | null,
  lastKillOptions: null as Record<string, unknown> | null,
}));

vi.mock('node:child_process', () => {
  const handle = (args?: string[]) => {
    if (!args) return '';
    if (args[0] === 'new-session') {
      const sIdx = args.indexOf('-s');
      if (sIdx >= 0 && args[sIdx + 1]) mockTmuxSessions.add(args[sIdx + 1]);
      return '';
    }
    if (args[0] === 'kill-session') {
      if (mockChildProcessControl.killError) throw mockChildProcessControl.killError;
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
    execFileSync: vi.fn().mockImplementation((_cmd: string, args?: string[], opts?: Record<string, unknown>) => {
      if (args?.[0] === 'kill-session') mockChildProcessControl.lastKillOptions = opts ?? null;
      return handle(args);
    }),
    execFile: vi.fn().mockImplementation(
      (_cmd: string, args: string[], _opts: unknown, cb?: (e: Error | null, r: { stdout: string }) => void) => {
        if (typeof _opts === 'function') cb = _opts as typeof cb;
        try { const out = handle(args); if (cb) cb(null, { stdout: String(out) }); }
        catch (e) { if (cb) cb(e as Error, { stdout: '' }); }
      },
    ),
  };
});

import { SessionManager, type SessionTerminateAuthority } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import { ReapGuard, type ReapGuardDeps } from '../../src/core/ReapGuard.js';
import type { SessionManagerConfig } from '../../src/core/types.js';

describe('SessionManager.terminateSession (single-writer CAS)', () => {
  let tmpDir: string;
  let state: StateManager;
  let manager: SessionManager;
  let terminateAuthority: SessionTerminateAuthority;
  let maintenanceTick: () => Promise<void>;

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
    manager = new SessionManager(config, state, {
      bindTerminateAuthority: (authority) => { terminateAuthority = authority; },
      bindMaintenanceTickForTesting: (tick) => { maintenanceTick = tick; },
    });
    mockTmuxSessions.clear();
    mockChildProcessControl.killError = null;
    mockChildProcessControl.lastKillOptions = null;
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

  // ── bypassActiveProcessKeep (active-process relaxation parity) ──────────────
  // The reaper relaxes the active-process veto in evaluate(), then carries that
  // decision here via the flag; the authority must lift ONLY that veto and keep
  // enforcing every other guard. Spec: reaper-active-process-relaxation-parity.
  const guardWith = (over: Partial<ReapGuardDeps> = {}): ReapGuard =>
    new ReapGuard(
      {
        protectedSessions: () => [],
        isRecoveryActive: () => false,
        hasPendingInjection: () => false,
        isRelayLeaseActive: () => false,
        topicBinding: () => null,
        recentUserMessage: () => false,
        activeCommitmentForTopic: () => false,
        activeSubagentCount: () => 0,
        buildOrAutonomousActive: () => false,
        hasActiveProcesses: () => true, // the active-process veto is armed by default
        ...over,
      },
      { minAgeMs: 0 }, // no spawn-grace so the active-process guard is what fires
    );

  type MonitorSeam = {
    isSessionAliveAsync(): Promise<boolean>;
    recordBuildContextMaybeAsync(): Promise<void>;
    detectCompletionMaybeAsync(): Promise<boolean>;
    captureMeaningfulTailMaybeAsync(): Promise<string>;
    hasActiveProcessesMaybeAsync(): Promise<boolean>;
    isTranscriptRecentlyActive(): boolean;
  };

  const runLocalExpiredMonitorTick = async (
    name: string,
    beforeTick?: () => void,
  ): Promise<{ id: string; blocked: string[]; authorityScopes: string[] }> => {
    const s = await spawn(name);
    state.saveSession({
      ...s,
      startedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      maxDurationMinutes: 1,
    });

    const seam = manager as unknown as MonitorSeam;
    seam.isSessionAliveAsync = async () => true;
    seam.recordBuildContextMaybeAsync = async () => {};
    seam.detectCompletionMaybeAsync = async () => false;
    seam.captureMeaningfulTailMaybeAsync = async () => 'bypass permissions on';
    seam.hasActiveProcessesMaybeAsync = async () => false;
    seam.isTranscriptRecentlyActive = () => false;

    const blocked: string[] = [];
    const authorityScopes: string[] = [];
    manager.on('reapBlocked', (event: { skipped?: string }) => {
      if (event.skipped) blocked.push(event.skipped);
    });
    manager.on('sessionReaped', (event: { authorityScope?: string }) => {
      if (event.authorityScope) authorityScopes.push(event.authorityScope);
    });
    beforeTick?.();
    await maintenanceTick();
    return { id: s.id, blocked, authorityScopes };
  };

  it('without the flag, an active-process keep vetoes the reap (skipped:active-process)', async () => {
    manager.setReapGuard(guardWith());
    const s = await spawn('ap-1');
    const r = await manager.terminateSession(s.id, 'reaped-idle');
    expect(r).toEqual({ terminated: false, skipped: 'active-process' });
    expect(state.getSession(s.id)!.status).toBe('running'); // still alive
  });

  it('bypassActiveProcessKeep:true lifts the active-process veto ⇒ terminates', async () => {
    manager.setReapGuard(guardWith());
    const s = await spawn('ap-2');
    const r = await terminateAuthority(s.id, 'reaped-idle', { bypassActiveProcessKeep: true });
    expect(r.terminated).toBe(true);
    expect(state.getSession(s.id)!.status).toBe('completed');
  });

  it('bypassActiveProcessKeep does NOT lift a DIFFERENT keep-reason (recent-user-message still vetoes)', async () => {
    // No active process here; a recent user message is the live veto. The flag is
    // scoped to active-process, so this session must still be KEPT.
    manager.setReapGuard(guardWith({
      hasActiveProcesses: () => false,
      topicBinding: () => 1,
      recentUserMessage: () => true,
    }));
    const s = await spawn('ap-3');
    const r = await terminateAuthority(s.id, 'reaped-idle', { bypassActiveProcessKeep: true });
    expect(r).toEqual({ terminated: false, skipped: 'recent-user-message' });
    expect(state.getSession(s.id)!.status).toBe('running');
  });

  // ── bypassRecentUserMessageForConfirmedMove (post-transfer closeout, Part E) ──
  // The narrow keep-reason bypass the SessionReaper sets ONLY on a liveness-
  // confirmed genuine move whose freshest LOCAL user message predates the snapshot.
  // Lifts ONLY `recent-user-message`; every other guard is re-checked and vetoes.
  // Spec: docs/specs/post-transfer-closeout-correctness.md.
  it('without the bypass, a recent-user-message keep vetoes the closeout terminate', async () => {
    manager.setReapGuard(guardWith({ hasActiveProcesses: () => false, topicBinding: () => 1, recentUserMessage: () => true }));
    const s = await spawn('move-1');
    const r = await manager.terminateSession(s.id, 'topic moved');
    expect(r).toEqual({ terminated: false, skipped: 'recent-user-message' });
    expect(state.getSession(s.id)!.status).toBe('running');
  });

  it('bypassRecentUserMessageForConfirmedMove:true lifts ONLY recent-user-message ⇒ terminates', async () => {
    manager.setReapGuard(guardWith({ hasActiveProcesses: () => false, topicBinding: () => 1, recentUserMessage: () => true }));
    const s = await spawn('move-2');
    const r = await terminateAuthority(s.id, 'topic moved', { bypassRecentUserMessageForConfirmedMove: true });
    expect(r.terminated).toBe(true);
    expect(state.getSession(s.id)!.status).toBe('completed');
  });

  it('bypassRecentUserMessageForConfirmedMove does NOT lift active-process (still vetoes)', async () => {
    // active-process is armed; the move bypass is scoped to recent-user-message
    // only, so this session must still be KEPT.
    manager.setReapGuard(guardWith({ hasActiveProcesses: () => true }));
    const s = await spawn('move-3');
    const r = await terminateAuthority(s.id, 'topic moved', { bypassRecentUserMessageForConfirmedMove: true });
    expect(r).toEqual({ terminated: false, skipped: 'active-process' });
    expect(state.getSession(s.id)!.status).toBe('running');
  });

  it('bypassRecentUserMessageForConfirmedMove does NOT lift active-subagent (still vetoes)', async () => {
    manager.setReapGuard(guardWith({
      hasActiveProcesses: () => false,
      activeSubagentCount: () => 2, // a live subagent — must still veto
    }));
    const s = await spawn('move-4');
    const r = await terminateAuthority(s.id, 'topic moved', { bypassRecentUserMessageForConfirmedMove: true });
    expect(r.terminated).toBe(false);
    expect(r.skipped).toBe('active-subagent');
    expect(state.getSession(s.id)!.status).toBe('running');
  });

  // ── Co-occurrence masking regression (the Part E defect) ─────────────────────
  // The bug: `recent-user-message` (#6) co-occurring with a LOWER-priority guard.
  // blockedReason returns the highest-priority reason FIRST; the old impl matched
  // that ONE reason against the bypass, lifted it, and NEVER re-checked the lower
  // guard → a live-working session was terminated. The fix re-checks ALL other
  // guards: the bypass skips recent-user-message and the cascade falls through to
  // the live lower-priority guard, which still vetoes. These FAIL on the old code.
  it('recent-user-message + active-subagent + bypass ⇒ withheld with active-subagent (not terminated)', async () => {
    // recent-user-message (#6) is the highest-priority hit and is bypassed; an
    // active subagent (#8) is live and MUST still veto the kill.
    manager.setReapGuard(guardWith({
      hasActiveProcesses: () => false,
      topicBinding: () => 1,
      recentUserMessage: () => true, // #6 — bypassed
      activeSubagentCount: () => 2,  // #8 — live, must win
    }));
    const s = await spawn('move-cooc-1');
    const r = await terminateAuthority(s.id, 'topic moved', { bypassRecentUserMessageForConfirmedMove: true });
    expect(r).toEqual({ terminated: false, skipped: 'active-subagent' });
    expect(state.getSession(s.id)!.status).toBe('running'); // live session preserved
  });

  it('recent-user-message + open-commitment + bypass ⇒ withheld with open-commitment (not terminated)', async () => {
    // recent-user-message (#6) bypassed; an open commitment (#7) on the bound
    // topic — still recently active within the stale window — MUST still veto.
    manager.setReapGuard(guardWith({
      hasActiveProcesses: () => false,
      topicBinding: () => 1,
      recentUserMessage: () => true,        // #6 — bypassed (and satisfies the
                                            // stale-commitment recency window too)
      activeCommitmentForTopic: () => true, // #7 — open commitment, must win
    }));
    const s = await spawn('move-cooc-2');
    const r = await terminateAuthority(s.id, 'topic moved', { bypassRecentUserMessageForConfirmedMove: true });
    expect(r).toEqual({ terminated: false, skipped: 'open-commitment' });
    expect(state.getSession(s.id)!.status).toBe('running');
  });

  it('recent-user-message ALONE + bypass ⇒ DOES terminate (positive case stays green)', async () => {
    // No lower-priority guard is live, so once recent-user-message is bypassed the
    // whole cascade clears and the genuine-move leftover sheds.
    manager.setReapGuard(guardWith({
      hasActiveProcesses: () => false,
      topicBinding: () => 1,
      recentUserMessage: () => true, // the ONLY live guard, and it is bypassed
    }));
    const s = await spawn('move-cooc-3');
    const r = await terminateAuthority(s.id, 'topic moved', { bypassRecentUserMessageForConfirmedMove: true });
    expect(r.terminated).toBe(true);
    expect(state.getSession(s.id)!.status).toBe('completed');
  });

  // ── Analogous masking case for bypassActiveProcessKeep + main-process-active ──
  // active-process (#10) co-occurring with main-process-active (#11). The old impl
  // masked #11 (blockedReason returned #10, bypass lifted it, #11 never re-checked).
  // The fix re-checks #11, which still vetoes. FAILS on the old code.
  it('active-process + main-process-active + bypassActiveProcessKeep ⇒ withheld with main-process-active', async () => {
    manager.setReapGuard(guardWith({
      hasActiveProcesses: () => true,        // #10 — bypassed
      mainProcessActive: () => true,         // #11 — live, must win
    }));
    const s = await spawn('ap-cooc-1');
    const r = await terminateAuthority(s.id, 'reaped-idle', { bypassActiveProcessKeep: true });
    expect(r).toEqual({ terminated: false, skipped: 'main-process-active' });
    expect(state.getSession(s.id)!.status).toBe('running');
  });

  // ── runtime-private topic-moved closeout authority (F8) ─────────────────────
  // The machine a topic moves AWAY from is by definition usually NOT the
  // serving-lease holder, so the lease gate structurally vetoed the exact
  // closeout the transfer requires (`skipped:'not-lease-holder'` ×5 → breaker
  // give-up → leftover session survived; test-as-self matrix 2026-07-02, F8).
  // The flag lifts ONLY the lease gate — protected, CAS, and every KEEP-guard
  // are re-checked and still veto. Both sides of every boundary:

  it('REPRO: a non-lease-holder reaps its own over-age idle session through the maintenance path', async () => {
    manager.setReapGuard(guardWith({ hasActiveProcesses: () => false }));
    manager.setAwakeChecker(() => false);
    const { id, blocked, authorityScopes } = await runLocalExpiredMonitorTick('local-expired-on-standby', () => {
      // Production standby posture: the coordinator makes the state tree
      // read-only, while pool participation allows only per-session writes.
      state.setSessionPoolActive(true);
      state.setReadOnly(true);
    });

    // Before the fix this remains `running` and records `not-lease-holder`:
    // the local monitor proves age + idleness, then the global lease gate
    // vetoes the machine's cleanup of its own tmux process.
    expect(state.getSession(id)).toMatchObject({ status: 'killed', endedReason: 'age-limit' });
    expect(blocked).not.toContain('not-lease-holder');
    expect(authorityScopes).toEqual(['local-age-limit']);
  });

  it('a public autonomous age-limit request on a non-holder remains lease-refused', async () => {
    manager.setReapGuard(guardWith({ hasActiveProcesses: () => false }));
    manager.setAwakeChecker(() => false);
    const s = await spawn('public-age-limit-standby');
    const r = await manager.terminateSession(s.id, 'age-limit');
    expect(r).toEqual({ terminated: false, skipped: 'not-lease-holder' });
    expect(state.getSession(s.id)!.status).toBe('running');
  });

  it('the local age capability minter is runtime-private, not a callable prototype method', () => {
    const runtimeManager = manager as unknown as Record<string, unknown>;
    expect(runtimeManager.terminateLocalAgeExpiredSession).toBeUndefined();
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(manager))).not.toContain(
      'terminateLocalAgeExpiredSession',
    );
    expect(runtimeManager.terminateSessionInternal).toBeUndefined();
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(manager))).not.toContain(
      'terminateSessionInternal',
    );
  });

  it('a startup tick before ReapGuard installation cannot mint local age authority', async () => {
    manager.setAwakeChecker(() => false);
    const { id, blocked } = await runLocalExpiredMonitorTick('local-age-before-guard', () => {
      state.setSessionPoolActive(true);
      state.setReadOnly(true);
    });
    expect(state.getSession(id)!.status).toBe('running');
    expect(blocked).toContain('not-lease-holder');
    expect(mockTmuxSessions.has(state.getSession(id)!.tmuxSession)).toBe(true);
  });

  it('a pure read-only standby refuses before touching tmux or durable state', async () => {
    manager.setReapGuard(guardWith({ hasActiveProcesses: () => false }));
    manager.setAwakeChecker(() => false);
    let beforeKill = 0;
    manager.on('beforeSessionKill', () => { beforeKill++; });
    const { id, blocked } = await runLocalExpiredMonitorTick('local-age-pure-standby', () => {
      state.setReadOnly(true); // pool-active intentionally remains false
    });
    const saved = state.getSession(id)!;
    expect(saved.status).toBe('running');
    expect(blocked).toContain('not-lease-holder');
    expect(beforeKill).toBe(0);
    expect(mockTmuxSessions.has(saved.tmuxSession)).toBe(true);
  });

  it('an ownership change between preflight and commit refuses before touching tmux', async () => {
    manager.setReapGuard(guardWith({ hasActiveProcesses: () => false }));
    manager.setAwakeChecker(() => false);
    let beforeKill = 0;
    manager.on('beforeSessionKill', () => { beforeKill++; });
    let saveSpy: ReturnType<typeof vi.spyOn> | undefined;
    const { id, blocked } = await runLocalExpiredMonitorTick('local-age-ownership-race', () => {
      state.setSessionPoolActive(true);
      state.setReadOnly(true);
      // Preflight was admitted; model the ownership CAS changing immediately
      // before the durable transition. The write-first protocol must not kill.
      saveSpy = vi.spyOn(state, 'saveSession').mockImplementation(() => {
        throw new Error('StateManager is read-only [write-refused:not-owner]');
      });
    });
    saveSpy?.mockRestore();
    const saved = state.getSession(id)!;
    expect(saved.status).toBe('running');
    expect(blocked).toContain('local-write-refused');
    expect(beforeKill).toBe(1);
    expect(mockTmuxSessions.has(saved.tmuxSession)).toBe(true);
  });

  it('a throwing before-kill listener cannot strand a committed local cleanup', async () => {
    manager.setReapGuard(guardWith({ hasActiveProcesses: () => false }));
    manager.setAwakeChecker(() => false);
    manager.on('beforeSessionKill', () => { throw new Error('listener exploded'); });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { id, blocked, authorityScopes } = await runLocalExpiredMonitorTick(
      'local-age-listener-throws',
      () => {
        state.setSessionPoolActive(true);
        state.setReadOnly(true);
      },
    );

    consoleSpy.mockRestore();
    const saved = state.getSession(id)!;
    expect(saved).toMatchObject({ status: 'killed', endedReason: 'age-limit' });
    expect(mockTmuxSessions.has(saved.tmuxSession)).toBe(false);
    expect(blocked).toEqual([]);
    expect(authorityScopes).toEqual(['local-age-limit']);
  });

  it('a local tmux kill failure compensates state and emits no false reap', async () => {
    manager.setReapGuard(guardWith({ hasActiveProcesses: () => false }));
    manager.setAwakeChecker(() => false);
    mockChildProcessControl.killError = new Error('tmux transport failure');
    const { id, blocked, authorityScopes } = await runLocalExpiredMonitorTick(
      'local-age-kill-fails',
      () => {
        state.setSessionPoolActive(true);
        state.setReadOnly(true);
      },
    );

    const saved = state.getSession(id)!;
    expect(saved.status).toBe('running');
    expect(saved.endedAt).toBeUndefined();
    expect(saved.endedReason).toBeUndefined();
    expect(mockTmuxSessions.has(saved.tmuxSession)).toBe(true);
    expect(blocked).toContain('tmux-kill-failed');
    expect(authorityScopes).toEqual([]);
  });

  it('an arbitrary public origin label is normalized to autonomous authority', async () => {
    manager.setReapGuard(guardWith({ hasActiveProcesses: () => false }));
    manager.setAwakeChecker(() => false);
    const s = await spawn('forged-origin-on-standby');
    const r = await manager.terminateSession(s.id, 'age-limit', {
      origin: 'anything',
    } as Parameters<SessionManager['terminateSession']>[2] & { origin: string });

    expect(r).toEqual({ terminated: false, skipped: 'not-lease-holder' });
    expect(state.getSession(s.id)!.status).toBe('running');
    expect(mockTmuxSessions.has(s.tmuxSession)).toBe(true);
  });

  it.each([
    { option: 'knownDead', expected: 'recent-user-message', deps: { topicBinding: () => 1, recentUserMessage: () => true, hasActiveProcesses: () => false } },
    { option: 'bypassRecoveryFlag', expected: 'recovery-in-flight', deps: { isRecoveryActive: () => true, hasActiveProcesses: () => false } },
    { option: 'bypassActiveProcessKeep', expected: 'active-process', deps: {} },
    { option: 'bypassRecentUserMessageForConfirmedMove', expected: 'recent-user-message', deps: { topicBinding: () => 1, recentUserMessage: () => true, hasActiveProcesses: () => false } },
  ])('public callers cannot forge the $option guard bypass', async ({ option, expected, deps }) => {
    manager.setReapGuard(guardWith(deps));
    const s = await spawn(`forged-${option}`);
    const r = await manager.terminateSession(s.id, 'forged-public-bypass', {
      [option]: true,
    } as Parameters<SessionManager['terminateSession']>[2] & Record<string, boolean>);
    expect(r).toEqual({ terminated: false, skipped: expected });
    expect(state.getSession(s.id)!.status).toBe('running');
    expect(mockTmuxSessions.has(s.tmuxSession)).toBe(true);
  });

  it('a trusted operator kill reports tmux failure without changing state or emitting success', async () => {
    const s = await spawn('operator-kill-fails');
    mockChildProcessControl.killError = new Error('tmux transport failure');
    let reaped = 0;
    manager.on('sessionReaped', () => { reaped++; });
    const r = await terminateAuthority(s.id, 'operator-kill', {
      origin: 'operator',
      finalStatus: 'killed',
    });
    expect(r).toEqual({ terminated: false, skipped: 'tmux-kill-failed' });
    expect(state.getSession(s.id)!.status).toBe('running');
    expect(mockTmuxSessions.has(s.tmuxSession)).toBe(true);
    expect(reaped).toBe(0);
  });

  it('the synchronous tmux kill timeout is enforced with SIGKILL', async () => {
    const s = await spawn('bounded-sync-kill');
    const r = await terminateAuthority(s.id, 'operator-kill', {
      origin: 'operator',
      finalStatus: 'killed',
    });
    expect(r).toEqual({ terminated: true });
    expect(mockChildProcessControl.lastKillOptions).toMatchObject({
      timeout: 9000,
      killSignal: 'SIGKILL',
    });
  });

  it('a trusted operator kill fails closed when a listener revokes write admission before commit', async () => {
    const s = await spawn('operator-write-race');
    manager.on('beforeSessionKill', () => { state.setReadOnly(true); });
    const r = await terminateAuthority(s.id, 'operator-kill', {
      origin: 'operator',
      finalStatus: 'killed',
    });
    expect(r).toEqual({ terminated: false, skipped: 'local-write-refused' });
    expect(state.getSession(s.id)).toMatchObject({ status: 'running' });
    expect(mockTmuxSessions.has(s.tmuxSession)).toBe(true);
  });

  it('listener-side admission loss wins before a simultaneous tmux transport failure', async () => {
    const s = await spawn('operator-write-and-kill-race');
    mockChildProcessControl.killError = new Error('tmux transport failure');
    manager.on('beforeSessionKill', () => { state.setReadOnly(true); });
    const r = await terminateAuthority(s.id, 'operator-kill', {
      origin: 'operator',
      finalStatus: 'killed',
    });
    expect(r).toEqual({ terminated: false, skipped: 'local-write-refused' });
    expect(state.getSession(s.id)).toMatchObject({ status: 'running' });
    expect(mockTmuxSessions.has(s.tmuxSession)).toBe(true);
  });

  it('post-kill listener failures cannot suppress success or the reap audit event', async () => {
    const s = await spawn('operator-post-kill-listener-throws');
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const observed: string[] = [];
    manager.on('sessionComplete', () => { throw new Error('first completion listener exploded'); });
    manager.on('sessionComplete', () => { observed.push('completion'); });
    manager.on('sessionReaped', () => { throw new Error('first reap listener exploded'); });
    manager.on('sessionReaped', () => { observed.push('reap'); });

    const r = await terminateAuthority(s.id, 'operator-kill', {
      origin: 'operator',
      finalStatus: 'killed',
    });

    consoleSpy.mockRestore();
    expect(r).toEqual({ terminated: true });
    expect(state.getSession(s.id)).toMatchObject({ status: 'killed', endedReason: 'operator-kill' });
    expect(mockTmuxSessions.has(s.tmuxSession)).toBe(false);
    expect(observed).toEqual(['completion', 'reap']);
  });

  it.each([
    {
      label: 'recent user message',
      expected: 'recent-user-message',
      deps: { topicBinding: () => 1, recentUserMessage: () => true },
    },
    {
      label: 'open commitment',
      expected: 'open-commitment',
      deps: {
        topicBinding: () => 1,
        recentUserMessage: (_topicId: number, withinMs: number) => withinMs > 30 * 60_000,
        activeCommitmentForTopic: () => true,
      },
    },
    {
      label: 'in-flight structural work',
      expected: 'structural-long-work',
      deps: { topicBinding: () => 1, buildOrAutonomousActive: () => true },
    },
    {
      label: 'recovery in flight',
      expected: 'recovery-in-flight',
      deps: { isRecoveryActive: () => true },
    },
  ])('the local age capability does not bypass $label', async ({ expected, deps }) => {
    manager.setReapGuard(guardWith({ hasActiveProcesses: () => false, ...deps }));
    manager.setAwakeChecker(() => false);
    const { id, blocked } = await runLocalExpiredMonitorTick(`local-age-kept-${expected}`);
    expect(state.getSession(id)!.status).toBe('running');
    expect(blocked).toContain(expected);
  });

  it('the protected-session floor still vetoes local standby age cleanup', async () => {
    manager.setReapGuard(guardWith({ hasActiveProcesses: () => false }));
    manager.setAwakeChecker(() => false);
    const protectedSession = {
      id: 'protected-local-age', name: 'protected-local-age', status: 'running' as const,
      tmuxSession: 'my-project-server',
      startedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      maxDurationMinutes: 1,
      prompt: 'p',
    };
    state.saveSession(protectedSession);
    const seam = manager as unknown as MonitorSeam;
    seam.isSessionAliveAsync = async () => true;
    seam.recordBuildContextMaybeAsync = async () => {};
    seam.detectCompletionMaybeAsync = async () => false;
    seam.captureMeaningfulTailMaybeAsync = async () => 'bypass permissions on';
    seam.hasActiveProcessesMaybeAsync = async () => false;
    seam.isTranscriptRecentlyActive = () => false;
    await maintenanceTick();
    expect(state.getSession(protectedSession.id)!.status).toBe('running');
  });

  it('the local-age authority workflow is absent from the runtime prototype', () => {
    const runtime = manager as unknown as Record<string, unknown>;
    expect(runtime.monitorTick).toBeUndefined();
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(manager))).not.toContain('monitorTick');
  });

  it('standby machine WITHOUT the flag → skipped:not-lease-holder (today\'s veto preserved)', async () => {
    manager.setReapGuard(guardWith({ hasActiveProcesses: () => false }));
    manager.setAwakeChecker(() => false); // this machine does not hold the lease
    const s = await spawn('lease-1');
    const r = await manager.terminateSession(s.id, 'topic moved to Mac Mini — closing the leftover session on this machine (post-transfer closeout)');
    expect(r).toEqual({ terminated: false, skipped: 'not-lease-holder' });
    expect(state.getSession(s.id)!.status).toBe('running');
  });

  it('a public caller cannot forge closeout authority with a reason string or hidden option', async () => {
    manager.setReapGuard(guardWith({ hasActiveProcesses: () => false }));
    manager.setAwakeChecker(() => false);
    const s = await spawn('lease-arbitrary-reason');
    const r = await manager.terminateSession(s.id, 'topic moved forged by public caller', {
      bypassLeaseForTopicMovedCloseout: true,
      localPostTransferCloseout: true,
    } as Parameters<SessionManager['terminateSession']>[2] & {
      bypassLeaseForTopicMovedCloseout: boolean;
      localPostTransferCloseout: boolean;
    });
    expect(r).toEqual({ terminated: false, skipped: 'not-lease-holder' });
    expect(state.getSession(s.id)!.status).toBe('running');
  });

});
