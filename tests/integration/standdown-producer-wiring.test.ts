// safe-git-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
/**
 * Integration — the duplicate-session stand-down PRODUCER inside the real
 * SessionReaper closeout, plus the drained-close and the cadence re-verify.
 *
 * Spec: docs/specs/duplicate-session-standdown.md
 *
 * This is the tier that proves the seam is genuinely WIRED rather than merely
 * present: the real reaper, the real StandDownRegistry, real dwell accumulation
 * across ticks. What it pins:
 *
 *  - a stand-down is registered ONLY where today's closeout FAILS (a vetoed
 *    terminate), so the existing idle-leftover path is untouched;
 *  - contested REAL work REFUSES to register and escalates instead;
 *  - the drained-close fires only after corroborated drain, and passes a CLAIM
 *    (never a bypass list) to the terminate authority;
 *  - the cadence re-verify releases a muzzle whose ownership premise lapsed;
 *  - the owner-scoped dwell resets on an owner change.
 */

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionReaper, type SessionReaperDeps, type SessionReaperConfig, type PressureReading } from '../../src/monitoring/SessionReaper.js';
import { StandDownRegistry } from '../../src/core/StandDownRegistry.js';
import type { Session } from '../../src/core/types.js';
import type { TranscriptProbe } from '../../src/monitoring/transcriptProber.js';
import type { DrainObservations } from '../../src/core/standDownDrain.js';

const WORKING_FRAME = 'esc to interrupt\nWorking...';
const RESOLVED_STATIC: TranscriptProbe = { resolved: true, path: '/t.jsonl', size: 100, mtime: 1000 };
const TOPIC = 46473;

const QUIET: DrainObservations = {
  idleAtPrompt: true, processWorking: false, transcriptGrew: false,
  growthIsBlockEchoOnly: false, nonAllowlistedCallsSinceBoundary: 0,
};
const BUSY: DrainObservations = { ...QUIET, processWorking: true };

function mkSession(over: Partial<Session> = {}): Session {
  return {
    id: 's1', name: 'sess', status: 'running', tmuxSession: 'topic-46473',
    startedAt: new Date(0).toISOString(), framework: 'claude-code', claudeSessionId: 'c1',
    ...over,
  };
}

