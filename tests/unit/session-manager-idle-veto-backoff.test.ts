/**
 * SessionManager idle-zombie veto-backoff wiring (session-respawn-thrash Fix A + A′).
 *
 * Drives the private `handleIdleZombie` decision directly (the branch lives deep
 * inside monitorTick behind full tmux/liveness preconditions; the integration test
 * for AgeKillBackoff established this pattern). Covers:
 *  (1)  vetoed kill sets cooldown, no re-fire next tick
 *  (2)  cleared kill still kills (authority unchanged)
 *  (3)  cooldown expiry ⇒ one fresh attempt
 *  (4)  active-output branch resets
 *  (5)  one WARN per veto episode
 *  (10) DISABLED contract: enabled:false ⇒ no ledger, attempt every tick
 *  (11) single guard-eval: blockedReason called ONCE per cooldown-expiry tick
 *  (12) public terminateSession exposes NO precomputed option
 *  (13) cooldownMs:0 enabled-but-no-cooldown
 *  breaker: exactly one idleZombieVetoEscalation after escalateAfterEpisodes
 *  migrateConfig: default written when absent; operator override untouched + idempotent
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

import { SessionManager, type SessionManagerOptions } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import { ReapGuard, type ReapGuardDeps } from '../../src/core/ReapGuard.js';
import type { SessionManagerConfig, Session } from '../../src/core/types.js';
import type { IncidentDedupe } from '../../src/monitoring/IncidentDedupe.js';
import { normalizeReasonKey } from '../../src/core/VetoedKillBackoff.js';

const MIN = 60_000;

/** A ReapGuard whose keep-reason is controlled by the passed deps overrides. */
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
      hasActiveProcesses: () => false,
      ...over,
    },
    { minAgeMs: 0 },
  );

/** Invoke the private idle-zombie decision helper for one tick. */
async function tickIdleZombie(
  manager: SessionManager,
  session: Session,
  idleMs: number,
  now: number,
  binding: string | number | null = 1,
): Promise<void> {
  await (manager as unknown as {
    handleIdleZombie(
      s: Session, idle: number, b: string | number | null, n: number, note: string, thr: number,
    ): Promise<void>;
  }).handleIdleZombie(session, idleMs, binding, now, ' (topic-bound, threshold 240m)', 240);
}

function makeManager(
  dir: string,
  idleKillVetoBackoff?: SessionManagerOptions['idleKillVetoBackoff'],
): { manager: SessionManager; state: StateManager } {
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const state = new StateManager(stateDir);
  const config: SessionManagerConfig = {
    tmuxPath: '/usr/bin/tmux',
    claudePath: '/usr/local/bin/claude',
    projectDir: dir,
    maxSessions: 5,
    protectedSessions: ['p-server'],
    completionPatterns: ['bye'],
  };
  const manager = new SessionManager(config, state, idleKillVetoBackoff ? { idleKillVetoBackoff } : {});
  return { manager, state };
}

