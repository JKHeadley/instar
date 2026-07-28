/**
 * GAP-B commitment-evidence backstop — the pure qualifying + agreement predicate.
 *
 * Spec: docs/specs/autonomous-registration-guarantee.md (Part B + D1/D2/D7/D8).
 *
 * Covers BOTH sides of every decision boundary, against a REAL CommitmentTracker
 * (no stubs for the data source — wiring-integrity standard):
 *  - getActiveByTopicId topic filter
 *  - D1 freshness boundary (fresh ⇒ qualifies; stale ⇒ does NOT)
 *  - D2 qualifying set (status, owner/blockedOn, beacon-paused/suppressed, origin)
 *  - D8 agreement gate (no recent user message ⇒ NOT eligible even with a fresh commitment)
 *  - the ANTI-LOOP regression (stale-per-KEEP commitment ⇒ NOT eligible — KEEP/eligibility agree)
 *  - D7 fail-open (a throwing source/predicate ⇒ NOT eligible, never a spurious revive)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CommitmentTracker } from '../../src/monitoring/CommitmentTracker.js';
import type { Commitment } from '../../src/monitoring/CommitmentTracker.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  gapBEligibleForTopic,
  commitmentQualifies,
  resolveGapBInjectionGate,
  decideGapBInjection,
  type GapBQualifyDeps,
} from '../../src/core/gapBCommitmentEvidence.js';

const TOPIC = 4242;
const FRESH_WINDOW = 6 * 60 * 60_000; // 6h (D1)
const STALE_WINDOW = 8 * 60 * 60_000; // 8h (D8)
const OWN_MACHINE = 'machine-A';

function mkTracker(originMachineId?: string): { tracker: CommitmentTracker; cleanup: () => void } {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gapb-test-'));
  fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ updates: { autoApply: true } }));
  const tracker = new CommitmentTracker({
    stateDir,
    liveConfig: new LiveConfig(stateDir),
    ...(originMachineId ? { originMachineId } : {}),
  });
  return {
    tracker,
    cleanup: () => SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/gapB-commitment-evidence.test.ts' }),
  };
}

/** Force a commitment's createdAt to a precise age (the only D1 anchor). */
function setCreatedAtAgeMs(tracker: CommitmentTracker, id: string, ageMs: number): void {
  // Reach into the store via the public getAll() and mutate in place — the
  // tracker serves the same object reference back from get().
  const c = tracker.getAll().find((x) => x.id === id)!;
  (c as Commitment).createdAt = new Date(Date.now() - ageMs).toISOString();
}

/** Standard deps with a recent-user-message that ALWAYS says "recent" (so D8 passes). */
function recentDeps(over?: Partial<GapBQualifyDeps>): GapBQualifyDeps {
  return {
    ownMachineId: OWN_MACHINE,
    freshCommitmentWindowMs: FRESH_WINDOW,
    staleCommitmentWindowMs: STALE_WINDOW,
    recentUserMessage: () => true,
    ...over,
  };
}

describe('GAP-B: getActiveByTopicId topic filter', () => {
  let h: ReturnType<typeof mkTracker>;
  beforeEach(() => { h = mkTracker(OWN_MACHINE); });
  afterEach(() => h.cleanup());

  it('returns only active commitments for the requested topic', () => {
    h.tracker.record({ userRequest: 'r', agentResponse: 'a', type: 'one-time-action', topicId: TOPIC });
    h.tracker.record({ userRequest: 'r', agentResponse: 'a', type: 'one-time-action', topicId: 9999 });
    const got = h.tracker.getActiveByTopicId(TOPIC);
    expect(got).toHaveLength(1);
    expect(got[0].topicId).toBe(TOPIC);
  });

  it('excludes a withdrawn (terminal) commitment', () => {
    const c = h.tracker.record({ userRequest: 'r', agentResponse: 'a', type: 'one-time-action', topicId: TOPIC });
    h.tracker.withdraw(c.id, 'changed mind');
    expect(h.tracker.getActiveByTopicId(TOPIC)).toHaveLength(0);
  });
});

