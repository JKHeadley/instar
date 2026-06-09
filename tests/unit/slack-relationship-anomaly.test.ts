/**
 * Unit tests for the Pillar 3 relationship-aware anomaly second factor:
 *   - RelationshipBehaviorStore: a durable per-principal behavioral baseline built
 *     from recorded SHAPE (never content).
 *   - RelationshipAnomalyScorer: scores out-of-character requests against that baseline
 *     across five deterministic signals + an optional fail-closed LLM style check.
 *   - SlackPermissionGate composition: a HIGH anomaly on a would-be-allowed FLOOR
 *     action escalates to step-up (observe-only); anomaly never lowers a bar.
 *
 * Spec: docs/specs/SLACK-ORG-INTEGRATION-SPEC.md §7.1–7.4, §7.6.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  RelationshipBehaviorStore,
  StoreBaselineProvider,
  meanLength,
  stdLength,
  hourFraction,
  decayedView,
  baselineAgeMs,
  type BehaviorObservation,
} from '../../src/permissions/RelationshipBehaviorStore.js';
import { RelationshipAnomalyScorer } from '../../src/permissions/RelationshipAnomalyScorer.js';
import { SlackPermissionGate } from '../../src/permissions/SlackPermissionGate.js';
import { HeuristicIntentClassifier } from '../../src/permissions/IntentClassifier.js';
import { SlackPermissionObserver } from '../../src/permissions/SlackPermissionObserver.js';
import { SlackPrincipalResolver, type UserLookup } from '../../src/permissions/SlackPrincipalResolver.js';
import { PermissionDecisionLedger } from '../../src/permissions/PermissionDecisionLedger.js';
import type { Principal, RequestIntent, IntelligenceProvider } from '../../src/permissions/index.js';

const OLIVIA: Principal = { userId: 'u-olivia', name: 'Olivia', slackUserId: 'U_OLIVIA', role: 'owner', registered: true };

const intent = (action: string, tier: 0 | 1 | 2 | 3 | 4, floor?: RequestIntent['floorAction']): RequestIntent => ({
  action,
  tier,
  floorAction: floor,
  confidence: 0.9,
  directed: true,
});

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-anomaly-'));
});
afterEach(() => {
  SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/slack-relationship-anomaly.test.ts' });
});

/**
 * The reference "now" the scorers in this file are pinned to. Seeded baselines must
 * accrue calendar AGE relative to this instant to count as "established" once the
 * minimum-baseline-age hardening (#3a) is in force.
 */