describe('SessionManager idle-zombie veto-backoff (Fix A)', () => {
  let tmpDir: string;
  let manager: SessionManager;
  let state: StateManager;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-idle-veto-'));
    mockTmuxSessions.clear();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    manager?.stopMonitoring();
    warnSpy.mockRestore();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'idle-veto-backoff cleanup' });
  });

  const spawn = (m: SessionManager, name: string) => m.spawnSession({ name, prompt: 'p' });

  // ── (1) vetoed kill sets cooldown, no re-fire next tick ──────────────────────
  it('a vetoed idle-zombie kill sets a cooldown → no kill ATTEMPT (reap-log write) next tick', async () => {
    const { manager: m, state: st } = makeManager(tmpDir, { enabled: true, cooldownMs: 30 * MIN, escalateAfterEpisodes: 6 });
    manager = m; state = st;
    const guard = guardWith({ topicBinding: () => 1, recentUserMessage: () => true });
    m.setReapGuard(guard);
    // reapBlocked is emitted once per kill ATTEMPT that the guard vetoes — the
    // reap-log-write proxy the hot-spin flooded. It must fire ONCE per episode.
    let reapBlocked = 0;
    m.on('reapBlocked', () => { reapBlocked++; });
    const s = await spawn(m, 'z1');
    const now = 1_000_000;
    await tickIdleZombie(m, s, 300 * MIN, now);            // tick 1 — attempt → vetoed
    await tickIdleZombie(m, s, 300 * MIN, now + 5_000);    // tick 2 — inside cooldown, quiet skip
    await tickIdleZombie(m, s, 300 * MIN, now + 10_000);   // tick 3 — still inside cooldown
    expect(reapBlocked).toBe(1);                           // exactly ONE attempt, not 3
    expect(state.getSession(s.id)?.status).toBe('running'); // still alive
  });

  // ── (2) cleared kill still kills (authority unchanged) ───────────────────────
  it('a session with NO keep-reason is killed on the first attempt (no cooldown)', async () => {
    const { manager: m, state: st } = makeManager(tmpDir, { enabled: true, cooldownMs: 30 * MIN, escalateAfterEpisodes: 6 });
    manager = m; state = st;
    m.setReapGuard(guardWith()); // no keep-reason → blockedReason null
    const s = await spawn(m, 'z2');
    await tickIdleZombie(m, s, 300 * MIN, 2_000_000);
    expect(state.getSession(s.id)?.status).toBe('completed'); // killed as before
    const ledger = (m as unknown as { idleKillBackoff: { trackedCount: number } }).idleKillBackoff;
    expect(ledger.trackedCount).toBe(0); // no cooldown recorded for a real kill
  });

  // ── (3) cooldown expiry ⇒ one fresh attempt ──────────────────────────────────
  it('after the cooldown elapses, exactly one fresh kill ATTEMPT is allowed', async () => {
    const { manager: m } = makeManager(tmpDir, { enabled: true, cooldownMs: 30 * MIN, escalateAfterEpisodes: 6 });
    manager = m;
    m.setReapGuard(guardWith({ topicBinding: () => 1, recentUserMessage: () => true }));
    let reapBlocked = 0;
    m.on('reapBlocked', () => { reapBlocked++; });
    const s = await spawn(m, 'z3');
    const now = 3_000_000;
    await tickIdleZombie(m, s, 300 * MIN, now);                 // attempt 1
    await tickIdleZombie(m, s, 300 * MIN, now + 5_000);         // suppressed
    expect(reapBlocked).toBe(1);
    await tickIdleZombie(m, s, 300 * MIN, now + 30 * MIN);      // window elapsed → attempt 2
    expect(reapBlocked).toBe(2);
  });

  // ── (4) active-output branch resets ──────────────────────────────────────────
  it('reset() drops the cooldown so a resumed session gets a fresh kill attempt next tick', async () => {
    const { manager: m } = makeManager(tmpDir, { enabled: true, cooldownMs: 30 * MIN, escalateAfterEpisodes: 6 });
    manager = m;
    m.setReapGuard(guardWith({ topicBinding: () => 1, recentUserMessage: () => true }));
    let reapBlocked = 0;
    m.on('reapBlocked', () => { reapBlocked++; });
    const s = await spawn(m, 'z4');
    const now = 4_000_000;
    await tickIdleZombie(m, s, 300 * MIN, now);       // attempt 1 → vetoed → cooldown
    (m as unknown as { idleKillBackoff: { reset(id: string): void } }).idleKillBackoff.reset(s.id);
    await tickIdleZombie(m, s, 300 * MIN, now + 5_000); // reset → fresh attempt despite being within window
    expect(reapBlocked).toBe(2);
  });

  // ── (5) one WARN per veto episode ────────────────────────────────────────────
  it('emits exactly one veto WARN per episode across many ticks', async () => {
    const { manager: m } = makeManager(tmpDir, { enabled: true, cooldownMs: 30 * MIN, escalateAfterEpisodes: 100 });
    manager = m;
    m.setReapGuard(guardWith({ topicBinding: () => 1, recentUserMessage: () => true }));
    const s = await spawn(m, 'z5');
    warnSpy.mockClear();
    let now = 5_000_000;
    for (let i = 0; i < 20; i++) { await tickIdleZombie(m, s, 300 * MIN, now); now += 5_000; }
    const vetoWarns = warnSpy.mock.calls.filter((c) => String(c[0]).includes('idle-zombie cleanup vetoed'));
    expect(vetoWarns.length).toBe(1);
  });

  // ── (10) DISABLED contract ───────────────────────────────────────────────────
  it('DISABLED (enabled:false) → no ledger, attempts terminate every tick, no once-gating', async () => {
    const { manager: m } = makeManager(tmpDir, { enabled: false, cooldownMs: 30 * MIN, escalateAfterEpisodes: 6 });
    manager = m;
    // the ledger field is never constructed
    expect((m as unknown as { idleKillBackoff?: unknown }).idleKillBackoff).toBeUndefined();
    const guard = guardWith({ topicBinding: () => 1, recentUserMessage: () => true });
    const spy = vi.spyOn(guard, 'blockedReason');
    m.setReapGuard(guard);
    const s = await spawn(m, 'z10');
    let now = 6_000_000;
    let escalations = 0;
    m.on('idleZombieVetoEscalation', () => { escalations++; });
    for (let i = 0; i < 5; i++) { await tickIdleZombie(m, s, 300 * MIN, now); now += 5_000; }
    // Every tick attempts terminate → the guard is consulted every tick (prior behavior).
    expect(spy).toHaveBeenCalledTimes(5);
    expect(escalations).toBe(0); // no breaker when disabled
  });

  // ── (11) single guard-eval per cooldown-expiry tick ──────────────────────────
  it('within a single kill-attempt tick the guard is evaluated ONCE (precompute threaded, no double-call)', async () => {
    const { manager: m } = makeManager(tmpDir, { enabled: true, cooldownMs: 30 * MIN, escalateAfterEpisodes: 6 });
    manager = m;
    const guard = guardWith({ topicBinding: () => 1, recentUserMessage: () => true });
    const spy = vi.spyOn(guard, 'blockedReason');
    m.setReapGuard(guard);
    const s = await spawn(m, 'z11');
    spy.mockClear();
    await tickIdleZombie(m, s, 300 * MIN, 7_000_000);
    // One eval total for the tick — the precompute is threaded into
    // terminateSessionInternal so it does NOT re-evaluate the guard (C2).
    // Without the precompute this would be 2 (gate + terminate).
    expect(spy).toHaveBeenCalledTimes(1);
  });

  // ── (12) public terminateSession exposes NO precomputed option ───────────────
  it('public terminateSession re-evaluates the guard itself (no precomputed authority path)', async () => {
    const { manager: m } = makeManager(tmpDir, { enabled: true, cooldownMs: 30 * MIN, escalateAfterEpisodes: 6 });
    manager = m;
    const guard = guardWith({ topicBinding: () => 1, recentUserMessage: () => true });
    const spy = vi.spyOn(guard, 'blockedReason');
    m.setReapGuard(guard);
    const s = await spawn(m, 'z12');
    // A NON-idle-zombie kill through the public API — the guard IS consulted here
    // (no precomputed verdict could be injected via the public options object).
    const r = await m.terminateSession(s.id, 'some-other-reason');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ terminated: false, skipped: 'recent-user-message' });
  });

  // ── (13) cooldownMs:0 enabled-but-no-cooldown ────────────────────────────────
  it('cooldownMs:0 → evaluate every tick, YET one WARN per episode (log-once state survives)', async () => {
    const { manager: m } = makeManager(tmpDir, { enabled: true, cooldownMs: 0, escalateAfterEpisodes: 100 });
    manager = m;
    const guard = guardWith({ topicBinding: () => 1, recentUserMessage: () => true });
    const spy = vi.spyOn(guard, 'blockedReason');
    m.setReapGuard(guard);
    const s = await spawn(m, 'z13');
    warnSpy.mockClear();
    let now = 8_000_000;
    for (let i = 0; i < 6; i++) { await tickIdleZombie(m, s, 300 * MIN, now); now += 5_000; }
    // no cooldown → evaluated every tick
    expect(spy).toHaveBeenCalledTimes(6);
    // still log-once per episode (the ledger IS constructed at cooldownMs:0 — not a disable)
    const vetoWarns = warnSpy.mock.calls.filter((c) => String(c[0]).includes('idle-zombie cleanup vetoed'));
    expect(vetoWarns.length).toBe(1);
    const ledger = (m as unknown as { idleKillBackoff: { trackedCount: number } }).idleKillBackoff;
    expect(ledger.trackedCount).toBe(1); // constructed + tracking despite zero cooldown
  });

  // ── breaker: exactly one escalation after escalateAfterEpisodes ───────────────
  it('P19 breaker: exactly ONE escalation after escalateAfterEpisodes episodes (with a real dedupe)', async () => {
    const { InProcessIncidentDedupe } = await import('../../src/monitoring/IncidentDedupe.js');
    const { manager: m } = makeManager(tmpDir, { enabled: true, cooldownMs: 0, escalateAfterEpisodes: 3 });
    manager = m;
    m.setReapGuard(guardWith({ topicBinding: () => 1, recentUserMessage: () => true }));
    (m as unknown as { setIncidentDedupe(s: IncidentDedupe): void }).setIncidentDedupe(new InProcessIncidentDedupe());
    let escalations = 0;
    let lastMsg = '';
    m.on('idleZombieVetoEscalation', (e: { message: string }) => { escalations++; lastMsg = e.message; });
    const s = await spawn(m, 'z-breaker');
    let now = 9_000_000;
    for (let i = 0; i < 10; i++) { await tickIdleZombie(m, s, 300 * MIN, now); now += 5_000; }
    expect(escalations).toBe(1); // deduped to one per incident within the window
    expect(lastMsg).toContain('permanently vetoed from idle-zombie cleanup');
    expect(lastMsg).toContain('recent-user-message');
  });

  it('the breaker does NOT fire before escalateAfterEpisodes episodes', async () => {
    const { InProcessIncidentDedupe } = await import('../../src/monitoring/IncidentDedupe.js');
    const { manager: m } = makeManager(tmpDir, { enabled: true, cooldownMs: 0, escalateAfterEpisodes: 6 });
    manager = m;
    m.setReapGuard(guardWith({ topicBinding: () => 1, recentUserMessage: () => true }));
    (m as unknown as { setIncidentDedupe(s: IncidentDedupe): void }).setIncidentDedupe(new InProcessIncidentDedupe());
    let escalations = 0;
    m.on('idleZombieVetoEscalation', () => { escalations++; });
    const s = await spawn(m, 'z-early');
    let now = 10_000_000;
    for (let i = 0; i < 3; i++) { await tickIdleZombie(m, s, 300 * MIN, now); now += 5_000; }
    expect(escalations).toBe(0); // only 3 episodes, threshold 6
  });

  // ── STANDBY-machine breaker gate (second-pass review point 9) ─────────────────
  // On a NON-lease-holder machine the idle-zombie kill short-circuits at the lease
  // gate with skipped:'not-lease-holder' BEFORE the keep-guard runs. That is an
  // ownership state, NOT a "stuck session" — it must COOL DOWN (flood-stop) but must
  // NEVER raise the misleading "permanently vetoed from idle-zombie cleanup" HIGH item.
  it('a standby (not-lease-holder) skip cools down but NEVER escalates the breaker', async () => {
    const { InProcessIncidentDedupe } = await import('../../src/monitoring/IncidentDedupe.js');
    const { manager: m } = makeManager(tmpDir, { enabled: true, cooldownMs: 0, escalateAfterEpisodes: 3 });
    manager = m;
    // No keep-reason (guard clears) — the kill would proceed were this the lease holder.
    m.setReapGuard(guardWith({ topicBinding: () => 1 }));
    // This machine is a STANDBY (non-lease-holder) → terminateSession returns
    // skipped:'not-lease-holder' before the keep-guard is consulted.
    m.setAwakeChecker(() => false);
    (m as unknown as { setIncidentDedupe(s: IncidentDedupe): void }).setIncidentDedupe(new InProcessIncidentDedupe());
    let escalations = 0;
    m.on('idleZombieVetoEscalation', () => { escalations++; });
    const s = await spawn(m, 'z-standby');
    let now = 11_000_000;
    for (let i = 0; i < 10; i++) { await tickIdleZombie(m, s, 300 * MIN, now); now += 5_000; }
    // 10 not-lease-holder episodes, well past the threshold of 3 —
    expect(escalations).toBe(0); // …yet NO escalation (not a keep-reason)
    // …but the cooldown DID engage (the flood-stop applies universally).
    // (The existing 'P19 breaker' test above already proves a GENUINE keep-reason —
    // recent-user-message ∈ IDLE_ZOMBIE_ESCALATION_REASONS — DOES escalate, so the
    // gate is not over-broad.)
    const ledger = (m as unknown as { idleKillBackoff: { trackedCount: number; episodeCount(id: string): number } }).idleKillBackoff;
    expect(ledger.trackedCount).toBe(1);
    expect(ledger.episodeCount(s.id)).toBeGreaterThanOrEqual(3);
  });
});

