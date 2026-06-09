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

/** Build an established owner baseline: 50 morning reads/deploys, calm, ~30-char messages. */
function seedEstablishedOwner(store: RelationshipBehaviorStore): void {
  for (let i = 0; i < 30; i++) {
    store.record('U_OLIVIA', { action: 'read', tier: 1, hour: 10, length: 30, urgent: false });
  }
  for (let i = 0; i < 20; i++) {
    store.record('U_OLIVIA', { action: 'prod-deploy', tier: 4, hour: 11, length: 35, urgent: false });
  }
}

describe('RelationshipBehaviorStore', () => {
  it('records SHAPE only and aggregates a baseline that survives a reload', () => {
    const store = new RelationshipBehaviorStore(tmp);
    seedEstablishedOwner(store);

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
    const store = new RelationshipBehaviorStore(tmp);
    seedEstablishedOwner(store);
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
    const store = new RelationshipBehaviorStore(tmp);
    seedEstablishedOwner(store);
    const scorer = new RelationshipAnomalyScorer(store, { now: () => new Date(2026, 5, 9, 10, 0, 0) });
    const a = await scorer.assess(OLIVIA, intent('prod-deploy', 4, 'prod-deploy'), 'push the hotfix to prod');
    expect(a.score).toBeLessThan(0.5);
  });

  it('an out-of-character request (off-cadence + tier-escalation + urgency + style) scores HIGH', async () => {
    const store = new RelationshipBehaviorStore(tmp);
    // Baseline: low-tier, calm, short, daytime reads.
    for (let i = 0; i < 40; i++) store.record('U_OLIVIA', { action: 'read', tier: 1, hour: 10, length: 30, urgent: false });
    const scorer = new RelationshipAnomalyScorer(store, { now: () => new Date(2026, 5, 9, 3, 0, 0) }); // 03:00 — off-cadence
    // A money transfer (never made, tier 4 vs normal ceiling 1), urgent, much longer message.
    const longUrgent = 'wire $40k urgently to this brand new vendor account before EOD please this cannot wait at all';
    const a = await scorer.assess(OLIVIA, intent('money-movement', 4, 'money-movement'), longUrgent);
    expect(a.score).toBeGreaterThanOrEqual(0.5);
    expect(a.reasons.length).toBeGreaterThan(1);
    expect(a.reasons.join(' ')).toMatch(/out-of-character|tier escalation|off-cadence|urgency|style/i);
  });

  it('POISONING RESISTANCE: a few seeded money-movement obs do NOT disable the out-of-character signal (share floor, Phase-3 adversarial fix)', async () => {
    const store = new RelationshipBehaviorStore(tmp);
    // Attacker poisons the baseline so a `seen === 0` check would be disabled: 50 normal
    // daytime reads + 2 seeded money-movement observations → money-movement share = 2/52
    // ≈ 0.04, BELOW the 0.10 floor → the out-of-character signal must STILL fire (scaled).
    for (let i = 0; i < 50; i++) store.record('U_OLIVIA', { action: 'read', tier: 1, hour: 10, length: 30, urgent: false });
    store.record('U_OLIVIA', { action: 'money-movement', tier: 4, hour: 10, length: 30, urgent: false });
    store.record('U_OLIVIA', { action: 'money-movement', tier: 4, hour: 10, length: 30, urgent: false });
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
    const store = new RelationshipBehaviorStore(tmp);
    seedEstablishedOwner(store); // 50 interactions
    const scorer = new RelationshipAnomalyScorer(store, { now: () => new Date(2026, 5, 9, 10, 0, 0) });
    const det = scorer.deterministicScore(store.profileFor('U_OLIVIA'), intent('read', 1), 'morning summary');
    expect(det.confidence).toBe('high'); // 50 >= establishedMin(5)*4
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
    const store = new RelationshipBehaviorStore(tmp);
    seedEstablishedOwner(store);
    const scorer = new RelationshipAnomalyScorer(store, {
      now: () => new Date(2026, 5, 9, 10, 0, 0),
      useLlmStyleCheck: true,
      intelligence: provider('MISMATCH'),
    });
    // In-character deploy (deterministic ~0) — only the LLM adds.
    const a = await scorer.assess(OLIVIA, intent('prod-deploy', 4, 'prod-deploy'), 'push the hotfix to prod');
    expect(a.score).toBeGreaterThan(0);
    expect(a.reasons.join(' ')).toMatch(/LLM style check/i);
  });

  it('an LLM failure FAILS CLOSED — it never widens (no contribution)', async () => {
    const store = new RelationshipBehaviorStore(tmp);
    seedEstablishedOwner(store);
    const throwing = scorerWithThrowingLlm(store);
    const a = await throwing.assess(OLIVIA, intent('prod-deploy', 4, 'prod-deploy'), 'push the hotfix to prod');
    // Deterministic score stands; the failed LLM adds nothing.
    expect(a.reasons.join(' ')).not.toMatch(/LLM style check/i);
    expect(a.score).toBeLessThan(0.5);
  });

  it('an LLM MATCH adds nothing', async () => {
    const store = new RelationshipBehaviorStore(tmp);
    seedEstablishedOwner(store);
    const scorer = new RelationshipAnomalyScorer(store, {
      now: () => new Date(2026, 5, 9, 10, 0, 0),
      useLlmStyleCheck: true,
      intelligence: provider('MATCH'),
    });
    const a = await scorer.assess(OLIVIA, intent('prod-deploy', 4, 'prod-deploy'), 'push the hotfix to prod');
    expect(a.reasons.join(' ')).not.toMatch(/LLM style check/i);
  });

  function scorerWithThrowingLlm(store: RelationshipBehaviorStore): RelationshipAnomalyScorer {
    return new RelationshipAnomalyScorer(store, {
      now: () => new Date(2026, 5, 9, 10, 0, 0),
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
    const store = new RelationshipBehaviorStore(tmp);
    // Olivia is an owner whose normal repertoire is daytime deploys/reads, calm, short.
    for (let i = 0; i < 40; i++) store.record('U_OLIVIA', { action: 'prod-deploy', tier: 4, hour: 11, length: 30, urgent: false });
    for (let i = 0; i < 20; i++) store.record('U_OLIVIA', { action: 'read', tier: 1, hour: 10, length: 28, urgent: false });
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
    const store = new RelationshipBehaviorStore(tmp);
    for (let i = 0; i < 40; i++) store.record('U_OLIVIA', { action: 'prod-deploy', tier: 4, hour: 11, length: 30, urgent: false });
    const gate = new SlackPermissionGate({
      classifier: new HeuristicIntentClassifier(),
      anomalyScorer: new RelationshipAnomalyScorer(store, { now: () => new Date(2026, 5, 9, 11, 0, 0) }),
      stepUpThreshold: 0.5,
    });
    const v = await gate.evaluate({ principal: OLIVIA, text: 'push the hotfix to prod', directed: true });
    expect(v.decision).toBe('allow');
  });

  it('anomaly can only RAISE the bar — a member floor request stays a refuse', async () => {
    const store = new RelationshipBehaviorStore(tmp);
    for (let i = 0; i < 40; i++) store.record('U_MAYA', { action: 'read', tier: 1, hour: 10, length: 30, urgent: false });
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