const SCORE_NOW = new Date(2026, 5, 9, 10, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A store whose clock is parked `daysAgo` before SCORE_NOW, so that records it writes
 * carry a `firstSeen` old enough to be "established" by age. Mirrors how a REAL baseline
 * forms over weeks of traffic — the existing fixtures used real-now, which is only an
 * artifact of an instant-seed test. (Backward-compat for the merged tests: the assertions
 * are unchanged; only the seed's calendar age is made realistic.)
 */
function agedStore(tmp: string, daysAgo = 30, opts?: ConstructorParameters<typeof RelationshipBehaviorStore>[2]): RelationshipBehaviorStore {
  const at = new Date(SCORE_NOW.getTime() - daysAgo * DAY_MS).toISOString();
  return new RelationshipBehaviorStore(tmp, () => at, opts);
}

/**
 * Record `count` observations for a principal at `daysAgo` before SCORE_NOW, capped at
 * the store's per-window limit so a single day never trips the rate cap (#3b). Used to
 * spread a baseline across calendar days the way real traffic accrues — giving both the
 * age (#3a) and a decay-relevant history (#2) without dropping seeded observations.
 */
function recordAt(tmp: string, slackUserId: string, daysAgo: number, count: number, obs: BehaviorObservation): void {
  const at = new Date(SCORE_NOW.getTime() - daysAgo * DAY_MS).toISOString();
  const s = new RelationshipBehaviorStore(tmp, () => at);
  for (let i = 0; i < count; i++) s.record(slackUserId, obs);
}

/**
 * Build an established owner baseline spread over ~50 calendar days (≤1/day) so it is
 * established by AGE and COUNT and is decay-stable: 30 morning reads + 20 deploys.
 */
function seedEstablishedOwner(tmp: string): void {
  // 30 reads across days 50..21, 20 deploys across days 20..1 — all ≤1/day (under the cap).
  for (let i = 0; i < 30; i++) {
    recordAt(tmp, 'U_OLIVIA', 50 - i, 1, { action: 'read', tier: 1, hour: 10, length: 30, urgent: false });
  }
  for (let i = 0; i < 20; i++) {
    recordAt(tmp, 'U_OLIVIA', 20 - i, 1, { action: 'prod-deploy', tier: 4, hour: 11, length: 35, urgent: false });
  }
}

describe('RelationshipBehaviorStore', () => {
  it('records SHAPE only and aggregates a baseline that survives a reload', () => {
    seedEstablishedOwner(tmp);

    // Fresh instance reads from disk — durable.
    const reloaded = new RelationshipBehaviorStore(tmp);
    const prof = reloaded.profileFor('U_OLIVIA')!;
    expect(prof.interactionCount).toBe(50);
    expect(prof.actionCounts.read).toBe(30);
    expect(prof.actionCounts['prod-deploy']).toBe(20);
    expect(prof.tierCounts[1]).toBe(30);
    expect(prof.tierCounts[4]).toBe(20);
    expect(prof.hourCounts[10]).toBe(30);
    expect(meanLength(prof)).toBeCloseTo(32, 0);
    expect(stdLength(prof)).toBeGreaterThanOrEqual(0);
    expect(hourFraction(prof, 10)).toBeCloseTo(0.6, 1);
    expect(hourFraction(prof, 3)).toBe(0); // never operates at 03:00
  });

  it('never persists message text (privacy — SHAPE only)', () => {
    const store = new RelationshipBehaviorStore(tmp);
    store.record('U_OLIVIA', { action: 'read', tier: 1, hour: 10, length: 12, urgent: false });
    const raw = fs.readFileSync(store.path, 'utf8');
    // The persisted file is counts + lengths; it must contain no free-text message body.
    expect(raw).toContain('actionCounts');
    expect(raw).not.toMatch(/wire|deploy the hotfix|message text/i);
  });

  it('rejects an unsafe slackUserId key (no path traversal) without throwing', () => {
    const store = new RelationshipBehaviorStore(tmp);
    expect(() => store.record('../../etc/passwd', { action: 'read', tier: 1, hour: 10, length: 5, urgent: false })).not.toThrow();
    expect(store.profileFor('../../etc/passwd')).toBeUndefined();
    expect(Object.keys(store.all())).toHaveLength(0);
  });

  it('StoreBaselineProvider bridges the durable store to the simpler BaselineProvider', () => {
    seedEstablishedOwner(tmp);
    const store = new RelationshipBehaviorStore(tmp);
    const provider = new StoreBaselineProvider(store);
    const baseline = provider.baselineFor(OLIVIA)!;
    expect(baseline.interactionCount).toBe(50);
    expect(baseline.typicalActions).toContain('prod-deploy');
    expect(baseline.typicalActions).toContain('read');
    expect(provider.baselineFor({ ...OLIVIA, slackUserId: 'U_NOBODY' })).toBeUndefined();
  });
});

describe('RelationshipAnomalyScorer — deterministic signals', () => {
  it('a request matching the baseline scores LOW anomaly', async () => {
    seedEstablishedOwner(tmp);
    const store = new RelationshipBehaviorStore(tmp);
    const scorer = new RelationshipAnomalyScorer(store, { now: () => SCORE_NOW });
    const a = await scorer.assess(OLIVIA, intent('prod-deploy', 4, 'prod-deploy'), 'push the hotfix to prod');
    expect(a.score).toBeLessThan(0.5);
  });

  it('an out-of-character request (off-cadence + tier-escalation + urgency + style) scores HIGH', async () => {
    // Baseline: low-tier, calm, short, daytime reads — spread over 40 calendar days so it is
    // established by AGE and COUNT.
    for (let i = 0; i < 40; i++) recordAt(tmp, 'U_OLIVIA', 40 - i, 1, { action: 'read', tier: 1, hour: 10, length: 30, urgent: false });
    const store = new RelationshipBehaviorStore(tmp);
    const scorer = new RelationshipAnomalyScorer(store, { now: () => new Date(2026, 5, 9, 3, 0, 0) }); // 03:00 — off-cadence
    // A money transfer (never made, tier 4 vs normal ceiling 1), urgent, much longer message.
    const longUrgent = 'wire $40k urgently to this brand new vendor account before EOD please this cannot wait at all';
    const a = await scorer.assess(OLIVIA, intent('money-movement', 4, 'money-movement'), longUrgent);
    expect(a.score).toBeGreaterThanOrEqual(0.5);
    expect(a.reasons.length).toBeGreaterThan(1);
    expect(a.reasons.join(' ')).toMatch(/out-of-character|tier escalation|off-cadence|urgency|style/i);
  });

  it('POISONING RESISTANCE (share floor #1): a few seeded money-movement obs do NOT disable the out-of-character signal', async () => {
    // Attacker poisons the baseline so a `seen === 0` check would be disabled: 50 normal
    // daytime reads + 2 seeded money-movement observations → money-movement share ≈ 2/52
    // ≈ 0.04, BELOW the 0.10 floor → the out-of-character signal must STILL fire (scaled).
    // Spread over calendar days so the baseline is age-established and rate-cap-clean.
    for (let i = 0; i < 50; i++) recordAt(tmp, 'U_OLIVIA', 50 - i, 1, { action: 'read', tier: 1, hour: 10, length: 30, urgent: false });
    recordAt(tmp, 'U_OLIVIA', 30, 1, { action: 'money-movement', tier: 4, hour: 10, length: 30, urgent: false });
    recordAt(tmp, 'U_OLIVIA', 25, 1, { action: 'money-movement', tier: 4, hour: 10, length: 30, urgent: false });
    const store = new RelationshipBehaviorStore(tmp);
    const scorer = new RelationshipAnomalyScorer(store, { now: () => new Date(2026, 5, 9, 3, 0, 0) }); // 03:00 off-cadence
    const longUrgent = 'URGENT: wire $50k to a brand new vendor account right now, this absolutely cannot wait until morning';
    const a = await scorer.assess(OLIVIA, intent('money-movement', 4, 'money-movement'), longUrgent);
    // The rare-action signal still contributes despite the seeded observations…
    expect(a.reasons.join(' ')).toMatch(/out-of-character|rare/i);
    // …and the poisoned request still clears the default step-up threshold (pre-fix it scored ~0.45 < 0.5).
    expect(a.score).toBeGreaterThanOrEqual(0.5);
  });

  it('a new principal (no baseline) → LOW anomaly, NO step-up fabrication, no reasons', async () => {
    const store = new RelationshipBehaviorStore(tmp);
    const scorer = new RelationshipAnomalyScorer(store);
    const a = await scorer.assess(
      { ...OLIVIA, slackUserId: 'U_BRAND_NEW' },
      intent('money-movement', 4, 'money-movement'),
      'wire $40k urgently right now',
    );
    expect(a.score).toBe(0);
    expect(a.reasons).toEqual([]);
  });

  it('a thin baseline (below establishedMin) suppresses action/style signals (low confidence)', async () => {
    const store = new RelationshipBehaviorStore(tmp);
    // Only 2 interactions — not established.
    store.record('U_OLIVIA', { action: 'read', tier: 1, hour: 10, length: 30, urgent: false });
    store.record('U_OLIVIA', { action: 'read', tier: 1, hour: 10, length: 30, urgent: false });
    const scorer = new RelationshipAnomalyScorer(store, { now: () => new Date(2026, 5, 9, 10, 0, 0) });
    const det = scorer.deterministicScore(store.profileFor('U_OLIVIA'), intent('money-movement', 4, 'money-movement'), 'wire $40k');
    expect(det.confidence).toBe('low');
    // Out-of-character action / tier-escalation / style are suppressed under a thin baseline.
    expect(det.reasons.join(' ')).not.toMatch(/out-of-character|tier escalation|style deviation/i);
  });

  it('confidence scales with baseline depth', () => {
    seedEstablishedOwner(tmp); // 50 interactions over ~50 calendar days
    const store = new RelationshipBehaviorStore(tmp);
    const scorer = new RelationshipAnomalyScorer(store, { now: () => SCORE_NOW });
    const det = scorer.deterministicScore(store.profileFor('U_OLIVIA'), intent('read', 1), 'morning summary');
    expect(det.confidence).toBe('high'); // 50 >= establishedMin(5)*4 AND age >= 7d
  });
});

describe('RelationshipAnomalyScorer — optional LLM style check (fail-closed)', () => {
  function provider(verdict: string | (() => never)): IntelligenceProvider {
    return {
      async evaluate() {
        if (typeof verdict === 'function') return verdict();
        return verdict;
      },
    };
  }

  it('an LLM MISMATCH ADDS to the score (raises the bar)', async () => {
    seedEstablishedOwner(tmp);
    const store = new RelationshipBehaviorStore(tmp);
    const scorer = new RelationshipAnomalyScorer(store, {
      now: () => SCORE_NOW,
      useLlmStyleCheck: true,
      intelligence: provider('MISMATCH'),
    });
    // In-character deploy (deterministic ~0) — only the LLM adds.
    const a = await scorer.assess(OLIVIA, intent('prod-deploy', 4, 'prod-deploy'), 'push the hotfix to prod');
    expect(a.score).toBeGreaterThan(0);
    expect(a.reasons.join(' ')).toMatch(/LLM style check/i);
  });

  it('an LLM failure FAILS CLOSED — it never widens (no contribution)', async () => {
    seedEstablishedOwner(tmp);
    const store = new RelationshipBehaviorStore(tmp);
    const throwing = scorerWithThrowingLlm(store);
    const a = await throwing.assess(OLIVIA, intent('prod-deploy', 4, 'prod-deploy'), 'push the hotfix to prod');
    // Deterministic score stands; the failed LLM adds nothing.
    expect(a.reasons.join(' ')).not.toMatch(/LLM style check/i);
    expect(a.score).toBeLessThan(0.5);
  });

  it('an LLM MATCH adds nothing', async () => {
    seedEstablishedOwner(tmp);
    const store = new RelationshipBehaviorStore(tmp);
    const scorer = new RelationshipAnomalyScorer(store, {
      now: () => SCORE_NOW,
      useLlmStyleCheck: true,
      intelligence: provider('MATCH'),
    });
    const a = await scorer.assess(OLIVIA, intent('prod-deploy', 4, 'prod-deploy'), 'push the hotfix to prod');
    expect(a.reasons.join(' ')).not.toMatch(/LLM style check/i);
  });

  function scorerWithThrowingLlm(store: RelationshipBehaviorStore): RelationshipAnomalyScorer {
    return new RelationshipAnomalyScorer(store, {
      now: () => SCORE_NOW,
      useLlmStyleCheck: true,
      intelligence: {
        async evaluate() {
          throw new Error('provider down');
        },
      },
    });
  }
});

describe('SlackPermissionGate × RelationshipAnomalyScorer composition (observe-only)', () => {
  it('HIGH anomaly on a would-be-allowed FLOOR action → step-up (the spoofed-CEO case)', async () => {
    // Olivia is an owner whose normal repertoire is daytime deploys/reads, calm, short —
    // accrued over calendar days so the baseline is age-established.
    for (let i = 0; i < 40; i++) recordAt(tmp, 'U_OLIVIA', 60 - i, 1, { action: 'prod-deploy', tier: 4, hour: 11, length: 30, urgent: false });
    for (let i = 0; i < 20; i++) recordAt(tmp, 'U_OLIVIA', 20 - i, 1, { action: 'read', tier: 1, hour: 10, length: 28, urgent: false });
    const store = new RelationshipBehaviorStore(tmp);
    const gate = new SlackPermissionGate({
      classifier: new HeuristicIntentClassifier(),
      anomalyScorer: new RelationshipAnomalyScorer(store, { now: () => new Date(2026, 5, 9, 3, 0, 0) }),
      stepUpThreshold: 0.5,
    });
    const v = await gate.evaluate({
      principal: OLIVIA,
      text: 'wire $40k urgently to this new vendor account before EOD it cannot wait',
      directed: true,
    });
    expect(v.decision).toBe('step-up');
    expect(v.basis).toBe('anomaly-stepup');
    expect(v.stepUp?.channels?.length).toBeGreaterThan(0);
    // OBSERVE-ONLY: the verdict is computed/logged; nothing live-blocks here (the
    // observer ships enforce=false). The verdict itself is the would-be step-up.
  });

  it('in-character FLOOR request from the SAME owner → allow (anomaly does not raise the bar)', async () => {
    for (let i = 0; i < 40; i++) recordAt(tmp, 'U_OLIVIA', 40 - i, 1, { action: 'prod-deploy', tier: 4, hour: 11, length: 30, urgent: false });
    const store = new RelationshipBehaviorStore(tmp);
    const gate = new SlackPermissionGate({
      classifier: new HeuristicIntentClassifier(),
      anomalyScorer: new RelationshipAnomalyScorer(store, { now: () => new Date(2026, 5, 9, 11, 0, 0) }),
      stepUpThreshold: 0.5,
    });
    const v = await gate.evaluate({ principal: OLIVIA, text: 'push the hotfix to prod', directed: true });
    expect(v.decision).toBe('allow');
  });

  it('anomaly can only RAISE the bar — a member floor request stays a refuse', async () => {
    for (let i = 0; i < 40; i++) recordAt(tmp, 'U_MAYA', 40 - i, 1, { action: 'read', tier: 1, hour: 10, length: 30, urgent: false });
    const store = new RelationshipBehaviorStore(tmp);
    const gate = new SlackPermissionGate({
      classifier: new HeuristicIntentClassifier(),
      anomalyScorer: new RelationshipAnomalyScorer(store, { now: () => new Date(2026, 5, 9, 3, 0, 0) }),
      stepUpThreshold: 0.5,
    });
    const v = await gate.evaluate({
      principal: { userId: 'u-maya', name: 'Maya', slackUserId: 'U_MAYA', role: 'member', registered: true },
      text: 'wire $40k urgently right now',
      directed: true,
    });
    // Member can't authorize a floor action; a high anomaly never turns a refuse into step-up.
    expect(v.decision).toBe('refuse');
    expect(v.basis).toBe('floor-no-grant');
  });

  it('a NEW owner with no baseline making a floor request → allow, NOT a spurious step-up', async () => {
    const store = new RelationshipBehaviorStore(tmp);
    const gate = new SlackPermissionGate({
      classifier: new HeuristicIntentClassifier(),
      anomalyScorer: new RelationshipAnomalyScorer(store, { now: () => new Date(2026, 5, 9, 3, 0, 0) }),
      stepUpThreshold: 0.5,
    });
    const v = await gate.evaluate({ principal: OLIVIA, text: 'push the hotfix to prod', directed: true });
    expect(v.decision).toBe('allow'); // no character yet → no out-of-character → no fabricated step-up
  });
});

describe('SlackPermissionObserver feeds the behavioral baseline (observe-only)', () => {
  const lookup: UserLookup = {
    resolveFromSlackUserId: (id) =>
      id === 'U_OLIVIA' ? { id: 'u-olivia', name: 'Olivia', permissions: ['owner'] } : null,
  };

  it('records SHAPE for a DIRECTED request and grows the durable baseline', async () => {
    const store = new RelationshipBehaviorStore(tmp);
    const observer = new SlackPermissionObserver({
      resolver: new SlackPrincipalResolver(lookup),
      gate: new SlackPermissionGate({ classifier: new HeuristicIntentClassifier() }),
      ledger: new PermissionDecisionLedger(tmp),
      behaviorStore: store,
      now: () => new Date(2026, 5, 9, 9, 0, 0),
    });
    await observer.observe({ slackUserId: 'U_OLIVIA', text: 'summarize the incident', directed: true, channel: 'C1' });
    const prof = store.profileFor('U_OLIVIA')!;
    expect(prof.interactionCount).toBe(1);
    expect(prof.actionCounts.read).toBe(1);
    expect(prof.hourCounts[9]).toBe(1);
  });

  it('does NOT record an UNDIRECTED (overheard) message — that is not "this person\'s behavior"', async () => {
    const store = new RelationshipBehaviorStore(tmp);
    const observer = new SlackPermissionObserver({
      resolver: new SlackPrincipalResolver(lookup),
      gate: new SlackPermissionGate({ classifier: new HeuristicIntentClassifier() }),
      ledger: new PermissionDecisionLedger(tmp),
      behaviorStore: store,
    });
    await observer.observe({ slackUserId: 'U_OLIVIA', text: 'we should deploy to prod tbh', directed: false, channel: 'C1' });
    expect(store.profileFor('U_OLIVIA')).toBeUndefined();
  });

  it('with NO behaviorStore wired (dark default) the observer records nothing and still returns a verdict', async () => {
    const observer = new SlackPermissionObserver({
      resolver: new SlackPrincipalResolver(lookup),
      gate: new SlackPermissionGate({ classifier: new HeuristicIntentClassifier() }),
      ledger: new PermissionDecisionLedger(tmp),
      // no behaviorStore
    });
    const v = await observer.observe({ slackUserId: 'U_OLIVIA', text: 'summarize the incident', directed: true });
    expect(v).not.toBeNull();
    // No baseline file should have been created by the relationship store.
    expect(fs.existsSync(path.join(tmp, 'slack-relationship-baselines.json'))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────
// Phase-3 follow-ups #2/#3: deeper baseline-poisoning resistance.
// The attack: a patient attacker / slowly-compromised account injects many normal-
// looking observations (and/or a burst) to reshape the baseline so a later out-of-
// character request scores LOW. Three additive, observe-only hardenings defeat it:
//   #2  recency/decay weighting    — a recent burst can't durably dominate the histogram
//   #3a minimum-baseline-AGE       — a burst can't rapidly manufacture an "established" baseline
//   #3b per-principal rate cap     — one session can't hammer the histogram to shift it
// Each test below would FAIL against the pre-hardening code (noted inline).
// ─────────────────────────────────────────────────────────────────────────────────

describe('Poisoning resistance #3b — per-principal observation-rate cap', () => {
  it('a burst of N observations in one window records only the cap; the histogram is not shifted past it', () => {
    const dropped: number[] = [];
    const at = new Date(2026, 5, 9, 12, 0, 0).toISOString();
    const store = new RelationshipBehaviorStore(tmp, () => at, {
      maxObservationsPerWindow: 10,
      bucketMs: DAY_MS,
      onCapDrop: (_uid, _ws, n) => dropped.push(n),
    });
    // Attacker hammers 100 money-movement observations into a single day window.
    for (let i = 0; i < 100; i++) {
      store.record('U_ATTACK', { action: 'money-movement', tier: 4, hour: 12, length: 30, urgent: false });
    }
    const prof = store.profileFor('U_ATTACK')!;
    // PRE-HARDENING: interactionCount would be 100 (no cap). With the cap it is exactly 10.
    expect(prof.interactionCount).toBe(10);
    expect(prof.actionCounts['money-movement']).toBe(10);
    // 90 observations were dropped + logged (not recorded).
    expect(dropped.length).toBe(90);
    // The bucketed history mirrors the cumulative totals (buckets-sum invariant holds).
    const bucketCount = (prof.buckets ?? []).reduce((s, b) => s + b.count, 0);
    expect(bucketCount).toBe(10);
  });

  it('the cap is PER-WINDOW: a fresh window admits another capped batch (sustained traffic is not starved)', () => {
    const day1 = new Date(2026, 4, 1, 12, 0, 0).toISOString();
    const day2 = new Date(2026, 4, 2, 12, 0, 0).toISOString();
    const s1 = new RelationshipBehaviorStore(tmp, () => day1, { maxObservationsPerWindow: 5, bucketMs: DAY_MS });
    for (let i = 0; i < 20; i++) s1.record('U_X', { action: 'read', tier: 1, hour: 12, length: 20, urgent: false });
    const s2 = new RelationshipBehaviorStore(tmp, () => day2, { maxObservationsPerWindow: 5, bucketMs: DAY_MS });
    for (let i = 0; i < 20; i++) s2.record('U_X', { action: 'read', tier: 1, hour: 12, length: 20, urgent: false });
    // 5 admitted in each of the two windows = 10 total (not 40, not 5).
    expect(s2.profileFor('U_X')!.interactionCount).toBe(10);
  });

  it('a non-positive cap disables the rate cap (records everything — opt-out)', () => {
    const at = new Date(2026, 5, 9, 12, 0, 0).toISOString();
    const store = new RelationshipBehaviorStore(tmp, () => at, { maxObservationsPerWindow: 0, bucketMs: DAY_MS });
    for (let i = 0; i < 80; i++) store.record('U_X', { action: 'read', tier: 1, hour: 12, length: 20, urgent: false });
    expect(store.profileFor('U_X')!.interactionCount).toBe(80);
  });
});

describe('Poisoning resistance #3a — minimum baseline AGE for "established"', () => {
  it('a high-COUNT but YOUNG baseline (rapid burst, recent firstSeen) is NOT established → action/tier/style signals suppressed', async () => {
    // Attacker rapidly accrues a deep-LOOKING baseline of reads TODAY (firstSeen ≈ now),
    // spread across days to dodge the rate cap but all within the last ~3 days, then tries
    // a money-movement. Count is high (well over establishedMin) but the baseline is YOUNG.
    const now = new Date(2026, 5, 9, 3, 0, 0);
    for (let d = 0; d < 3; d++) {
      const at = new Date(now.getTime() - d * DAY_MS).toISOString();
      const s = new RelationshipBehaviorStore(tmp, () => at, { bucketMs: DAY_MS });
      for (let i = 0; i < 15; i++) s.record('U_YOUNG', { action: 'read', tier: 1, hour: 10, length: 30, urgent: false });
    }
    const store = new RelationshipBehaviorStore(tmp);
    const prof = store.profileFor('U_YOUNG')!;
    expect(prof.interactionCount).toBe(45); // count is plenty (>> establishedMin 5)
    expect(baselineAgeMs(prof, now.getTime())).toBeLessThan(7 * DAY_MS); // but YOUNG (<7d)

    const principal: Principal = { ...OLIVIA, slackUserId: 'U_YOUNG' };
    const scorer = new RelationshipAnomalyScorer(store, { now: () => now, minBaselineAgeDays: 7, bucketMs: DAY_MS });
    const det = scorer.deterministicScore(prof, intent('money-movement', 4, 'money-movement'), 'wire $40k right now urgently');
    // PRE-HARDENING (count-only "established"): out-of-character + tier-escalation would fire
    // → false confidence from a burst-built baseline. With min-age, the burst is NOT trusted:
    expect(det.confidence).toBe('low');
    expect(det.reasons.join(' ')).not.toMatch(/out-of-character|tier escalation|style deviation/i);
    void principal;
  });

  it('the SAME-shaped baseline, once AGED past the min-age, IS established → out-of-character fires', async () => {
    // Identical shape, but firstSeen is 40 days back: now established by age AND count.
    const now = new Date(2026, 5, 9, 3, 0, 0);
    for (let i = 0; i < 45; i++) {
      recordAt(tmp, 'U_AGED', 45 - i, 1, { action: 'read', tier: 1, hour: 10, length: 30, urgent: false });
    }
    const store = new RelationshipBehaviorStore(tmp);
    const scorer = new RelationshipAnomalyScorer(store, { now: () => now, minBaselineAgeDays: 7, bucketMs: DAY_MS });
    const det = scorer.deterministicScore(store.profileFor('U_AGED'), intent('money-movement', 4, 'money-movement'), 'wire $40k');
    expect(det.confidence).not.toBe('low'); // age + count both satisfied
    expect(det.reasons.join(' ')).toMatch(/out-of-character|tier escalation/i);
  });

  it('minBaselineAgeDays: 0 restores legacy count-only "established" (opt-out / backward-compat)', async () => {
    // A young burst with the age gate OFF behaves like the pre-hardening scorer.
    const now = new Date(2026, 5, 9, 3, 0, 0);
    const at = new Date(now.getTime() - 1 * DAY_MS).toISOString();
    const s = new RelationshipBehaviorStore(tmp, () => at, { bucketMs: DAY_MS });
    for (let i = 0; i < 20; i++) s.record('U_NOW', { action: 'read', tier: 1, hour: 10, length: 30, urgent: false });
    const store = new RelationshipBehaviorStore(tmp);
    const scorer = new RelationshipAnomalyScorer(store, { now: () => now, minBaselineAgeDays: 0, bucketMs: DAY_MS });
    const det = scorer.deterministicScore(store.profileFor('U_NOW'), intent('money-movement', 4, 'money-movement'), 'wire $40k');
    expect(det.reasons.join(' ')).toMatch(/out-of-character/i); // age gate disabled → fires on count alone
  });
});

describe('Poisoning resistance #2 — recency/decay weighting', () => {
  it('DURABILITY: a one-time poisoning burst FADES as genuine traffic continues — the burst decays back below the out-of-character floor', () => {
    // The headline anti-poisoning property of decay: a one-time burst cannot DURABLY reshape
    // the baseline once genuine traffic resumes. The attacker bursts money-movement once; the
    // owner's genuine reads continue for months after, diluting the (decaying) burst.
    const burstDay = new Date(2026, 4, 1, 12, 0, 0).getTime();
    // The single capped burst on burstDay.
    {
      const s = new RelationshipBehaviorStore(tmp, () => new Date(burstDay).toISOString(), { bucketMs: DAY_MS, maxObservationsPerWindow: 5 });
      for (let i = 0; i < 20; i++) s.record('U_BURST', { action: 'money-movement', tier: 4, hour: 12, length: 30, urgent: false });
    }
    const floor = 0.1;
    const store = new RelationshipBehaviorStore(tmp);

    // Right after the burst (before genuine traffic resumes), money-movement is the only
    // recent behavior → its decayed share is high (the in-the-moment window the rate cap bounds).
    const justAfter = decayedView(store.profileFor('U_BURST')!, { nowMs: burstDay + 1 * DAY_MS, bucketMs: DAY_MS, halfLifeWindows: 10 });
    const shareJustAfter = (justAfter.actionCounts['money-movement'] ?? 0) / (justAfter.effectiveCount || 1);
    expect(shareJustAfter).toBeGreaterThan(floor); // fresh burst dominates the moment

    // Genuine reads resume daily for 60 days after the burst.
    for (let d = 1; d <= 60; d++) {
      const at = new Date(burstDay + d * DAY_MS).toISOString();
      const s = new RelationshipBehaviorStore(tmp, () => at, { bucketMs: DAY_MS });
      s.record('U_BURST', { action: 'read', tier: 1, hour: 10, length: 30, urgent: false });
    }
    const store2 = new RelationshipBehaviorStore(tmp);
    // 60 days later the burst has decayed (half-life 10 windows → 0.5^6 ≈ 0.016) while 60 fresh
    // reads carry near-full weight: money-movement's decayed share collapses BELOW the floor.
    const muchLater = decayedView(store2.profileFor('U_BURST')!, { nowMs: burstDay + 61 * DAY_MS, bucketMs: DAY_MS, halfLifeWindows: 10 });
    const shareMuchLater = (muchLater.actionCounts['money-movement'] ?? 0) / muchLater.effectiveCount;
    expect(shareMuchLater).toBeLessThan(shareJustAfter); // it faded
    expect(shareMuchLater).toBeLessThan(floor); // back under the out-of-character floor → fires again
  });

  it('a CAPPED burst stays RARE against an established baseline: out-of-character still clears step-up', async () => {
    // The rate cap (#3b) keeps an attacker burst's SHARE small relative to a long-standing
    // baseline, so the share-floor out-of-character signal survives. 100 genuine reads over
    // 100 days, then the attacker hammers money-movement but a 3/window cap admits ≤6 total.
    const now = new Date(2026, 5, 9, 3, 0, 0).getTime();
    for (let i = 0; i < 100; i++) {
      const at = new Date(now - (110 - i) * DAY_MS).toISOString(); // days 110..11 ago
      const s = new RelationshipBehaviorStore(tmp, () => at, { bucketMs: DAY_MS });
      s.record('U_VICTIM', { action: 'read', tier: 1, hour: 10, length: 30, urgent: false });
    }
    // Attacker hammers money-movement over the last 2 days; the 3/window cap admits ≤3/day.
    for (let d = 0; d < 2; d++) {
      const at = new Date(now - d * DAY_MS).toISOString();
      const s = new RelationshipBehaviorStore(tmp, () => at, { bucketMs: DAY_MS, maxObservationsPerWindow: 3 });
      for (let i = 0; i < 50; i++) s.record('U_VICTIM', { action: 'money-movement', tier: 4, hour: 11, length: 30, urgent: false });
    }
    const store = new RelationshipBehaviorStore(tmp);
    // Cap held: at most 3/window across 2 windows (≤6), regardless of the 50 attempts/day.
    const mmCount = store.profileFor('U_VICTIM')!.actionCounts['money-movement']!;
    expect(mmCount).toBeLessThanOrEqual(6);
    // money-movement cumulative share ≈ 6/106 ≈ 0.057 < 0.10 floor → still rare → out-of-character fires.
    const scorer = new RelationshipAnomalyScorer(store, { now: () => new Date(2026, 5, 9, 3, 0, 0), bucketMs: DAY_MS });
    const principal: Principal = { ...OLIVIA, slackUserId: 'U_VICTIM' };
    const longUrgent = 'URGENT: wire $50k to a brand new vendor account right now, this absolutely cannot wait until morning';
    const a = await scorer.assess(principal, intent('money-movement', 4, 'money-movement'), longUrgent);
    expect(a.reasons.join(' ')).toMatch(/out-of-character|rare/i);
    expect(a.score).toBeGreaterThanOrEqual(0.5);
  });

  it('WITHOUT the rate cap, the SAME burst normalizes the action — demonstrating the cap is load-bearing', async () => {
    // Counter-test: the identical scenario with the cap DISABLED lets the attacker inject 100
    // money-movement obs, pushing its cumulative AND recent-weighted share well over the floor →
    // out-of-character no longer fires from the action signal. (This is the pre-#3b behavior the
    // cap defends against; here it proves the cap — not luck — is what kept the burst rare above.)
    const now = new Date(2026, 5, 9, 3, 0, 0).getTime();
    for (let i = 0; i < 100; i++) {
      const at = new Date(now - (110 - i) * DAY_MS).toISOString();
      const s = new RelationshipBehaviorStore(tmp, () => at, { bucketMs: DAY_MS });
      s.record('U_VICTIM2', { action: 'read', tier: 1, hour: 10, length: 30, urgent: false });
    }
    // Cap DISABLED (0) → all 100 money-movement obs land in one recent window.
    const s = new RelationshipBehaviorStore(tmp, () => new Date(now).toISOString(), { bucketMs: DAY_MS, maxObservationsPerWindow: 0 });
    for (let i = 0; i < 100; i++) s.record('U_VICTIM2', { action: 'money-movement', tier: 4, hour: 11, length: 30, urgent: false });
    const store = new RelationshipBehaviorStore(tmp);
    expect(store.profileFor('U_VICTIM2')!.actionCounts['money-movement']).toBe(100); // no cap
    const scorer = new RelationshipAnomalyScorer(store, { now: () => new Date(2026, 5, 9, 3, 0, 0), bucketMs: DAY_MS });
    const principal: Principal = { ...OLIVIA, slackUserId: 'U_VICTIM2' };
    const det = scorer.deterministicScore(store.profileFor('U_VICTIM2'), intent('money-movement', 4, 'money-movement'), 'wire $50k');
    // money-movement is now 100/200 = 50% (both views) → NOT rare → the action signal is gone.
    expect(det.reasons.join(' ')).not.toMatch(/out-of-character/i);
  });
});

describe('Backward-compat — a pre-hardening baseline (no buckets) scores sensibly', () => {
  /** Write a profile in the OLD on-disk shape (no `buckets` field, only cumulative counts). */
  function writeLegacyProfile(firstSeenDaysAgo: number): void {
    const firstSeen = new Date(new Date(2026, 5, 9, 3, 0, 0).getTime() - firstSeenDaysAgo * DAY_MS).toISOString();
    const legacy = {
      U_LEGACY: {
        slackUserId: 'U_LEGACY',
        interactionCount: 50,
        actionCounts: { read: 40, 'prod-deploy': 10 },
        tierCounts: [0, 40, 0, 0, 10],
        hourCounts: (() => { const h = new Array(24).fill(0); h[10] = 40; h[11] = 10; return h; })(),
        lengthSum: 50 * 30,
        lengthSqSum: 50 * 30 * 30,
        urgentCount: 0,
        firstSeen,
        lastSeen: new Date(2026, 5, 5, 10, 0, 0).toISOString(),
        // NOTE: no `buckets` field — this is the pre-hardening shape.
      },
    };
    fs.mkdirSync(tmp, { recursive: true });
    fs.writeFileSync(path.join(tmp, 'slack-relationship-baselines.json'), JSON.stringify(legacy, null, 2));
  }

  it('a legacy profile decays to its cumulative form (decayedView == cumulative) — no buckets, full weight', () => {
    writeLegacyProfile(60);
    const store = new RelationshipBehaviorStore(tmp);
    const prof = store.profileFor('U_LEGACY')!;
    expect(prof.buckets).toBeUndefined(); // genuinely the old shape
    const view = decayedView(prof, { nowMs: new Date(2026, 5, 9, 3, 0, 0).getTime(), bucketMs: DAY_MS });
    // Legacy base is kept at full weight → effective counts equal cumulative counts.
    expect(view.effectiveCount).toBe(50);
    expect(view.actionCounts.read).toBe(40);
    expect(view.actionCounts['prod-deploy']).toBe(10);
    expect(view.tierCounts[4]).toBe(10);
  });

  it('a legacy (aged) profile still flags an out-of-character floor request', async () => {
    writeLegacyProfile(60); // 60 days old → age-established
    const store = new RelationshipBehaviorStore(tmp);
    const scorer = new RelationshipAnomalyScorer(store, { now: () => new Date(2026, 5, 9, 3, 0, 0), bucketMs: DAY_MS });
    const det = scorer.deterministicScore(store.profileFor('U_LEGACY'), intent('money-movement', 4, 'money-movement'), 'wire $40k urgently right now');
    // money-movement never seen in the legacy repertoire → out-of-character still fires;
    // 03:00 is off-cadence (legacy hours are 10/11 only).
    expect(det.reasons.join(' ')).toMatch(/out-of-character|off-cadence/i);
    expect(det.confidence).not.toBe('none');
  });

  it('recording onto a legacy profile backfills buckets WITHOUT moving the legacy cumulative counts', () => {
    writeLegacyProfile(60);
    const at = new Date(2026, 5, 9, 12, 0, 0).toISOString();
    const store = new RelationshipBehaviorStore(tmp, () => at, { bucketMs: DAY_MS });
    store.record('U_LEGACY', { action: 'read', tier: 1, hour: 12, length: 30, urgent: false });
    const prof = store.profileFor('U_LEGACY')!;
    // Cumulative grew by 1 (51); buckets now exist holding ONLY the new observation (count 1).
    expect(prof.interactionCount).toBe(51);
    expect(Array.isArray(prof.buckets)).toBe(true);
    const bucketCount = prof.buckets!.reduce((s, b) => s + b.count, 0);
    expect(bucketCount).toBe(1); // the 50 legacy obs stay as the un-bucketed legacy base
    // The decayed view sees the 50 legacy obs at FULL weight + the 1 fresh bucket at near-1
    // (the fresh bucket carries a sub-window intra-day age, so its weight is just under 1.0).
    const view = decayedView(prof, { nowMs: new Date(at).getTime(), bucketMs: DAY_MS });
    expect(view.effectiveCount).toBeGreaterThan(50.9);
    expect(view.effectiveCount).toBeLessThanOrEqual(51);
    expect(view.actionCounts.read).toBeGreaterThan(40); // 40 legacy + ~1 fresh
  });
});
