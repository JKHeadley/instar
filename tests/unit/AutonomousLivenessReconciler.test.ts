import { describe, it, expect } from 'vitest';
import {
  AutonomousLivenessReconciler,
  type AutonomousLivenessReconcilerDeps,
  type AutonomousLivenessReconcilerConfig,
  type ReconcilerActiveRun,
  type InflightSpawnStatus,
  type DurableCapState,
} from '../../src/monitoring/AutonomousLivenessReconciler.js';

/**
 * Unit coverage for the level-triggered reconciler. Every dep is a fake, so we
 * drive the exact decision boundaries: the 8 candidate criteria (both sides),
 * the debounce (stable-live reset vs blip), the TWO separated counters (redie
 * brake vs spawn-failure budget), the bounded pressure gate, generation, the
 * atomic-claim + settle-kill, untrusted-state refusals, and dryRun.
 */

function makeRun(over: Partial<ReconcilerActiveRun> = {}): ReconcilerActiveRun {
  return {
    topicId: 100,
    remainingSeconds: 3600,
    paused: false,
    movedTo: null,
    moveSuspended: false,
    startedAtMs: 1_000_000 - 60_000,
    ...over,
  };
}

interface Harness {
  reconciler: AutonomousLivenessReconciler;
  audit: Record<string, unknown>[];
  respawned: { topicId: number; resumeUuid: string | null; cwd: string }[];
  settleKilled: number[];
  notices: { topicId: number; text: string }[];
  aggregated: { kind: string; detail: string }[];
  nowMs: { v: number };
  capSaved: DurableCapState[];
  flags: {
    runs: ReconcilerActiveRun[];
    liveTopics: Set<number>;
    queuedTopics: Set<number>;
    queuePaused: boolean;
    ownerElsewhere: Set<number>;
    leaseHeld: boolean;
    operatorStopped: Set<number>;
    quotaOk: boolean;
    sessionCountOk: boolean;
    migrationInFlight: boolean;
    pressure: 'normal' | 'moderate' | 'critical';
    respawnThrows: boolean;
    /** simulate a stop arriving DURING the async spawn (post-spawn settle). */
    stopDuringSpawn: number | null;
    inflight: Map<number, InflightSpawnStatus>;
    resumeUuids: Map<number, string | null>;
    cwds: Map<number, string | null>;
    ambiguous: Set<number>;
    currentGen: Map<number, number | null>;
    claimHeld: Set<number>;
    queueResurrections: Map<number, number>;
  };
}