// ── KEY CONSISTENCY (fix-the-fix: idle-zombie-veto-key-consistency.md) ───────────
// The merged Fix A keyed shouldRequest on the reapGuard reason but recorded the
// TERMINATE-path reason (not-lease-holder on a standby). When a standby session ALSO
// has a reapGuard keep-reason, the two keys DIFFER every tick → the stale-reprieve
// deletes the ledger entry → the cooldown never holds → a 5s spin (2523 live WARNs).
describe('SessionManager idle-zombie veto-backoff — KEY CONSISTENCY (fix-the-fix)', () => {
  let tmpDir: string;
  let manager: SessionManager;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-idle-veto-kc-'));
    mockTmuxSessions.clear();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    manager?.stopMonitoring();
    warnSpy.mockRestore();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'idle-veto-kc cleanup' });
  });
  const spawn = (m: SessionManager, name: string) => m.spawnSession({ name, prompt: 'p' });

  // THE LOAD-BEARING REPRO — fails on the buggy code (attempt every tick), passes on the fix.
  // Standby machine + a concurrent reapGuard keep-reason + a REAL cooldown window.
  it('standby + a reapGuard keep-reason: the cooldown HOLDS — exactly ONE terminate ATTEMPT across many ticks', async () => {
    const { manager: m } = makeManager(tmpDir, { enabled: true, cooldownMs: 30 * MIN, escalateAfterEpisodes: 6 });
    manager = m;
    // reapGuard returns a NON-null keep-reason (recent-user-message) — differs from the
    // terminate-path skip (not-lease-holder) that a standby machine actually stores.
    m.setReapGuard(guardWith({ topicBinding: () => 1, recentUserMessage: () => true }));
    m.setAwakeChecker(() => false); // STANDBY → terminate short-circuits at the lease gate
    let reapBlocked = 0;
    m.on('reapBlocked', () => { reapBlocked++; }); // the reap-log-write / terminate-ATTEMPT proxy
    const s = await spawn(m, 'kc-standby-keep');
    let now = 20_000_000;
    for (let i = 0; i < 12; i++) { await tickIdleZombie(m, s, 300 * MIN, now); now += 5_000; }
    // The bug fired an attempt on ALL 12 ticks; the fix holds the cooldown → exactly ONE.
    expect(reapBlocked).toBe(1);
    const ledger = (m as unknown as { idleKillBackoff: { trackedCount: number } }).idleKillBackoff;
    expect(ledger.trackedCount).toBe(1);
  });

  // EQUIVALENCE PROPERTY TEST (the Structure>Willpower guard) — the ORACLE is the REAL
  // terminateSessionInternal; the pre-check reasonKey MUST equal the reason it stores.
  it('property: computeIdleZombieReapVerdict().reasonKey equals the REAL terminate skip reason for every mirrored cell', async () => {
    type Priv = {
      computeIdleZombieReapVerdict(s: Session, now: number): { blocked: unknown; reasonKey: string | null };
      terminateSessionInternal(id: string, reason: string, opts: { disposition: string }): Promise<{ terminated: boolean; skipped?: string }>;
    };
    // Each cell: [label, reapGuard deps (before protected wiring), awake?, protected?].
    // Only SKIP cells (terminate returns terminated:false) are in the equality matrix;
    // in-flight/already-* residuals are excluded by design (see spec §4).
    const cells: Array<[string, Partial<ReapGuardDeps>, boolean, boolean]> = [
      ['protected+standby', {}, false, true],
      ['protected+awake', {}, true, true],
      ['standby+keep', { topicBinding: () => 1, recentUserMessage: () => true }, false, false],
      ['standby+nokeep', { topicBinding: () => 1 }, false, false],
      ['awake+keep', { topicBinding: () => 1, recentUserMessage: () => true }, true, false],
    ];
    let cellIdx = 0;
    for (const [label, deps, awake, isProtected] of cells) {
      mockTmuxSessions.clear(); // each cell is an independent SessionManager + spawn
      const { manager: m } = makeManager(tmpDir, { enabled: true, cooldownMs: 30 * MIN, escalateAfterEpisodes: 6 });
      m.setAwakeChecker(() => awake);
      const s = await spawn(m, `kc-cell-${cellIdx++}`);
      // For a PROTECTED cell, protect the session's ACTUAL tmuxSession on BOTH paths:
      // the reapGuard's protectedSessions() AND terminate's config.protectedSessions
      // (both test `config.protectedSessions.includes(session.tmuxSession)` semantics).
      if (isProtected) {
        (m as unknown as { config: { protectedSessions: string[] } }).config.protectedSessions = [s.tmuxSession];
        m.setReapGuard(guardWith({ ...deps, protectedSessions: () => [s.tmuxSession] }));
      } else {
        m.setReapGuard(guardWith(deps));
      }
      const priv = m as unknown as Priv;
      const verdict = priv.computeIdleZombieReapVerdict(s, 21_000_000);
      const result = await priv.terminateSessionInternal(s.id, 'idle-zombie', { disposition: 'terminal' });
      // Only assert equality when terminate SKIPPED (a kill has no stored veto reason).
      if (!result.terminated) {
        expect(normalizeReasonKey(result.skipped ? { reason: result.skipped } : null), label)
          .toBe(verdict.reasonKey);
      }
      m.stopMonitoring();
    }
  });

  // isAwakeMachine UNSET (never wired) → the presence-guard short-circuits, falls through
  // to the reapGuard reason, no TypeError.
  it('isAwakeMachine UNSET: falls through to the reapGuard reason (no throw)', async () => {
    const { manager: m } = makeManager(tmpDir, { enabled: true, cooldownMs: 30 * MIN, escalateAfterEpisodes: 6 });
    manager = m;
    m.setReapGuard(guardWith({ topicBinding: () => 1, recentUserMessage: () => true }));
    // deliberately DO NOT call setAwakeChecker → isAwakeMachine stays undefined
    const s = await spawn(m, 'kc-unset');
    const priv = m as unknown as { computeIdleZombieReapVerdict(s: Session, now: number): { reasonKey: string | null } };
    expect(() => priv.computeIdleZombieReapVerdict(s, 22_000_000)).not.toThrow();
    expect(priv.computeIdleZombieReapVerdict(s, 22_000_000).reasonKey).toBe('recent-user-message');
  });
});

