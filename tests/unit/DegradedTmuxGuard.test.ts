/**
 * Tier-1 unit tests for DegradedTmuxGuard — the (C) signal-only degraded-shared-tmux
 * watcher. Covers both sides of every boundary the spec names:
 *   - Bounded Accumulation burst-invariant: 10,000 samples, the ring NEVER exceeds windowSize.
 *   - EWMA correctness + a single hiccup ≠ degradation.
 *   - N-cycle corroboration both sides (sustained ⇒ exactly ONE episode; <N ⇒ zero; mid-reset ⇒ zero).
 *   - Load gate both sides (over the per-core threshold suppresses; under raises).
 *   - onStall counts as a corroborating cycle + a throwing notify is swallowed.
 *   - ONE deduped item + age-escalation + a new episode on recurrence.
 *   - NEVER kills tmux (no exec/kill funnel exists on the guard).
 *   - settle window excludes post-refresh samples from corroboration.
 *   - guardStatus() / snapshot() purity.
 *   - the machine-tagged payload is the deps' concern — here we assert the episode shape.
 */

import { describe, expect, it } from 'vitest';
import { DegradedTmuxGuard, type DegradedTmuxEpisode } from '../../src/monitoring/DegradedTmuxGuard.js';

function makeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

/** A harness: capture raised episodes + drive a controllable load + clock. */
function makeGuard(
  cfg: Partial<ConstructorParameters<typeof DegradedTmuxGuard>[0]> = {},
  load = 0,
) {
  const clock = makeClock();
  const raised: DegradedTmuxEpisode[] = [];
  let loadVal = load;
  const guard = new DegradedTmuxGuard(
    {
      enabled: true,
      windowSize: 8,
      ewmaAlpha: 0.5,
      slowCallThresholdMs: 9000,
      episodeCorroborationCycles: 3,
      loadGateMaxLoadPerCore: 1.5,
      episodeEscalateIntervalMs: 30 * 60_000,
      settleWindowMs: 60_000,
      ...cfg,
    },
    {
      raiseAttention: (ep) => { raised.push({ ...ep }); },
      loadPerCore: () => loadVal,
      now: clock.now,
    },
  );
  return { guard, raised, clock, setLoad: (v: number) => { loadVal = v; } };
}