function build(config: AutonomousLivenessReconcilerConfig = {}): Harness {
  const audit: Record<string, unknown>[] = [];
  const respawned: { topicId: number; resumeUuid: string | null; cwd: string }[] = [];
  const settleKilled: number[] = [];
  const notices: { topicId: number; text: string }[] = [];
  const aggregated: { kind: string; detail: string }[] = [];
  const capSaved: DurableCapState[] = [];
  const nowMs = { v: 1_000_000 };
  const flags: Harness['flags'] = {
    runs: [makeRun()],
    liveTopics: new Set<number>(),
    queuedTopics: new Set<number>(),
    queuePaused: false,
    ownerElsewhere: new Set<number>(),
    leaseHeld: true,
    operatorStopped: new Set<number>(),
    quotaOk: true,
    sessionCountOk: true,
    migrationInFlight: false,
    pressure: 'normal',
    respawnThrows: false,
    stopDuringSpawn: null,
    inflight: new Map<number, InflightSpawnStatus>(),
    resumeUuids: new Map<number, string | null>([[100, 'uuid-100']]),
    cwds: new Map<number, string | null>([[100, '/home/agent/.worktrees/x']]),
    ambiguous: new Set<number>(),
    currentGen: new Map<number, number | null>(),
    claimHeld: new Set<number>(),
    queueResurrections: new Map<number, number>(),
  };

  const deps: AutonomousLivenessReconcilerDeps = {
    now: () => nowMs.v,
    listActiveRuns: () => flags.runs,
    liveTopicSnapshot: () => flags.liveTopics,
    queuePaused: () => flags.queuePaused,
    topicInResumeQueue: (t) => flags.queuedTopics.has(t),
    operatorStoppedSince: (t) => {
      if (flags.stopDuringSpawn === t && respawned.some((r) => r.topicId === t)) return true;
      return flags.operatorStopped.has(t);
    },
    topicOwnerElsewhere: (t) => flags.ownerElsewhere.has(t),
    holdsLease: () => flags.leaseHeld,
    currentGenerationMs: (t) => (flags.currentGen.has(t) ? flags.currentGen.get(t)! : null),
    quotaOk: () => flags.quotaOk,
    sessionCountOk: () => flags.sessionCountOk,
    migrationInFlight: () => flags.migrationInFlight,
    pressureTier: () => flags.pressure,
    inflightSpawnStatus: (t) => flags.inflight.get(t) ?? { state: 'none' },
    resolveResumeUuid: (t) => (flags.resumeUuids.has(t) ? flags.resumeUuids.get(t)! : null),
    resolveCwd: (t) => (flags.cwds.has(t) ? flags.cwds.get(t)! : null),
    bindingUnambiguous: (t) => !flags.ambiguous.has(t),
    respawn: async (input) => {
      if (flags.respawnThrows) throw new Error('spawn failed');
      respawned.push(input);
    },
    claimInflight: (t) => {
      if (flags.claimHeld.has(t)) return false;
      flags.claimHeld.add(t);
      return true;
    },
    releaseClaim: (t) => flags.claimHeld.delete(t),
    settleKill: async (t) => {
      settleKilled.push(t);
    },
    notifyTopic: async (topicId, text) => {
      notices.push({ topicId, text });
    },
    raiseAggregated: (kind, detail) => aggregated.push({ kind, detail }),
    audit: (e) => audit.push(e),
    queueResurrectionCount: (t) => flags.queueResurrections.get(t) ?? 0,
    saveCapState: (st) => capSaved.push(JSON.parse(JSON.stringify(st))),
  };

  const reconciler = new AutonomousLivenessReconciler(deps, {
    enabled: true,
    dryRun: false,
    debounceTicks: 2,
    debounceWindowSec: 60,
    respawnCapPerWindow: 2,
    respawnCapWindowSec: 3600,
    spawnFailureRetryCeiling: 3,
    maxPressureBlockedTicks: 3,
    maxPressureBlockedSec: 100000,
    notifyUser: true,
    ...config,
  });

  return { reconciler, audit, respawned, settleKilled, notices, aggregated, nowMs, capSaved, flags };
}

/** Advance time + tick enough to clear the debounce (2 ticks spanning the window). */
async function tickPastDebounce(h: Harness): Promise<void> {
  await h.reconciler.tick(); // observation 1
  h.nowMs.v += 61_000; // past the 60s window
  await h.reconciler.tick(); // observation 2 → acts
}

const topicsRespawned = (h: Harness): number[] => h.respawned.map((r) => r.topicId);