// ── migrateConfig default ──────────────────────────────────────────────────────
describe('migrateConfigIdleKillVetoBackoffDefault (Migration Parity)', () => {
  it('writes the tuning-only default block (enabled OMITTED so the dev-agent gate decides) when absent', async () => {
    const { migrateConfigIdleKillVetoBackoffDefault } = await import('../../src/core/PostUpdateMigrator.js');
    const config: Record<string, unknown> = { monitoring: {} };
    expect(migrateConfigIdleKillVetoBackoffDefault(config)).toBe(true);
    const written = (config.monitoring as Record<string, unknown>).idleKillVetoBackoff as Record<string, unknown>;
    // enable-path integrity: NO explicit `enabled` — resolveDevAgentGate governs it
    // (live-on-dev / dark-on-fleet). An explicit `enabled:false` here would force-dark
    // the dev agent and defeat the § Activation milestone-1 Echo soak.
    expect(written).toEqual({
      cooldownMs: 1_800_000,
      escalateAfterEpisodes: 6,
    });
    expect(Object.prototype.hasOwnProperty.call(written, 'enabled')).toBe(false);
  });

  it('creates monitoring when it is missing entirely', async () => {
    const { migrateConfigIdleKillVetoBackoffDefault } = await import('../../src/core/PostUpdateMigrator.js');
    const config: Record<string, unknown> = {};
    expect(migrateConfigIdleKillVetoBackoffDefault(config)).toBe(true);
    expect((config.monitoring as Record<string, unknown>).idleKillVetoBackoff).toBeDefined();
  });

  it('leaves an operator override BYTE-FOR-BYTE untouched (existence-checked, idempotent)', async () => {
    const { migrateConfigIdleKillVetoBackoffDefault } = await import('../../src/core/PostUpdateMigrator.js');
    const override = { enabled: true, cooldownMs: 600_000 };
    const config: Record<string, unknown> = { monitoring: { idleKillVetoBackoff: { ...override } } };
    expect(migrateConfigIdleKillVetoBackoffDefault(config)).toBe(false); // no write
    expect((config.monitoring as Record<string, unknown>).idleKillVetoBackoff).toEqual(override);
    // second run is a no-op too
    expect(migrateConfigIdleKillVetoBackoffDefault(config)).toBe(false);
  });
});