function harness(opts: {
  deps?: Partial<SessionReaperDeps>;
  cfg?: Partial<SessionReaperConfig>;
  /** terminate outcome for the CLOSEOUT attempt (default: vetoed = busy duplicate) */
  closeoutTerminated?: boolean;
  dryRun?: boolean;
  owner?: () => { machineId: string; displayName: string } | null;
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'standdown-int-'));
  let now = 1_000_000;
  // The liveness snapshot refreshes on the closeout's own cadence, so it trails
  // `now` by roughly a tick — NOT by minutes. The admission validator checks the
  // AGE of the liveness proof (a snapshot that went stale while the owner died
  // must not admit a muzzle), so an unrealistically old fixture value is refused
  // — correctly. Keep the fixture honest instead of loosening the check.
  let reachable = now - 30_000;
  const sessions = [mkSession()];
  const audits: Array<Record<string, unknown>> = [];
  const attention: Array<{ id: string; title: string }> = [];
  const registry = new StandDownRegistry({ stateDir: dir, now: () => now });
  // A mutable ref, NOT a reassigned dep property: the reaper may snapshot its
  // deps object at construction, and a test that silently mutates a copy proves
  // nothing (it would "pass" by never exercising the drained path).
  let drainRef: DrainObservations = BUSY;

  const terminate = vi.fn(async (_id: string, _reason: string, o?: { standDownDrainedClose?: boolean }) => {
    // The drained close is a DIFFERENT call than the closeout attempt and must
    // succeed independently — that is exactly the point of the carve-out.
    if (o?.standDownDrainedClose) return { terminated: true };
    return opts.closeoutTerminated ? { terminated: true } : { terminated: false, skipped: 'active-process' };
  });

  const owner = opts.owner ?? (() => ({ machineId: 'laptop-a', displayName: 'Laptop' }));
  const deps: SessionReaperDeps = {
    listRunningSessions: () => sessions.filter((s) => s.status === 'running'),
    captureOutput: () => WORKING_FRAME,
    hasActiveProcesses: () => true,
    frameworkForSession: () => 'claude-code',
    probeTranscript: () => RESOLVED_STATIC,
    isRecoveryActive: () => false,
    isRelayLeaseActive: () => false,
    hasPendingInjection: () => false,
    topicBinding: () => TOPIC,
    recentUserMessage: () => false,
    activeCommitmentForTopic: () => false,
    activeSubagentCount: () => 0,
    buildOrAutonomousActive: () => false,
    protectedSessions: () => [],
    pressure: () => ({ tier: 'normal' } as PressureReading),
    terminate,
    markReaping: () => {},
    clearReaping: () => {},
    now: () => now,
    audit: (e) => audits.push(e),
    topicOwnerElsewhereInfo: owner,
    remoteOwnerHasLiveSession: () => ({ state: true as const, reachableAt: reachable }),
    selfMachineId: () => 'mini-b',
    ownershipEpochFor: () => 3,
    contestedWork: () => null,
    drainObservations: () => drainRef,
    standDown: {
      register: (req, selfId) => {
        const r = registry.register(req, selfId);
        return r.ok ? { ok: true as const, created: r.created } : { ok: false as const, refusal: r.refusal };
      },
      entryFor: (n) => registry.getBySession(n),
      liveEntries: () => registry.list(),
      observeDrain: (n, d, at) => registry.observeDrain(n, d, at),
      markClosed: (n) => registry.markClosed(n),
      dropVanished: (n) => registry.dropVanished(n),
      closedEpisodeCount: (t) => registry.closedEpisodeCount(t),
      closedEpisodeChurnThreshold: () => registry.config.closedEpisodeChurnThreshold,
      reverify: (n, ok, why) => registry.reverify(n, ok, why),
      release: (n, why, opts) => registry.release(n, why, opts),
      expire: (n) => registry.expire(n),
      refreshMarker: () => registry.refreshMarker(),
      recordCanaryHit: (n, detail) => registry.recordCanaryHit(n, detail),
      health: () => registry.health(),
      claimLatchAttention: () => registry.claimLatchAttention(),
      pruneLatches: (epochs) => registry.pruneLatches(epochs),
    },
    standDownConfig: () => ({ enabled: true, dryRun: opts.dryRun ?? false }),
    raiseStandDownAttention: (item) => attention.push({ id: item.id, title: item.title }),
    ...opts.deps,
  };

  const cfg: Partial<SessionReaperConfig> = {
    enabled: true, dryRun: false, minAgeMinutes: 0,
    topicMovedCloseout: true, topicMovedConfirmTicks: 2, closeoutLivenessGate: true,
    maxReapsPerTick: 3, maxReapsPerHour: 12,
    ...opts.cfg,
  };

  const reaper = new SessionReaper(deps, cfg);
  return {
    reaper, registry, terminate, audits, attention, dir,
    /** Advance one closeout dwell generation. */
    async tick() { now += 60_000; reachable = now - 30_000; await reaper.tick(); },
    setDrain(o: DrainObservations) { drainRef = o; },
    cleanup() { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } },
  };
}