describe('AutonomousLivenessReconciler', () => {
  describe('happy path — respawns an orphaned active run', () => {
    it('respawns a run that is active+remaining with no live session, after debounce', async () => {
      const h = build();
      await tickPastDebounce(h);
      expect(topicsRespawned(h)).toEqual([100]);
      expect(h.respawned[0]).toMatchObject({ topicId: 100, resumeUuid: 'uuid-100' });
      expect(h.audit.some((e) => e.event === 'respawned')).toBe(true);
      expect(h.notices).toHaveLength(1);
    });

    it('does NOT act on the first observation (debounce not met)', async () => {
      const h = build();
      await h.reconciler.tick();
      expect(h.respawned).toHaveLength(0);
      expect(h.audit.some((e) => e.event === 'debouncing')).toBe(true);
    });
  });

  describe('candidate criteria — each disqualifier prevents respawn', () => {
    it('C6: does not respawn when a live session already exists', async () => {
      const h = build();
      h.flags.liveTopics.add(100);
      await tickPastDebounce(h);
      expect(h.respawned).toHaveLength(0);
    });

    it('C2: does not respawn a paused run', async () => {
      const h = build();
      h.flags.runs = [makeRun({ paused: true })];
      await tickPastDebounce(h);
      expect(h.respawned).toHaveLength(0);
    });

    it('C4: does not respawn a run mid-machine-move (movedTo set)', async () => {
      const h = build();
      h.flags.runs = [makeRun({ movedTo: 'other-machine' })];
      await tickPastDebounce(h);
      expect(h.respawned).toHaveLength(0);
      expect(h.reconciler.status().conditions.find((c) => c.topicId === 100)?.state).toBe('mid-move');
    });

    it('C4: does not respawn a run mid-machine-move (moveSuspended)', async () => {
      const h = build();
      h.flags.runs = [makeRun({ moveSuspended: true })];
      await tickPastDebounce(h);
      expect(h.respawned).toHaveLength(0);
    });

    it('C3: does not respawn an operator-stopped topic', async () => {
      const h = build();
      h.flags.operatorStopped.add(100);
      await tickPastDebounce(h);
      expect(h.respawned).toHaveLength(0);
    });

    it('C7: does not respawn when the topic is already in the resume queue', async () => {
      const h = build();
      h.flags.queuedTopics.add(100);
      await tickPastDebounce(h);
      expect(h.respawned).toHaveLength(0);
      expect(h.reconciler.status().conditions.find((c) => c.topicId === 100)?.state).toBe('blocked-queue-owns');
    });

    it('global: does not respawn ANY run when the queue is globally paused', async () => {
      const h = build();
      h.flags.queuePaused = true;
      await tickPastDebounce(h);
      expect(h.respawned).toHaveLength(0);
    });
  });

  describe('criterion 5 — lease/ownership AND-gate', () => {
    it('owner-elsewhere → no respawn (blocked-not-owner)', async () => {
      const h = build();
      h.flags.ownerElsewhere.add(100);
      await tickPastDebounce(h);
      expect(h.respawned).toHaveLength(0);
      expect(h.reconciler.status().conditions.find((c) => c.topicId === 100)?.state).toBe('blocked-not-owner');
    });

    it('no lease held → no respawn (blocked-not-owner)', async () => {
      const h = build();
      h.flags.leaseHeld = false;
      await tickPastDebounce(h);
      expect(h.respawned).toHaveLength(0);
      expect(h.reconciler.status().conditions.find((c) => c.topicId === 100)?.state).toBe('blocked-not-owner');
    });

    it('single-machine (lease defaults HELD via dep=true) → DOES act', async () => {
      // The wiring defaults holdsLease() to coordinator.holdsLease() which is true
      // on single-machine. Here leaseHeld:true models that — and we DO respawn.
      const h = build();
      h.flags.leaseHeld = true;
      h.flags.ownerElsewhere.clear();
      await tickPastDebounce(h);
      expect(topicsRespawned(h)).toEqual([100]);
    });
  });

  describe('criterion 7 — in-flight spawn predicate with stale-spawning TTL', () => {
    it('in-flight (claimed) → skip', async () => {
      const h = build();
      h.flags.inflight.set(100, { state: 'claimed', sinceMs: 1_000_000 });
      await tickPastDebounce(h);
      expect(h.respawned).toHaveLength(0);
    });

    it('in-flight (spawning, fresh) → skip', async () => {
      const h = build();
      h.flags.inflight.set(100, { state: 'spawning', sinceMs: 1_000_000 });
      await tickPastDebounce(h);
      expect(h.respawned).toHaveLength(0);
    });

    it('stale spawning past the TTL → treated as NOT in-flight → acts', async () => {
      const h = build({ respawnTimeoutMs: 1000, inflightSpawnTtlMs: 5000 });
      // sinceMs far in the past relative to now (~1_061_000 after debounce).
      h.flags.inflight.set(100, { state: 'spawning', sinceMs: 1 });
      await tickPastDebounce(h);
      expect(topicsRespawned(h)).toEqual([100]);
    });
  });

  describe('generation guard (criterion 1)', () => {
    it('obsolete run (a NEWER registration exists) → no respawn', async () => {
      const h = build();
      // current registration started_at is NEWER than the run's own startedAtMs.
      h.flags.currentGen.set(100, makeRun().startedAtMs! + 10_000);
      await tickPastDebounce(h);
      expect(h.respawned).toHaveLength(0);
    });

    it('current generation (no newer registration) → acts', async () => {
      const h = build();
      h.flags.currentGen.set(100, makeRun().startedAtMs!); // equal = still current
      await tickPastDebounce(h);
      expect(topicsRespawned(h)).toEqual([100]);
    });

    it('no parseable started_at → not a candidate (safe side)', async () => {
      const h = build();
      h.flags.runs = [makeRun({ startedAtMs: null })];
      await tickPastDebounce(h);
      expect(h.respawned).toHaveLength(0);
    });
  });

  describe('debounce reset rule', () => {
    it('a stably-live session for a FULL window zeroes the death evidence', async () => {
      const h = build();
      await h.reconciler.tick(); // obs 1 (candidate)
      h.flags.liveTopics.add(100); // session came back
      h.nowMs.v += 61_000;
      await h.reconciler.tick(); // live → record liveSince
      h.nowMs.v += 61_000;
      await h.reconciler.tick(); // a full window stable-live → reset
      h.flags.liveTopics.delete(100); // gone again
      h.nowMs.v += 61_000;
      await h.reconciler.tick(); // obs 1 again — should NOT act yet
      expect(h.respawned).toHaveLength(0);
    });
  });

  describe('dryRun observe-only', () => {
    it('logs would-respawn and actuates nothing', async () => {
      const h = build({ dryRun: true });
      await tickPastDebounce(h);
      expect(h.respawned).toHaveLength(0);
      expect(h.notices).toHaveLength(0);
      expect(h.audit.some((e) => e.event === 'would-respawn' && e.dryRun === true)).toBe(true);
    });

    it('links a would-respawn to the next-tick recovered-live outcome', async () => {
      const h = build({ dryRun: true, debounceTicks: 1, debounceWindowSec: 0 });
      await h.reconciler.tick();
      const decision = h.audit.find((e) => e.event === 'would-respawn');
      h.flags.liveTopics.add(100);
      h.nowMs.v += 1_000;
      await h.reconciler.tick();
      expect(h.audit).toContainEqual(expect.objectContaining({
        event: 'would-respawn-followup',
        topicId: 100,
        decisionId: decision?.decisionId,
        outcome: 'recovered-live',
        dryRun: true,
      }));
    });

    it('classifies a continuing dry-run opportunity as still-orphaned', async () => {
      const h = build({ dryRun: true, debounceTicks: 1, debounceWindowSec: 0 });
      await h.reconciler.tick();
      const decision = h.audit.find((e) => e.event === 'would-respawn');
      h.nowMs.v += 1_000;
      await h.reconciler.tick();
      expect(h.audit).toContainEqual(expect.objectContaining({
        event: 'would-respawn-followup',
        decisionId: decision?.decisionId,
        outcome: 'still-orphaned',
      }));
    });

    it('classifies an operator stop without respawning', async () => {
      const h = build({ dryRun: true, debounceTicks: 1, debounceWindowSec: 0 });
      await h.reconciler.tick();
      h.flags.operatorStopped.add(100);
      h.nowMs.v += 1_000;
      await h.reconciler.tick();
      expect(h.audit).toContainEqual(expect.objectContaining({
        event: 'would-respawn-followup',
        outcome: 'operator-stopped',
      }));
      expect(h.respawned).toHaveLength(0);
    });

    it('classifies unreadable follow-up evidence as unknown', async () => {
      const h = build({ dryRun: true, debounceTicks: 1, debounceWindowSec: 0 });
      await h.reconciler.tick();
      const original = h.flags.liveTopics;
      Object.defineProperty(h.flags, 'liveTopics', { get: () => { throw new Error('snapshot unreadable'); }, configurable: true });
      h.nowMs.v += 1_000;
      await h.reconciler.tick();
      expect(h.audit).toContainEqual(expect.objectContaining({
        event: 'would-respawn-followup', outcome: 'evidence-unknown',
      }));
      Object.defineProperty(h.flags, 'liveTopics', { value: original, writable: true, configurable: true });
    });

    it('logs a shadow would-have-capped event in dryRun (adversarial F6)', async () => {
      const h = build({ dryRun: true, respawnCapPerWindow: 2, debounceTicks: 1, debounceWindowSec: 0 });
      // dryRun records a SHADOW redie per would-respawn, so the cap trips and the
      // reaper-thrash behavior becomes observable without any real respawn.
      for (let i = 0; i < 4; i++) {
        h.nowMs.v += 1000;
        await h.reconciler.tick();
      }
      expect(h.respawned).toHaveLength(0); // never actuates in dryRun
      expect(h.audit.filter((e) => e.event === 'would-respawn').length).toBe(2); // capped at 2
      expect(h.audit.some((e) => e.event === 'would-have-capped' && e.dryRun === true)).toBe(true);
    });
  });

  describe('quota / session-count / migration gates', () => {
    it('skips respawn when quota is unavailable', async () => {
      const h = build();
      h.flags.quotaOk = false;
      await tickPastDebounce(h);
      expect(h.respawned).toHaveLength(0);
      expect(h.audit.some((e) => e.event === 'skipped-quota')).toBe(true);
    });

    it('skips respawn when session-count cap is hit', async () => {
      const h = build();
      h.flags.sessionCountOk = false;
      await tickPastDebounce(h);
      expect(h.respawned).toHaveLength(0);
      expect(h.audit.some((e) => e.event === 'skipped-session-cap')).toBe(true);
    });

    it('skips respawn while a migration is in flight', async () => {
      const h = build();
      h.flags.migrationInFlight = true;
      await tickPastDebounce(h);
      expect(h.respawned).toHaveLength(0);
      expect(h.audit.some((e) => e.event === 'skipped-migration')).toBe(true);
    });
  });

  describe('bounded pressure gate (anti-reaper-thrash)', () => {
    it('defers under critical pressure (blocked-pressure)', async () => {
      const h = build();
      h.flags.pressure = 'critical';
      await tickPastDebounce(h);
      expect(h.respawned).toHaveLength(0);
      expect(h.audit.some((e) => e.event === 'blocked-pressure')).toBe(true);
    });

    it('after the tick bound under MODERATE pressure → acts anyway (dead run is not load)', async () => {
      const h = build({ maxPressureBlockedTicks: 2, debounceTicks: 1, debounceWindowSec: 0 });
      h.flags.pressure = 'moderate';
      // tick 1: candidate + debounce met → blocked-pressure (count 1)
      // tick 2: blocked-pressure (count 2) — still ≤ bound
      // tick 3: count 3 > bound → acts
      for (let i = 0; i < 3; i++) {
        h.nowMs.v += 1000;
        await h.reconciler.tick();
      }
      expect(topicsRespawned(h)).toEqual([100]);
    });

    it('after the bound under CRITICAL pressure → raises ONE attention item, does NOT respawn', async () => {
      const h = build({ maxPressureBlockedTicks: 2, debounceTicks: 1, debounceWindowSec: 0 });
      h.flags.pressure = 'critical';
      for (let i = 0; i < 4; i++) {
        h.nowMs.v += 1000;
        await h.reconciler.tick();
      }
      expect(h.respawned).toHaveLength(0);
      expect(h.aggregated.filter((a) => a.kind === 'liveness-sustained-pressure')).toHaveLength(1);
    });
  });

  describe('atomic claim + post-spawn settle-kill', () => {
    it('an operator stop arriving DURING the async spawn → settle-kills the just-spawned session', async () => {
      const h = build();
      h.flags.stopDuringSpawn = 100; // operatorStoppedSince returns true once respawn ran
      await tickPastDebounce(h);
      expect(topicsRespawned(h)).toEqual([100]); // the spawn DID happen
      expect(h.settleKilled).toEqual([100]); // then was terminally killed
      expect(h.audit.some((e) => e.event === 'settle-killed')).toBe(true);
      expect(h.notices).toHaveLength(0); // no self-heal notice on a settle-killed spawn
    });

    it('the actuation-instant recheck aborts on a live session appearing', async () => {
      const h = build();
      // first tick is observation; before the acting tick, make it live at recheck.
      await h.reconciler.tick();
      h.nowMs.v += 61_000;
      // The per-tick snapshot at the start does NOT have it live, but we flip it
      // live so the recheck (a fresh liveTopicSnapshot() read) sees it.
      let calls = 0;
      const origRun = h.flags.runs;
      void origRun;
      // Make the snapshot return empty first (tick-level) then live (recheck).
      const realDeps = h.reconciler as unknown as {
        deps: AutonomousLivenessReconcilerDeps;
      };
      const orig = realDeps.deps.liveTopicSnapshot;
      realDeps.deps.liveTopicSnapshot = () => {
        calls += 1;
        return calls >= 2 ? new Set([100]) : new Set<number>();
      };
      await h.reconciler.tick();
      realDeps.deps.liveTopicSnapshot = orig;
      expect(h.respawned).toHaveLength(0);
      expect(h.audit.some((e) => e.event === 'recheck-aborted')).toBe(true);
    });

    it('a held claim → aborts (blocked-queue-owns)', async () => {
      const h = build();
      await h.reconciler.tick();
      h.nowMs.v += 61_000;
      h.flags.claimHeld.add(100); // someone else holds the in-process claim
      await h.reconciler.tick();
      expect(h.respawned).toHaveLength(0);
      expect(h.audit.some((e) => e.event === 'claim-lost')).toBe(true);
    });
  });

  describe('untrusted-state refusals', () => {
    it('missing resumeUuid (no fresh fallback) → raises attention, does NOT respawn', async () => {
      const h = build();
      h.flags.resumeUuids.set(100, null);
      await tickPastDebounce(h);
      expect(h.respawned).toHaveLength(0);
      expect(h.aggregated.some((a) => a.kind === 'liveness-missing-resume')).toBe(true);
    });

    it('missing resumeUuid WITH allowFreshFallback → respawns fresh', async () => {
      const h = build({ allowFreshFallback: true });
      h.flags.resumeUuids.set(100, null);
      await tickPastDebounce(h);
      expect(topicsRespawned(h)).toEqual([100]);
      expect(h.respawned[0].resumeUuid).toBeNull();
    });

    it('unsafe/unresolvable cwd → raises attention, does NOT respawn', async () => {
      const h = build();
      h.flags.cwds.set(100, null); // resolveCwd refuses (escape/missing)
      await tickPastDebounce(h);
      expect(h.respawned).toHaveLength(0);
      expect(h.aggregated.some((a) => a.kind === 'liveness-bad-cwd')).toBe(true);
    });

    it('ambiguous binding → needs-attention, NEVER auto-respawn (criterion 8)', async () => {
      const h = build();
      h.flags.ambiguous.add(100);
      await tickPastDebounce(h);
      expect(h.respawned).toHaveLength(0);
      expect(h.aggregated.some((a) => a.kind === 'liveness-ambiguous-binding')).toBe(true);
      expect(h.audit.some((e) => e.event === 'ambiguous-binding')).toBe(true);
    });
  });

  describe('loop brake (P19) — separated counters', () => {
    it('redie cap: stops respawning and raises ONE attention item after the cap', async () => {
      const h = build({ respawnCapPerWindow: 2, debounceTicks: 1, debounceWindowSec: 0 });
      for (let i = 0; i < 5; i++) {
        h.nowMs.v += 1000;
        await h.reconciler.tick();
      }
      expect(h.respawned.length).toBe(2);
      const capItems = h.aggregated.filter((a) => a.kind === 'liveness-cap');
      expect(capItems.length).toBe(1); // surfaced once, not every tick
      expect(h.audit.some((e) => e.event === 'capped-gaveup')).toBe(true);
      expect(h.reconciler.status().conditions.find((c) => c.topicId === 100)?.state).toBe('capped');
    });

    it('redie cap is UNIFIED with the queue resurrection count', async () => {
      const h = build({ respawnCapPerWindow: 2, debounceTicks: 1, debounceWindowSec: 0 });
      h.flags.queueResurrections.set(100, 2); // the queue already revived it twice
      await h.reconciler.tick();
      h.nowMs.v += 1000;
      await h.reconciler.tick();
      // own redie 0 + queue 2 ≥ cap 2 → capped immediately, no respawn.
      expect(h.respawned).toHaveLength(0);
      expect(h.aggregated.some((a) => a.kind === 'liveness-cap')).toBe(true);
    });

    it('spawn-failure budget is SEPARATE from the redie brake', async () => {
      const h = build({ spawnFailureRetryCeiling: 3, respawnCapPerWindow: 2, debounceTicks: 1, debounceWindowSec: 0 });
      h.flags.respawnThrows = true;
      for (let i = 0; i < 5; i++) {
        h.nowMs.v += 1000;
        await h.reconciler.tick();
      }
      // spawn-failure ceiling (3) is hit BEFORE the redie cap (2) would have on
      // successes; the failures accrue to the spawn-failure counter only.
      expect(h.audit.filter((e) => e.event === 'respawn-failed').length).toBe(3);
      expect(h.audit.some((e) => e.event === 'spawn-failure-ceiling')).toBe(true);
      expect(h.aggregated.some((a) => a.kind === 'liveness-respawn-failed')).toBe(true);
      // The redie cap was NOT tripped by infra failures.
      expect(h.aggregated.some((a) => a.kind === 'liveness-cap')).toBe(false);
    });
  });

  describe('durable cap state', () => {
    it('persists separated redie + spawnFailure counters', async () => {
      const h = build({ debounceTicks: 1, debounceWindowSec: 0 });
      h.nowMs.v += 1000;
      await h.reconciler.tick();
      expect(h.capSaved.length).toBeGreaterThan(0);
      const last = h.capSaved[h.capSaved.length - 1];
      expect(last.redie['100']).toBeDefined();
      expect(last.spawnFailure).toBeDefined();
    });

    it('restores durable cap state on construction', () => {
      const h = build();
      const restored: DurableCapState = { redie: { '100': [1_000_000, 1_000_001] }, spawnFailure: {} };
      const deps = (h.reconciler as unknown as { deps: AutonomousLivenessReconcilerDeps }).deps;
      const r2 = new AutonomousLivenessReconciler(
        { ...deps, loadCapState: () => restored },
        { enabled: true, dryRun: false, respawnCapPerWindow: 2, respawnCapWindowSec: 3_600 },
      );
      // With 2 redie already at cap 2, status shows the restored count.
      expect(r2.status().redie.find((x) => x.topicId === 100)?.count).toBe(2);
    });
  });

  describe('guardStatus / status', () => {
    it('reports enabled + dryRun in guardStatus', () => {
      const h = build({ dryRun: true });
      expect(h.reconciler.guardStatus()).toMatchObject({ enabled: true, dryRun: true });
    });

    it('status reflects respawn total and conditions', async () => {
      const h = build();
      await tickPastDebounce(h);
      const s = h.reconciler.status();
      expect(s.respawnTotal).toBe(1);
      expect(s.enabled).toBe(true);
      expect(Array.isArray(s.conditions)).toBe(true);
    });
  });
});