describe('GAP-B D1 — freshness boundary (createdAt only)', () => {
  let h: ReturnType<typeof mkTracker>;
  beforeEach(() => { h = mkTracker(OWN_MACHINE); });
  afterEach(() => h.cleanup());

  it('FRESH (createdAt < 6h) qualifies', () => {
    const c = h.tracker.record({ userRequest: 'r', agentResponse: 'a', type: 'one-time-action', topicId: TOPIC });
    setCreatedAtAgeMs(h.tracker, c.id, 1 * 60 * 60_000); // 1h old
    expect(gapBEligibleForTopic(TOPIC, h.tracker, recentDeps())).toBe(true);
  });

  it('STALE (createdAt > 6h) does NOT qualify — even with everything else live', () => {
    const c = h.tracker.record({ userRequest: 'r', agentResponse: 'a', type: 'one-time-action', topicId: TOPIC });
    setCreatedAtAgeMs(h.tracker, c.id, 7 * 60 * 60_000); // 7h old
    expect(gapBEligibleForTopic(TOPIC, h.tracker, recentDeps())).toBe(false);
  });

  it('a recent beacon heartbeat does NOT refresh freshness (createdAt is the sole anchor)', () => {
    const c = h.tracker.record({ userRequest: 'r', agentResponse: 'a', type: 'one-time-action', topicId: TOPIC });
    setCreatedAtAgeMs(h.tracker, c.id, 9 * 60 * 60_000); // 9h-old promise
    // Simulate a beacon ping 5 min ago — must NOT make it "fresh".
    const live = h.tracker.getAll().find((x) => x.id === c.id)!;
    live.lastHeartbeatAt = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(gapBEligibleForTopic(TOPIC, h.tracker, recentDeps())).toBe(false);
  });
});

describe('GAP-B D2 — qualifying set (both sides)', () => {
  const base = { freshCommitmentWindowMs: FRESH_WINDOW, ownMachineId: OWN_MACHINE };

  const mk = (over: Partial<Commitment>): Commitment => ({
    id: 'CMT-001', userRequest: 'r', agentResponse: 'a', type: 'one-time-action',
    status: 'pending', createdAt: new Date(Date.now() - 60_000).toISOString(),
    verificationCount: 0, violationCount: 0, correctionCount: 0, correctionHistory: [],
    escalated: false, version: 0, topicId: TOPIC, owner: 'agent', blockedOn: 'none',
    originMachineId: OWN_MACHINE,
    ...over,
  });

  it('pending + agent-driven + local-origin + fresh ⇒ qualifies', () => {
    expect(commitmentQualifies(mk({}), base)).toBe(true);
  });

  it('status verified ⇒ does NOT qualify (not a working session)', () => {
    expect(commitmentQualifies(mk({ status: 'verified' }), base)).toBe(false);
  });

  it('status violated ⇒ does NOT qualify (a FAILING session)', () => {
    expect(commitmentQualifies(mk({ status: 'violated' }), base)).toBe(false);
  });

  it('owner:user + blockedOn:user-input ⇒ does NOT qualify (waiting on user)', () => {
    expect(commitmentQualifies(mk({ owner: 'user', blockedOn: 'user-input' }), base)).toBe(false);
  });

  it('owner:user + blockedOn:user-authorization ⇒ does NOT qualify', () => {
    expect(commitmentQualifies(mk({ owner: 'user', blockedOn: 'user-authorization' }), base)).toBe(false);
  });

  it('owner:user + blockedOn:none ⇒ qualifies (agent-driven)', () => {
    expect(commitmentQualifies(mk({ owner: 'user', blockedOn: 'none' }), base)).toBe(true);
  });

  it('missing owner is treated as agent ⇒ qualifies', () => {
    expect(commitmentQualifies(mk({ owner: undefined, blockedOn: undefined }), base)).toBe(true);
  });

  it('beaconPaused ⇒ does NOT qualify', () => {
    expect(commitmentQualifies(mk({ beaconPaused: true }), base)).toBe(false);
  });

  it('beaconSuppressed ⇒ does NOT qualify', () => {
    expect(commitmentQualifies(mk({ beaconSuppressed: true }), base)).toBe(false);
  });

  it('replicated peer origin ⇒ does NOT qualify (advisory, not authority)', () => {
    expect(commitmentQualifies(mk({ originMachineId: 'machine-B' }), base)).toBe(false);
  });

  it('absent origin ⇒ qualifies (legacy-local)', () => {
    expect(commitmentQualifies(mk({ originMachineId: undefined }), base)).toBe(true);
  });
});