describe('stand-down producer — inside the real closeout', () => {
  it('registers a stand-down when the closeout terminate is VETOED (the busy duplicate)', async () => {
    const h = harness({ closeoutTerminated: false });
    try {
      await h.tick(); // dwell 1
      expect(h.registry.list()).toHaveLength(0); // dwell not met yet
      await h.tick(); // dwell 2 → closeout attempts, gets vetoed
      const entries = h.registry.list();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ topicId: TOPIC, ownerMachineId: 'laptop-a', state: 'standing-down' });
      expect(h.audits.some((a) => a.event === 'standdown-registered')).toBe(true);
    } finally { h.cleanup(); }
  });

  it('registers NOTHING when the closeout succeeds — the idle-leftover path is untouched', async () => {
    const h = harness({ closeoutTerminated: true });
    try {
      await h.tick();
      await h.tick();
      expect(h.terminate).toHaveBeenCalled();
      expect(h.registry.list()).toHaveLength(0);
    } finally { h.cleanup(); }
  });

  it.each([
    ['structural-long-work', 'holds live work'],
    ['active-subagent', 'holds live work'],
    ['autonomous-run', 'running an autonomous job'],
  ] as const)('REFUSES to muzzle contested real work (%s) and escalates instead', async (contested) => {
    const h = harness({ closeoutTerminated: false, deps: { contestedWork: () => contested } });
    try {
      await h.tick();
      await h.tick();
      expect(h.registry.list()).toHaveLength(0); // no entry ⇒ no muzzle ⇒ no deadlock
      expect(h.attention.some((a) => a.id.includes('standdown-contested'))).toBe(true);
      expect(h.audits.some((a) => a.event === 'standdown-refused' && a.refusal === contested)).toBe(true);
    } finally { h.cleanup(); }
  });

  it('refuses to register without an ownership epoch (no episode key ⇒ no P19 brake)', async () => {
    const h = harness({ closeoutTerminated: false, deps: { ownershipEpochFor: () => null } });
    try {
      await h.tick();
      await h.tick();
      expect(h.registry.list()).toHaveLength(0);
    } finally { h.cleanup(); }
  });

  it('does nothing at all when the feature gate is off', async () => {
    const h = harness({ closeoutTerminated: false, deps: { standDownConfig: () => ({ enabled: false, dryRun: true }) } });
    try {
      await h.tick();
      await h.tick();
      expect(h.registry.list()).toHaveLength(0);
    } finally { h.cleanup(); }
  });
});

describe('stand-down maintenance — drain, close, release', () => {
  it('closes the session once drain is corroborated, passing a CLAIM (never a bypass list)', async () => {
    const h = harness({ closeoutTerminated: false });
    try {
      await h.tick(); await h.tick();            // registered (busy)
      expect(h.registry.list()).toHaveLength(1);
      h.setDrain(QUIET);
      await h.tick();                            // drain confirmation 1
      expect(h.registry.getBySession('topic-46473')?.state).toBe('standing-down');
      await h.tick();                            // confirmation 2 → drained → close
      const closeCall = h.terminate.mock.calls.find((c) => (c[2] as { standDownDrainedClose?: boolean })?.standDownDrainedClose);
      expect(closeCall).toBeDefined();
      // The caller may NOT name keep-reasons; the authority derives them itself.
      expect(closeCall![2]).not.toHaveProperty('bypassedReasons');
      expect(String(closeCall![1])).toMatch(/^topic moved — stand-down complete \(owned by laptop-a\)$/);
      expect(h.registry.list()).toHaveLength(0); // clean close, no latch
      expect(h.registry.latches()).toHaveLength(0);
      // The maintenance pass is wrapped so it can never take down the reaper's
      // primary job — which means a programming error inside it is SILENT unless
      // something asserts on it. It hid a broken seam through three runs of this
      // very suite before this line existed.
      expect(h.audits.filter((a) => a.event === 'standdown-tick-error')).toHaveLength(0);
    } finally { h.cleanup(); }
  });

  it('never closes while drain is unconfirmed (a busy muzzled session waits)', async () => {
    const h = harness({ closeoutTerminated: false });
    try {
      await h.tick(); await h.tick();
      await h.tick(); await h.tick();            // still BUSY observations
      expect(h.terminate.mock.calls.some((c) => (c[2] as { standDownDrainedClose?: boolean })?.standDownDrainedClose)).toBe(false);
      expect(h.registry.getBySession('topic-46473')?.state).toBe('standing-down');
    } finally { h.cleanup(); }
  });

  it('dryRun registers the entry but performs NO close', async () => {
    const h = harness({ closeoutTerminated: false, dryRun: true });
    try {
      await h.tick(); await h.tick();
      expect(h.registry.list()).toHaveLength(1);
      expect(h.registry.list()[0].dryRun).toBe(true);
      h.setDrain(QUIET);
      await h.tick(); await h.tick();
      expect(h.terminate.mock.calls.some((c) => (c[2] as { standDownDrainedClose?: boolean })?.standDownDrainedClose)).toBe(false);
    } finally { h.cleanup(); }
  });

  it('releases the muzzle when ownership stops naming another machine (hysteresis honored)', async () => {
    let ownerElsewhere = true;
    const h = harness({
      closeoutTerminated: false,
      owner: () => (ownerElsewhere ? { machineId: 'laptop-a', displayName: 'Laptop' } : null),
    });
    try {
      await h.tick(); await h.tick();
      expect(h.registry.list()).toHaveLength(1);
      ownerElsewhere = false;
      await h.tick();
      expect(h.registry.list()).toHaveLength(1); // one failed leg — not enough
      await h.tick();
      expect(h.registry.list()).toHaveLength(0); // second leg → released
      expect(h.registry.latches()).toHaveLength(1); // and latched against churn
    } finally { h.cleanup(); }
  });

  it('a VANISHED session drops its entry without a latch AND without churn evidence', async () => {
    // The session was closed by another path — or is merely absent for a tick
    // while it restarts. Either way it is NOT a retirement: the round-5 review
    // caught the old markClosed call here manufacturing closed-episode rows for
    // work the stand-down never did, walking the churn counter toward an
    // attention item about retirements that never happened.
    const h = harness({ closeoutTerminated: false, deps: { listRunningSessions: () => [] } });
    try {
      h.registry.register({
        sessionName: 'topic-46473', topicId: TOPIC, ownerMachineId: 'laptop-a',
        ownershipEpoch: 3, reason: 'r', dryRun: false,
      }, 'mini-b');
      await h.tick();
      expect(h.registry.list()).toHaveLength(0);
      expect(h.registry.latches()).toHaveLength(0);
      expect(h.registry.closedEpisodeCount(TOPIC)).toBe(0); // no manufactured churn
    } finally { h.cleanup(); }
  });
});