describe('DegradedTmuxGuard', () => {
  describe('Bounded Accumulation (burst-invariant)', () => {
    it('the latency ring NEVER exceeds windowSize across 10,000 samples', () => {
      const { guard } = makeGuard({ windowSize: 64, slowCallThresholdMs: 1_000_000 /* never degraded */ });
      for (let i = 0; i < 10_000; i++) {
        guard.observeTmuxCall(i % 50, 'success');
        // The ring count must never exceed the fixed capacity, ever.
        expect(guard.snapshot().ringCount).toBeLessThanOrEqual(64);
      }
      expect(guard.snapshot().ringCount).toBe(64);
      expect(guard.snapshot().totalSamples).toBe(10_000);
    });
  });

  describe('EWMA + single-hiccup', () => {
    it('a single slow call does not by itself open an episode', () => {
      const { guard, raised } = makeGuard();
      // One 20s call, then fast calls — the EWMA decays back below the threshold.
      guard.observeTmuxCall(20_000, 'indeterminate');
      guard.observeTmuxCall(50, 'success');
      guard.observeTmuxCall(50, 'success');
      guard.observeTmuxCall(50, 'success');
      expect(raised).toHaveLength(0);
      expect(guard.snapshot().episodeOpen).toBe(false);
    });

    it('tracks EWMA toward sustained slow latency', () => {
      const { guard } = makeGuard({ episodeCorroborationCycles: 1000 /* never open */ });
      for (let i = 0; i < 10; i++) guard.observeTmuxCall(10_000, 'success');
      const snap = guard.snapshot();
      expect(snap.ewmaMs).not.toBeNull();
      expect(snap.ewmaMs!).toBeGreaterThanOrEqual(9000);
    });
  });

  describe('N-cycle corroboration', () => {
    it('sustained degradation opens EXACTLY ONE episode at the corroboration threshold', () => {
      const { guard, raised } = makeGuard({ episodeCorroborationCycles: 3 });
      // Each slow call is a degraded cycle (EWMA >= threshold after the first).
      guard.observeTmuxCall(12_000, 'success'); // cycle 1 degraded
      expect(raised).toHaveLength(0);
      guard.observeTmuxCall(12_000, 'success'); // cycle 2 degraded
      expect(raised).toHaveLength(0);
      guard.observeTmuxCall(12_000, 'success'); // cycle 3 degraded ⇒ open + raise
      expect(raised).toHaveLength(1);
      expect(guard.snapshot().episodeOpen).toBe(true);
      // Further degraded cycles do NOT re-raise (deduped until age-escalation).
      guard.observeTmuxCall(12_000, 'success');
      guard.observeTmuxCall(12_000, 'success');
      expect(raised).toHaveLength(1);
    });

    it('fewer than N corroborating cycles raises ZERO episodes', () => {
      const { guard, raised } = makeGuard({ episodeCorroborationCycles: 3 });
      guard.observeTmuxCall(12_000, 'success');
      guard.observeTmuxCall(12_000, 'success');
      expect(raised).toHaveLength(0);
    });

    it('a clean cycle mid-streak resets corroboration to zero', () => {
      const { guard, raised } = makeGuard({ episodeCorroborationCycles: 3, ewmaAlpha: 1 /* no smoothing */ });
      guard.observeTmuxCall(12_000, 'success'); // degraded 1
      guard.observeTmuxCall(12_000, 'success'); // degraded 2
      guard.observeTmuxCall(10, 'success'); // CLEAN ⇒ reset
      guard.observeTmuxCall(12_000, 'success'); // degraded 1 again
      guard.observeTmuxCall(12_000, 'success'); // degraded 2
      expect(raised).toHaveLength(0);
    });
  });

  describe('load gate', () => {
    it('high host load suppresses corroboration (busy-box clause)', () => {
      const { guard, raised, setLoad } = makeGuard({ episodeCorroborationCycles: 3 }, 2.0);
      setLoad(2.0); // over the 1.5 per-core threshold
      for (let i = 0; i < 6; i++) guard.observeTmuxCall(12_000, 'success');
      expect(raised).toHaveLength(0);
      expect(guard.snapshot().consecutiveSlowCycles).toBe(0);
    });

    it('low host load lets a sustained degradation raise', () => {
      const { guard, raised, setLoad } = makeGuard({ episodeCorroborationCycles: 3 }, 0.5);
      setLoad(0.5);
      guard.observeTmuxCall(12_000, 'success');
      guard.observeTmuxCall(12_000, 'success');
      guard.observeTmuxCall(12_000, 'success');
      expect(raised).toHaveLength(1);
    });
  });

  describe('onStall', () => {
    it('a stall counts as a corroborating slow cycle', () => {
      const { guard, raised } = makeGuard({ episodeCorroborationCycles: 3, slowCallThresholdMs: 9000 });
      guard.onStall({ stallSeconds: 14, cpuBusyRatio: 0, timestamp: new Date().toISOString() });
      guard.onStall({ stallSeconds: 14, cpuBusyRatio: 0, timestamp: new Date().toISOString() });
      guard.onStall({ stallSeconds: 14, cpuBusyRatio: 0, timestamp: new Date().toISOString() });
      expect(raised).toHaveLength(1);
    });

    it('a throwing raiseAttention is swallowed (never crashes onStall)', () => {
      const clock = makeClock();
      const guard = new DegradedTmuxGuard(
        { enabled: true, episodeCorroborationCycles: 1, slowCallThresholdMs: 1 },
        {
          raiseAttention: () => { throw new Error('boom'); },
          loadPerCore: () => 0,
          now: clock.now,
        },
      );
      expect(() => guard.onStall({ stallSeconds: 14, cpuBusyRatio: 0, timestamp: '' })).not.toThrow();
      // The episode state is still recorded even though the notify threw.
      expect(guard.snapshot().episodesRaised).toBe(1);
    });

    it('onStall on a disabled guard is a no-op', () => {
      const clock = makeClock();
      const raised: DegradedTmuxEpisode[] = [];
      const guard = new DegradedTmuxGuard(
        { enabled: false, episodeCorroborationCycles: 1 },
        { raiseAttention: (ep) => raised.push(ep), loadPerCore: () => 0, now: clock.now },
      );
      guard.onStall({ stallSeconds: 99, cpuBusyRatio: 0, timestamp: '' });
      expect(raised).toHaveLength(0);
      expect(guard.snapshot().totalSamples).toBe(0);
    });
  });

  describe('dedup + age-escalation + recurrence', () => {
    it('re-raises the SAME episode once the escalate interval elapses', () => {
      const { guard, raised, clock } = makeGuard({ episodeCorroborationCycles: 3, episodeEscalateIntervalMs: 30 * 60_000 });
      guard.observeTmuxCall(12_000, 'success');
      guard.observeTmuxCall(12_000, 'success');
      guard.observeTmuxCall(12_000, 'success'); // open + raise #1
      expect(raised).toHaveLength(1);
      const firstId = raised[0].id;
      // Not yet past the escalate interval.
      clock.advance(20 * 60_000);
      guard.observeTmuxCall(12_000, 'success');
      expect(raised).toHaveLength(1);
      // Past the escalate interval ⇒ re-raise the SAME episode id with a larger age.
      clock.advance(11 * 60_000);
      guard.observeTmuxCall(12_000, 'success');
      expect(raised).toHaveLength(2);
      expect(raised[1].id).toBe(firstId);
      expect(raised[1].ageMs).toBeGreaterThan(raised[0].ageMs);
    });

    it('a recovery (clean cycle) then a fresh degradation opens a NEW episode', () => {
      const { guard, raised } = makeGuard({ episodeCorroborationCycles: 3, ewmaAlpha: 1 });
      guard.observeTmuxCall(12_000, 'success');
      guard.observeTmuxCall(12_000, 'success');
      guard.observeTmuxCall(12_000, 'success'); // episode 1
      expect(raised).toHaveLength(1);
      const firstId = raised[0].id;
      // Recover: a clean cycle closes the open episode.
      guard.observeTmuxCall(10, 'success');
      expect(guard.snapshot().episodeOpen).toBe(false);
      // Fresh degradation ⇒ a NEW episode (distinct id).
      guard.observeTmuxCall(12_000, 'success');
      guard.observeTmuxCall(12_000, 'success');
      guard.observeTmuxCall(12_000, 'success');
      expect(raised).toHaveLength(2);
      expect(raised[1].id).not.toBe(firstId);
    });
  });

  describe('settle window', () => {
    it('excludes samples within settleWindowMs of an onRefresh() from corroboration', () => {
      const { guard, raised, clock } = makeGuard({ episodeCorroborationCycles: 3, settleWindowMs: 60_000 });
      guard.onRefresh();
      // These slow calls are within the settle window ⇒ recorded for liveness, excluded from corroboration.
      guard.observeTmuxCall(12_000, 'success');
      guard.observeTmuxCall(12_000, 'success');
      guard.observeTmuxCall(12_000, 'success');
      guard.observeTmuxCall(12_000, 'success');
      expect(raised).toHaveLength(0);
      expect(guard.snapshot().consecutiveSlowCycles).toBe(0);
      expect(guard.snapshot().lastTickAt).toBeGreaterThan(0); // liveness still recorded
      // After the settle window, corroboration resumes.
      clock.advance(61_000);
      guard.observeTmuxCall(12_000, 'success');
      guard.observeTmuxCall(12_000, 'success');
      guard.observeTmuxCall(12_000, 'success');
      expect(raised).toHaveLength(1);
    });
  });

  describe('NEVER kills tmux', () => {
    it('exposes no exec/kill surface (signal-only)', () => {
      const { guard } = makeGuard();
      const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(guard));
      for (const name of proto) {
        expect(name).not.toMatch(/kill|exec|spawn|refresh.*server|killServer/i);
      }
      // The public surface is purely ingest + read.
      expect(typeof guard.onStall).toBe('function');
      expect(typeof guard.observeTmuxCall).toBe('function');
      expect(typeof guard.onRefresh).toBe('function');
      expect(typeof guard.guardStatus).toBe('function');
      expect(typeof guard.snapshot).toBe('function');
    });
  });

  describe('getter purity', () => {
    it('guardStatus() returns enabled + lastTickAt without side effects', () => {
      const { guard, clock } = makeGuard();
      expect(guard.guardStatus()).toEqual({ enabled: true, lastTickAt: 0 });
      clock.advance(123);
      guard.observeTmuxCall(50, 'success');
      const s = guard.guardStatus();
      expect(s.enabled).toBe(true);
      expect(s.lastTickAt).toBeGreaterThan(0);
      const totalsBefore = guard.snapshot().totalSamples;
      guard.guardStatus();
      guard.snapshot();
      expect(guard.snapshot().totalSamples).toBe(totalsBefore); // pure reads
    });

    it('snapshot() reflects counters and never mutates state', () => {
      const { guard } = makeGuard();
      guard.observeTmuxCall(12_000, 'killed-client');
      guard.observeTmuxCall(50, 'indeterminate');
      const s1 = guard.snapshot();
      const s2 = guard.snapshot();
      expect(s1).toEqual(s2);
      expect(s1.killedClientCount).toBe(1);
      expect(s1.staleCount).toBe(1);
      expect(s1.totalSamples).toBe(2);
      // No episode open here ⇒ both reads return null (a clean read, no mutation).
      expect(s1.openEpisode).toBeNull();
      expect(s2.openEpisode).toBeNull();
    });

    it('snapshot() returns a COPY of an open episode, not the live reference', () => {
      const { guard } = makeGuard({ episodeCorroborationCycles: 3, ewmaAlpha: 1 });
      guard.observeTmuxCall(12_000, 'success');
      guard.observeTmuxCall(12_000, 'success');
      guard.observeTmuxCall(12_000, 'success'); // open an episode
      const s1 = guard.snapshot();
      const s2 = guard.snapshot();
      expect(s1.openEpisode).not.toBeNull();
      expect(s2.openEpisode).not.toBeNull();
      // Each snapshot returns a distinct copy — a caller mutating one can't corrupt guard state.
      expect(s1.openEpisode === s2.openEpisode).toBe(false);
      expect(s1.openEpisode).toEqual(s2.openEpisode);
    });
  });

  describe('disabled', () => {
    it('observeTmuxCall on a disabled guard is inert', () => {
      const clock = makeClock();
      const raised: DegradedTmuxEpisode[] = [];
      const guard = new DegradedTmuxGuard(
        { enabled: false, episodeCorroborationCycles: 1, slowCallThresholdMs: 1 },
        { raiseAttention: (ep) => raised.push(ep), loadPerCore: () => 0, now: clock.now },
      );
      for (let i = 0; i < 5; i++) guard.observeTmuxCall(99_999, 'success');
      expect(raised).toHaveLength(0);
      expect(guard.snapshot().totalSamples).toBe(0);
      expect(guard.guardStatus().enabled).toBe(false);
    });
  });

  describe('load gate — recovery side (both directions)', () => {
    it('a load DROP below the threshold lets a sustained degradation raise (gate releases)', () => {
      const { guard, raised, setLoad } = makeGuard({ episodeCorroborationCycles: 3 }, 2.0);
      // Over the 1.5 per-core gate: degraded cycles are suppressed, no corroboration advance.
      setLoad(2.0);
      for (let i = 0; i < 3; i++) guard.observeTmuxCall(12_000, 'success');
      expect(raised).toHaveLength(0);
      expect(guard.snapshot().consecutiveSlowCycles).toBe(0);
      // Load recovers below the gate: now the SAME sustained degradation corroborates + raises.
      setLoad(0.5);
      guard.observeTmuxCall(12_000, 'success'); // 1
      guard.observeTmuxCall(12_000, 'success'); // 2
      guard.observeTmuxCall(12_000, 'success'); // 3 ⇒ open + raise
      expect(raised).toHaveLength(1);
    });

    it('exactly AT the per-core threshold does NOT suppress (boundary is strictly greater-than)', () => {
      // The guard suppresses only when loadPerCore > loadGateMaxLoadPerCore. At == the gate,
      // corroboration must still advance — assert the boundary side that raises.
      const { guard, raised } = makeGuard({ episodeCorroborationCycles: 3, loadGateMaxLoadPerCore: 1.5 }, 1.5);
      guard.observeTmuxCall(12_000, 'success');
      guard.observeTmuxCall(12_000, 'success');
      guard.observeTmuxCall(12_000, 'success');
      expect(raised).toHaveLength(1);
    });
  });

  describe('machine-tagging in the payload (production raiseAttention contract)', () => {
    // The guard hands the dep a machine-AGNOSTIC episode (id/ageMs/ewmaMs/consecutiveSlowCycles);
    // the machine tag is applied by the raiseAttention dep, exactly as server.ts wires it:
    //   id          = `degraded-tmux:${machineId}:${ep.id}`
    //   healthKey   = `degraded-tmux:${machineId}`   (the dedup key — same machine ⇒ one item)
    //   sourceContext = `degraded-tmux:${machineId}`
    // This mirrors src/commands/server.ts:12383-12398 so the unit test pins the real contract.
    interface TaggedItem {
      id: string;
      healthKey: string;
      sourceContext: string;
      title: string;
      ewmaMs: number;
      consecutiveSlowCycles: number;
      ageMin: number;
    }

    function machineTaggingDep(machineId: string, nickname: string) {
      const items: TaggedItem[] = [];
      const raiseAttention = (ep: DegradedTmuxEpisode) => {
        items.push({
          id: `degraded-tmux:${machineId}:${ep.id}`,
          healthKey: `degraded-tmux:${machineId}`,
          sourceContext: `degraded-tmux:${machineId}`,
          title: `Slow terminal server on "${nickname}"`,
          ewmaMs: ep.ewmaMs,
          consecutiveSlowCycles: ep.consecutiveSlowCycles,
          ageMin: Math.round(ep.ageMs / 60_000),
        });
      };
      return { items, raiseAttention };
    }

    it('the raised payload is namespaced + deduped by the machine id', () => {
      const clock = makeClock();
      const { items, raiseAttention } = machineTaggingDep('mini-7', 'the mini');
      const guard = new DegradedTmuxGuard(
        { enabled: true, episodeCorroborationCycles: 3, slowCallThresholdMs: 9000 },
        { raiseAttention, loadPerCore: () => 0, now: clock.now },
      );
      guard.observeTmuxCall(12_000, 'success');
      guard.observeTmuxCall(12_000, 'success');
      guard.observeTmuxCall(12_000, 'success'); // open + raise
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe('degraded-tmux:mini-7:ep1');
      expect(items[0].healthKey).toBe('degraded-tmux:mini-7'); // the dedup key — machine-keyed
      expect(items[0].sourceContext).toBe('degraded-tmux:mini-7');
      expect(items[0].title).toBe('Slow terminal server on "the mini"');
    });

    it('age-escalation keeps the SAME machine-keyed healthKey (ONE deduped item, not a new topic)', () => {
      const clock = makeClock();
      const { items, raiseAttention } = machineTaggingDep('mini-7', 'the mini');
      const guard = new DegradedTmuxGuard(
        { enabled: true, episodeCorroborationCycles: 3, slowCallThresholdMs: 9000, episodeEscalateIntervalMs: 30 * 60_000 },
        { raiseAttention, loadPerCore: () => 0, now: clock.now },
      );
      guard.observeTmuxCall(12_000, 'success');
      guard.observeTmuxCall(12_000, 'success');
      guard.observeTmuxCall(12_000, 'success'); // raise #1
      clock.advance(31 * 60_000);
      guard.observeTmuxCall(12_000, 'success'); // age-escalation raise #2
      expect(items).toHaveLength(2);
      // The healthKey is IDENTICAL across both raises ⇒ Telegram coalesces into one item.
      expect(items[0].healthKey).toBe(items[1].healthKey);
      expect(items[0].sourceContext).toBe(items[1].sourceContext);
      // ...and the escalated raise carries a larger age + same episode counter id.
      expect(items[1].id).toBe(items[0].id);
      expect(items[1].ageMin).toBeGreaterThan(items[0].ageMin);
      expect(items[1].ewmaMs).toBeGreaterThanOrEqual(9000);
      expect(items[1].consecutiveSlowCycles).toBeGreaterThan(items[0].consecutiveSlowCycles);
    });

    it('a different machine produces a DISTINCT healthKey (no cross-machine collision)', () => {
      const clockA = makeClock();
      const clockB = makeClock();
      const a = machineTaggingDep('mini-7', 'the mini');
      const b = machineTaggingDep('studio-1', 'the studio');
      const guardA = new DegradedTmuxGuard(
        { enabled: true, episodeCorroborationCycles: 3 },
        { raiseAttention: a.raiseAttention, loadPerCore: () => 0, now: clockA.now },
      );
      const guardB = new DegradedTmuxGuard(
        { enabled: true, episodeCorroborationCycles: 3 },
        { raiseAttention: b.raiseAttention, loadPerCore: () => 0, now: clockB.now },
      );
      for (let i = 0; i < 3; i++) guardA.observeTmuxCall(12_000, 'success');
      for (let i = 0; i < 3; i++) guardB.observeTmuxCall(12_000, 'success');
      expect(a.items).toHaveLength(1);
      expect(b.items).toHaveLength(1);
      expect(a.items[0].healthKey).not.toBe(b.items[0].healthKey);
      expect(a.items[0].id).not.toBe(b.items[0].id);
    });

    it("emits an 'episode' event carrying the same machine-agnostic episode handed to raiseAttention", () => {
      const { guard, raised } = makeGuard({ episodeCorroborationCycles: 3 });
      const emitted: DegradedTmuxEpisode[] = [];
      guard.on('episode', (ep: DegradedTmuxEpisode) => emitted.push(ep));
      guard.observeTmuxCall(12_000, 'success');
      guard.observeTmuxCall(12_000, 'success');
      guard.observeTmuxCall(12_000, 'success');
      expect(emitted).toHaveLength(1);
      expect(raised).toHaveLength(1);
      // The event and the raiseAttention payload describe the SAME episode (id/ewma/cycles).
      expect(emitted[0].id).toBe(raised[0].id);
      expect(emitted[0].ewmaMs).toBe(raised[0].ewmaMs);
      expect(emitted[0].consecutiveSlowCycles).toBe(raised[0].consecutiveSlowCycles);
    });
  });
});