describe('GAP-B D8 — KEEP/eligibility agreement gate (the anti-loop invariant)', () => {
  let h: ReturnType<typeof mkTracker>;
  beforeEach(() => { h = mkTracker(OWN_MACHINE); });
  afterEach(() => h.cleanup());

  it('a FRESH qualifying commitment BUT no recent user message ⇒ NOT eligible (no inject)', () => {
    const c = h.tracker.record({ userRequest: 'r', agentResponse: 'a', type: 'one-time-action', topicId: TOPIC });
    setCreatedAtAgeMs(h.tracker, c.id, 1 * 60 * 60_000);
    // D8 fails: no recent user message.
    const deps = recentDeps({ recentUserMessage: () => false });
    expect(gapBEligibleForTopic(TOPIC, h.tracker, deps)).toBe(false);
  });

  it('a FRESH qualifying commitment AND a recent user message ⇒ eligible', () => {
    const c = h.tracker.record({ userRequest: 'r', agentResponse: 'a', type: 'one-time-action', topicId: TOPIC });
    setCreatedAtAgeMs(h.tracker, c.id, 1 * 60 * 60_000);
    expect(gapBEligibleForTopic(TOPIC, h.tracker, recentDeps())).toBe(true);
  });

  it('ANTI-LOOP regression: a commitment the KEEP-guard would judge STALE (no user msg in window) does NOT inject — KEEP and eligibility agree', () => {
    // The 2026-06-13 loop: KEEP says "stale, reap" while eligibility says "fresh,
    // revive" → reap/revive forever. Here the commitment is recent by createdAt
    // (would otherwise inject) but the SHARED recentUserMessage predicate (the
    // exact one ReapGuard's KEEP uses) reports NO user message in the stale window
    // → the KEEP guard would let the session die. Eligibility must AGREE and NOT
    // revive it. The window argument the predicate receives must be the stale (8h)
    // window — the same one the KEEP-guard's commitment veto uses.
    const c = h.tracker.record({ userRequest: 'r', agentResponse: 'a', type: 'one-time-action', topicId: TOPIC });
    setCreatedAtAgeMs(h.tracker, c.id, 30 * 60_000); // 30min-old promise (fresh by D1)
    let windowSeen = -1;
    const deps = recentDeps({
      recentUserMessage: (_t, withinMs) => { windowSeen = withinMs; return false; }, // KEEP says stale
    });
    expect(gapBEligibleForTopic(TOPIC, h.tracker, deps)).toBe(false);
    expect(windowSeen).toBe(STALE_WINDOW); // proves it gated on the KEEP-guard's window
  });
});