describe('Phase-5 review fixes — the legs that were silently vacuous', () => {
  it('a completed non-allowlisted call AFTER registration blocks the close (the boundary is the entry\'s)', async () => {
    // The bug this pins: passing the tick clock as the drain boundary made two
    // of the four legs vacuous, because every transcript record is older than
    // "now". The corroborated drain is the entire justification for crossing
    // active-process + recent-user-message + open-commitment, so a weakened
    // predicate here IS the blanket activeness bypass under another name.
    const h = harness({ closeoutTerminated: false });
    try {
      await h.tick(); await h.tick();
      expect(h.registry.list()).toHaveLength(1);
      h.setDrain({ ...QUIET, nonAllowlistedCallsSinceBoundary: 1 });
      await h.tick(); await h.tick(); await h.tick();
      expect(h.terminate.mock.calls.some((c) => (c[2] as { standDownDrainedClose?: boolean })?.standDownDrainedClose)).toBe(false);
    } finally { h.cleanup(); }
  });

  it('never muzzles a PROTECTED session — the operator\'s never-touch list wins', async () => {
    // Without this, a protected session gets tools blocked and voice 409'd, can
    // never be drain-closed (`protected` is never bypassed), and rides the TTL
    // into the frozen state — strictly worse than the duplicate it addresses.
    const h = harness({ closeoutTerminated: false, deps: { protectedSessions: () => ['topic-46473'] } });
    try {
      await h.tick(); await h.tick();
      expect(h.registry.list()).toHaveLength(0);
      expect(h.audits.some((a) => a.event === 'standdown-refused' && a.refusal === 'protected')).toBe(true);
    } finally { h.cleanup(); }
  });

  it('gives a framework whose drain cannot be probed the SHORTER ttl', async () => {
    // Deciding this by dep PRESENCE made it always-false in production (the
    // composition root always supplies the dep; it returns null per call), so
    // the shorter TTL and its config key were dead code.
    const h = harness({ closeoutTerminated: false, deps: { drainObservations: () => null } });
    try {
      await h.tick(); await h.tick();
      const [entry] = h.registry.list();
      expect(entry).toBeDefined();
      const ttlMinutes = Math.round((entry.expiresAt - entry.issuedAt) / 60_000);
      expect(ttlMinutes).toBe(15);
    } finally { h.cleanup(); }
  });

  it('REFUSES registration on a STALE liveness proof (the leg only the validator covers)', async () => {
    // The closeout established ownership + liveness + dwell upstream, but a
    // snapshot that went stale while the owner died must not admit a muzzle —
    // and nothing except the assertion validator checks the proof's own AGE.
    // The proof must ADVANCE (or the closeout's own dwell rule stops it first,
    // which would make this test pass for the wrong reason) while staying OLDER
    // than the validator's evidence-age ceiling.
    let staleAt = 0;
    const h = harness({
      closeoutTerminated: false,
      deps: { remoteOwnerHasLiveSession: () => ({ state: true as const, reachableAt: (staleAt += 1000) }) },
    });
    try {
      await h.tick(); await h.tick(); await h.tick();
      expect(h.registry.list()).toHaveLength(0);
      expect(h.audits.some((a) => a.event === 'standdown-refused' && a.refusal === 'liveness-proof-stale')).toBe(true);
    } finally { h.cleanup(); }
  });

  it('CONVERGES through the block loop: in-flight step lands, model retries, then goes quiet', async () => {
    // The scenario the whole cooperative design rests on, and the one that was
    // structurally impossible before the round-2 fixes: the muzzle lets the held
    // step finish, the model reacts to the blocks for a while, and then it
    // settles — at which point the session drains and is retired cleanly, rather
    // than riding its TTL into the frozen state and paging the operator.
    const h = harness({ closeoutTerminated: false });
    try {
      await h.tick(); await h.tick();
      expect(h.registry.list()).toHaveLength(1);

      // Window 1: the in-flight step the muzzle deliberately allowed completes.
      h.setDrain({ ...QUIET, transcriptGrew: true, nonAllowlistedCallsSinceBoundary: 1 });
      await h.tick();
      expect(h.registry.getBySession('topic-46473')?.state).toBe('standing-down');

      // Window 2: the model retries and is blocked — growth, but only the loop.
      h.setDrain({ ...QUIET, transcriptGrew: true, growthIsBlockEchoOnly: true });
      await h.tick();

      // Window 3: it settles.
      h.setDrain(QUIET);
      await h.tick();

      const closeCall = h.terminate.mock.calls.find((c) => (c[2] as { standDownDrainedClose?: boolean })?.standDownDrainedClose);
      expect(closeCall).toBeDefined();
      expect(h.registry.list()).toHaveLength(0);
      expect(h.registry.health().expiredEpisodes).toBe(0); // the happy path, not the escalation path
    } finally { h.cleanup(); }
  });

  it('the canary does NOT fire on the designed happy path (in-flight step finishes, session complies)', async () => {
    // The muzzle deliberately lets the held step finish, and a compliant session
    // then never calls evaluate at all. Firing there would report SUCCESS as a
    // bypass — which is how a health alarm earns the right to be ignored.
    const h = harness({ closeoutTerminated: false });
    try {
      await h.tick(); await h.tick();
      h.setDrain({ ...BUSY, nonAllowlistedCallsSinceBoundary: 1 });
      for (let i = 0; i < 15; i++) await h.tick(); // well past the 10m window
      expect(h.registry.health().canaryHits).toBe(0);
    } finally { h.cleanup(); }
  });

  it('the canary DOES fire on the bypass shape (guard was engaged, then went silent while work continued)', async () => {
    const h = harness({ closeoutTerminated: false });
    try {
      await h.tick(); await h.tick();
      // The guard WAS engaged — a block was evaluated and recorded.
      h.registry.countBlockedCall('topic-46473');
      // …and then the marker was lifted: calls keep completing, no evaluate traffic.
      h.setDrain({ ...BUSY, nonAllowlistedCallsSinceBoundary: 3 });
      for (let i = 0; i < 15; i++) await h.tick();
      expect(h.registry.health().canaryHits).toBeGreaterThan(0);
    } finally { h.cleanup(); }
  });
});

describe('owner-scoped dwell (predecessor round-4 finding 7)', () => {
  it('resets the confirmation count when the OWNER changes mid-dwell', async () => {
    let machineId = 'laptop-a';
    const h = harness({
      closeoutTerminated: false,
      owner: () => ({ machineId, displayName: machineId }),
    });
    try {
      await h.tick();               // dwell 1 against laptop-a
      machineId = 'mac-mini-c';     // the topic moved AGAIN, to a different owner
      await h.tick();               // must START OVER, not fire on laptop-a's count
      expect(h.registry.list()).toHaveLength(0);
      await h.tick();               // now dwell 2 against mac-mini-c
      expect(h.registry.list()).toHaveLength(1);
      expect(h.registry.list()[0].ownerMachineId).toBe('mac-mini-c');
    } finally { h.cleanup(); }
  });
});