describe('GAP-B D7 — fail-open', () => {
  it('a throwing source ⇒ NOT eligible (never a spurious revive)', () => {
    const throwing = { getActiveByTopicId: () => { throw new Error('boom'); } };
    expect(gapBEligibleForTopic(TOPIC, throwing, recentDeps())).toBe(false);
  });

  it('a throwing recentUserMessage predicate ⇒ NOT eligible', () => {
    let h = mkTracker(OWN_MACHINE);
    try {
      const c = h.tracker.record({ userRequest: 'r', agentResponse: 'a', type: 'one-time-action', topicId: TOPIC });
      setCreatedAtAgeMs(h.tracker, c.id, 60_000);
      const deps = recentDeps({ recentUserMessage: () => { throw new Error('boom'); } });
      expect(gapBEligibleForTopic(TOPIC, h.tracker, deps)).toBe(false);
    } finally { h.cleanup(); }
  });

  it('no qualifying commitment ⇒ NOT eligible (empty topic)', () => {
    let h = mkTracker(OWN_MACHINE);
    try {
      expect(gapBEligibleForTopic(TOPIC, h.tracker, recentDeps())).toBe(false);
    } finally { h.cleanup(); }
  });
});

describe('GAP-B D5 — dark-gate (resolveGapBInjectionGate)', () => {
  it('omitted config ⇒ DISARMED (off on fleet AND dev — the containment)', () => {
    expect(resolveGapBInjectionGate(undefined)).toEqual({ armed: false, dryRun: true });
  });
  it('enabled:false ⇒ DISARMED', () => {
    expect(resolveGapBInjectionGate({ enabled: false }).armed).toBe(false);
  });
  it('enabled:true ⇒ ARMED, dryRun defaults TRUE (dark soak first)', () => {
    expect(resolveGapBInjectionGate({ enabled: true })).toEqual({ armed: true, dryRun: true });
  });
  it('enabled:true + dryRun:false ⇒ ARMED + LIVE', () => {
    expect(resolveGapBInjectionGate({ enabled: true, dryRun: false })).toEqual({ armed: true, dryRun: false });
  });
});

describe('GAP-B Part B — decideGapBInjection (the dark-gate no-op + full pipeline)', () => {
  const ELIGIBLE = { reason: 'age-limit', stateFilePresent: false, eligible: true };

  it('DARK (disarmed) + eligible ⇒ strict no-op (no fire, no inject — the dryRun→no-spawn containment)', () => {
    const gate = resolveGapBInjectionGate(undefined); // omitted ⇒ disarmed
    expect(decideGapBInjection({ gate, ...ELIGIBLE })).toEqual({ fired: false, inject: false });
  });

  it('ARMED + dryRun + eligible ⇒ FIRES (Part A surface) but does NOT inject (no spawn)', () => {
    const gate = resolveGapBInjectionGate({ enabled: true }); // dryRun default true
    expect(decideGapBInjection({ gate, ...ELIGIBLE })).toEqual({ fired: true, inject: false });
  });

  it('ARMED + LIVE + eligible ⇒ FIRES and INJECTS', () => {
    const gate = resolveGapBInjectionGate({ enabled: true, dryRun: false });
    expect(decideGapBInjection({ gate, ...ELIGIBLE })).toEqual({ fired: true, inject: true });
  });

  it('ARMED + LIVE but NOT age-limit reason ⇒ no-op (pinned to the age-limit branch)', () => {
    const gate = resolveGapBInjectionGate({ enabled: true, dryRun: false });
    expect(decideGapBInjection({ gate, reason: 'quota-shed', stateFilePresent: false, eligible: true }))
      .toEqual({ fired: false, inject: false });
  });

  it('ARMED + LIVE but state file PRESENT ⇒ no-op (registered run handled upstream)', () => {
    const gate = resolveGapBInjectionGate({ enabled: true, dryRun: false });
    expect(decideGapBInjection({ gate, reason: 'age-limit', stateFilePresent: true, eligible: true }))
      .toEqual({ fired: false, inject: false });
  });

  it('ARMED + LIVE but NOT eligible ⇒ no-op', () => {
    const gate = resolveGapBInjectionGate({ enabled: true, dryRun: false });
    expect(decideGapBInjection({ gate, reason: 'age-limit', stateFilePresent: false, eligible: false }))
      .toEqual({ fired: false, inject: false });
  });
});
