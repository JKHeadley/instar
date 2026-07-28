/**
 * Unit tests for GrowthMilestoneAnalyst (Tier-1 of the Testing Integrity
 * Standard). Covers the PURE classification heart on BOTH sides of every
 * decision boundary (in-window vs expired, proved vs unproved vs unknown, each
 * risk tier), plus the analyst composing real fakes with a real temp-dir stage
 * journal. The window-expiry trigger is the feature's key lever, so its edges
 * get the most coverage.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  GrowthMilestoneAnalyst,
  classifyRollout,
  daysSince,
  resolveGrowthSettings,
  dominantDivergence,
  riskTierForInitiative,
  DEFAULT_GROWTH_SETTINGS,
  type GrowthAnalystSettings,
} from '../../src/monitoring/GrowthMilestoneAnalyst.js';
import type { Initiative, RolloutStage } from '../../src/core/InitiativeTracker.js';
import type { ClassSummary, DivergenceCategory } from '../../src/core/ApprovalLedger.js';
import type { CorrectionRecord } from '../../src/monitoring/CorrectionLedger.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

// ── fixtures ─────────────────────────────────────────────────────────────

function feat(id: string, stage: RolloutStage, promotionCriteria?: string): Initiative {
  return {
    id,
    title: id,
    rollout: { flagPath: `monitoring.${id}`, stage, promotionCriteria },
  } as unknown as Initiative;
}

interface FakeTrackerOpts {
  initiatives?: Initiative[];
  digestItems?: { initiativeId: string; title: string; reason: string; detail: string }[];
}
function fakeTracker(opts: FakeTrackerOpts = {}) {
  return {
    list: () => opts.initiatives ?? [],
    digest: (now: Date) => ({ generatedAt: now.toISOString(), items: opts.digestItems ?? [] }),
  } as any;
}

function emptyDivergences(): Record<DivergenceCategory, number> {
  return { 'missing-principle': 0, 'risk-reduction': 0, 'scope-correction': 0, efficiency: 0, 'new-information': 0, style: 0 };
}

function makeAnalyst(stateDir: string, deps: Partial<Parameters<typeof makeRaw>[0]> = {}, settings?: Partial<GrowthAnalystSettings>) {
  return makeRaw({ stateDir, settings, ...deps });
}
function makeRaw(o: {
  stateDir: string;
  settings?: Partial<GrowthAnalystSettings>;
  tracker?: any;
  approvalLedger?: any;
  correctionLedger?: any;
  evidenceCounter?: (i: Initiative) => number | undefined;
  now?: () => Date;
}) {
  return new GrowthMilestoneAnalyst({
    stateDir: o.stateDir,
    settings: resolveGrowthSettings({ enabled: true, ...(o.settings ?? {}) }),
    tracker: o.tracker ?? fakeTracker(),
    approvalLedger: o.approvalLedger ?? null,
    correctionLedger: o.correctionLedger ?? null,
    evidenceCounter: o.evidenceCounter,
    now: o.now,
  });
}

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gma-'));
});
afterEach(() => {
  try { SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/GrowthMilestoneAnalyst.test.ts' }); } catch { /* ok */ }
});

// ── PURE: daysSince ────────────────────────────────────────────────────────

describe('daysSince', () => {
  it('computes fractional days between iso and now', () => {
    const base = new Date('2026-06-01T00:00:00Z');
    const later = new Date('2026-06-04T12:00:00Z');
    expect(daysSince(base.toISOString(), later)).toBeCloseTo(3.5, 5);
  });
  it('returns 0 for an unparseable timestamp', () => {
    expect(daysSince('not-a-date', new Date())).toBe(0);
  });
});

// ── PURE: classifyRollout (BOTH sides of every boundary) ─────────────────────

describe('classifyRollout', () => {
  it('default-on is always terminal (nothing to decide)', () => {
    expect(classifyRollout('default-on', 100, 7, 0, 1).classification).toBe('terminal');
  });
  it('inside the window → incubating (even if proved)', () => {
    expect(classifyRollout('dry-run', 6.9, 7, 5, 1).classification).toBe('incubating');
  });
  it('exactly at the window boundary counts as expired (>=)', () => {
    // proved at the boundary → promotion-ready
    expect(classifyRollout('live', 7, 7, 3, 1).classification).toBe('promotion-ready');
  });
  it('expired + proved → promotion-ready (R1)', () => {
    expect(classifyRollout('dark', 8, 7, 2, 1).classification).toBe('promotion-ready');
  });
  it('expired + NOT proved (count below min) → expired-unproven (R2)', () => {
    const v = classifyRollout('dark', 8, 7, 0, 1);
    expect(v.classification).toBe('expired-unproven');
    expect(v.proved).toBe(false);
  });
  it('expired + UNKNOWN proof (no evidence source) → expired-unproven, proved:unknown', () => {
    const v = classifyRollout('dry-run', 8, 7, undefined, 1);
    expect(v.classification).toBe('expired-unproven');
    expect(v.proved).toBe('unknown');
  });
  it('unknown proof can NEVER be promotion-ready (honesty: never promote what we cannot prove ran)', () => {
    expect(classifyRollout('live', 100, 7, undefined, 1).classification).toBe('expired-unproven');
  });
  it('honors a higher proof threshold', () => {
    expect(classifyRollout('dark', 8, 7, 2, 5).classification).toBe('expired-unproven');
    expect(classifyRollout('dark', 8, 7, 5, 5).classification).toBe('promotion-ready');
  });
});

// ── PURE: resolveGrowthSettings ──────────────────────────────────────────────

describe('resolveGrowthSettings', () => {
  it('fills all defaults from an empty object', () => {
    const s = resolveGrowthSettings({});
    expect(s.enabled).toBe(false);
    expect(s.incubationWindows).toEqual({ lowRisk: 3, standard: 7, highRisk: 7 });
    expect(s.proofOfLifeMinActivations).toBe(1);
    expect(s.rules.promotionReady).toBe(true);
    expect(s.digestEvenWhenCalm).toBe(true);
  });
  it('respects overrides and rule disables', () => {
    const s = resolveGrowthSettings({ enabled: true, incubationWindows: { lowRisk: 1 }, rules: { specPattern: false }, digestEvenWhenCalm: false } as any);
    expect(s.enabled).toBe(true);
    expect(s.incubationWindows.lowRisk).toBe(1);
    expect(s.incubationWindows.standard).toBe(7); // untouched default
    expect(s.rules.specPattern).toBe(false);
    expect(s.rules.promotionReady).toBe(true);
    expect(s.digestEvenWhenCalm).toBe(false);
  });
  it('ignores non-numeric window values', () => {
    const s = resolveGrowthSettings({ incubationWindows: { standard: 'x' } } as any);
    expect(s.incubationWindows.standard).toBe(7);
  });
});

// ── PURE: dominantDivergence ─────────────────────────────────────────────────

describe('dominantDivergence', () => {
  it('returns null when there are no divergences', () => {
    expect(dominantDivergence(emptyDivergences())).toBeNull();
  });
  it('picks the highest-count category', () => {
    const c = emptyDivergences(); c['scope-correction'] = 5; c.style = 2;
    expect(dominantDivergence(c)).toEqual({ category: 'scope-correction', count: 5 });
  });
});

// ── PURE: riskTierForInitiative ──────────────────────────────────────────────

describe('riskTierForInitiative', () => {
  it('defaults to standard', () => {
    expect(riskTierForInitiative(feat('a', 'dark'))).toBe('standard');
  });
  it('reads low-risk / high-risk from the promotion criteria', () => {
    expect(riskTierForInitiative(feat('a', 'dark', 'low-risk, ≥3 idle reaps'))).toBe('lowRisk');
    expect(riskTierForInitiative(feat('b', 'dark', 'high-risk destructive op'))).toBe('highRisk');
  });
});

// ── ANALYST: window-expiry findings (R1/R2) ─────────────────────────────────

describe('GrowthMilestoneAnalyst — window-expiry (R1/R2)', () => {
  it('R1: a proved feature past its window → promotion-ready finding', () => {
    const t0 = new Date('2026-06-01T00:00:00Z');
    const a = makeRaw({
      stateDir: tmp,
      tracker: fakeTracker({ initiatives: [feat('reaper', 'live')] }),
      evidenceCounter: () => 3,
      now: () => t0,
    });
    a.observeStages(t0); // stamp firstObservedAt = t0
    const later = new Date('2026-06-09T00:00:00Z'); // +8d, window 7
    const findings = makeRaw({
      stateDir: tmp,
      tracker: fakeTracker({ initiatives: [feat('reaper', 'live')] }),
      evidenceCounter: () => 3,
      now: () => later,
    }).computeFindings(later);
    const r1 = findings.find((f) => f.rule === 'R1');
    expect(r1).toBeDefined();
    expect(r1!.subjectId).toBe('reaper');
    expect(r1!.suggestedAction).toBe('promote');
    expect(r1!.proved).toBe(true);
  });

  it('R2: an unproved feature past its window → extend/fix/kill finding', () => {
    const t0 = new Date('2026-06-01T00:00:00Z');
    makeRaw({ stateDir: tmp, tracker: fakeTracker({ initiatives: [feat('darkfeat', 'dark')] }), evidenceCounter: () => 0, now: () => t0 }).observeStages(t0);
    const later = new Date('2026-06-09T00:00:00Z');
    const findings = makeRaw({ stateDir: tmp, tracker: fakeTracker({ initiatives: [feat('darkfeat', 'dark')] }), evidenceCounter: () => 0, now: () => later }).computeFindings(later);
    const r2 = findings.find((f) => f.rule === 'R2');
    expect(r2).toBeDefined();
    expect(r2!.suggestedAction).toBe('extend-fix-kill');
  });

  it('R2-unknown: no evidence source → expired-unproven surfaced honestly as unknown', () => {
    const t0 = new Date('2026-06-01T00:00:00Z');
    makeRaw({ stateDir: tmp, tracker: fakeTracker({ initiatives: [feat('noevidence', 'dry-run')] }), now: () => t0 }).observeStages(t0);
    const later = new Date('2026-06-09T00:00:00Z');
    const findings = makeRaw({ stateDir: tmp, tracker: fakeTracker({ initiatives: [feat('noevidence', 'dry-run')] }), now: () => later }).computeFindings(later);
    const r2 = findings.find((f) => f.rule === 'R2');
    expect(r2).toBeDefined();
    expect(r2!.detail).toMatch(/no evidence source/i);
  });

  it('inside the window → no finding; counts it as incubating with a next-window-close', () => {
    const t0 = new Date('2026-06-01T00:00:00Z');
    const mk = (now: Date) => makeRaw({ stateDir: tmp, tracker: fakeTracker({ initiatives: [feat('young', 'dark', 'low-risk')] }), evidenceCounter: () => 1, now: () => now });
    mk(t0).observeStages(t0);
    const later = new Date('2026-06-03T00:00:00Z'); // +2d, lowRisk window 3
    const digest = mk(later).buildDigest(later);
    expect(digest.findings.length).toBe(0);
    expect(digest.counts.incubating).toBe(1);
    expect(digest.nextWindowClosesInDays).toBeCloseTo(1, 1);
    expect(digest.calm).toBe(true);
    expect(digest.summary).toMatch(/All healthy/);
  });

  it('a disabled rule suppresses its findings', () => {
    const t0 = new Date('2026-06-01T00:00:00Z');
    const mk = (now: Date, settings?: Partial<GrowthAnalystSettings>) => makeRaw({ stateDir: tmp, tracker: fakeTracker({ initiatives: [feat('x', 'live')] }), evidenceCounter: () => 5, now: () => now, settings });
    mk(t0).observeStages(t0);
    const later = new Date('2026-06-09T00:00:00Z');
    const findings = mk(later, { rules: { promotionReady: false } } as any).computeFindings(later);
    expect(findings.find((f) => f.rule === 'R1')).toBeUndefined();
  });
});

// ── ANALYST: stage journal discipline ───────────────────────────────────────

describe('GrowthMilestoneAnalyst — stage journal', () => {
  it('resets firstObservedAt when the stage changes (days-in-stage is current stage)', () => {
    const t0 = new Date('2026-06-01T00:00:00Z');
    makeRaw({ stateDir: tmp, tracker: fakeTracker({ initiatives: [feat('f', 'dark')] }), now: () => t0 }).observeStages(t0);
    const t1 = new Date('2026-06-05T00:00:00Z');
    const j = makeRaw({ stateDir: tmp, tracker: fakeTracker({ initiatives: [feat('f', 'live')] }), now: () => t1 }).observeStages(t1);
    expect(j['f'].stage).toBe('live');
    expect(j['f'].firstObservedAt).toBe(t1.toISOString()); // reset on stage change
  });

  it('prunes features no longer staged', () => {
    const t0 = new Date('2026-06-01T00:00:00Z');
    makeRaw({ stateDir: tmp, tracker: fakeTracker({ initiatives: [feat('gone', 'dark')] }), now: () => t0 }).observeStages(t0);
    const t1 = new Date('2026-06-02T00:00:00Z');
    const j = makeRaw({ stateDir: tmp, tracker: fakeTracker({ initiatives: [] }), now: () => t1 }).observeStages(t1);
    expect(j['gone']).toBeUndefined();
  });
});

// ── ANALYST: R3 stalling, R4 spec-pattern, R5 correction-pattern ────────────

describe('GrowthMilestoneAnalyst — initiative/spec/correction rules', () => {
  it('R3: reuses the tracker staleness digest (stale + needs-user)', () => {
    const now = new Date('2026-06-09T00:00:00Z');
    const a = makeRaw({
      stateDir: tmp,
      tracker: fakeTracker({
        digestItems: [
          { initiativeId: 'i1', title: 'Old project', reason: 'stale', detail: 'no update in 9d' },
          { initiativeId: 'i2', title: 'Awaiting you', reason: 'needs-user', detail: 'decision pending' },
          { initiativeId: 'i3', title: 'Other', reason: 'ready-to-advance', detail: 'ignore me' },
        ],
      }),
      now: () => now,
    });
    const findings = a.computeFindings(now);
    const r3 = findings.filter((f) => f.rule === 'R3');
    expect(r3.map((f) => f.subjectId).sort()).toEqual(['i1', 'i2']); // i3 (ready-to-advance) not surfaced
  });

  it('R4: a class mostly approved-with-change in one dimension → bake-in-default', () => {
    const now = new Date('2026-06-09T00:00:00Z');
    const summary: ClassSummary = {
      decisionClass: 'spec',
      total: 5,
      approvedAsIs: 1,
      approvedWithChange: 4,
      rejected: 0,
      ratio: 0.2,
      streak: 0,
      autoApprovalEligible: false,
      divergenceCounts: { ...emptyDivergences(), 'risk-reduction': 4 },
    };
    const a = makeRaw({ stateDir: tmp, approvalLedger: { summarize: () => [summary] }, now: () => now });
    const r4 = a.computeFindings(now).filter((f) => f.rule === 'R4');
    expect(r4.length).toBe(1);
    expect(r4[0].suggestedAction).toBe('bake-in-default');
    expect(r4[0].detail).toMatch(/risk-reduction/);
  });

  it('R4: below the change-ratio threshold → no finding', () => {
    const now = new Date('2026-06-09T00:00:00Z');
    const summary: ClassSummary = {
      decisionClass: 'spec', total: 5, approvedAsIs: 4, approvedWithChange: 1, rejected: 0,
      ratio: 0.8, streak: 4, autoApprovalEligible: false,
      divergenceCounts: { ...emptyDivergences(), style: 1 },
    };
    const a = makeRaw({ stateDir: tmp, approvalLedger: { summarize: () => [summary] }, now: () => now });
    expect(a.computeFindings(now).filter((f) => f.rule === 'R4').length).toBe(0);
  });

  it('R5: an open recurring correction at/over the threshold → route-correction (uses scrubbed text only)', () => {
    const now = new Date('2026-06-09T00:00:00Z');
    const rec: CorrectionRecord = {
      id: 'c1', dedupeKey: 'plainer-language', kind: 'user-preference', occurrenceCount: 4,
      detectedAt: now.toISOString(), learning: 'SECRET INTERNAL', scrubbedSummary: 'User keeps asking for plainer language',
      dayBucket: '2026-06-09', deterministicWeight: 1, llmConfidence: 0.9, topicId: null, sessionId: null,
      status: 'open', reopenCount: 0, createdAt: now.toISOString(), updatedAt: now.toISOString(), version: 1,
    };
    const a = makeRaw({ stateDir: tmp, correctionLedger: { list: () => [rec] }, now: () => now });
    const r5 = a.computeFindings(now).filter((f) => f.rule === 'R5');
    expect(r5.length).toBe(1);
    expect(r5[0].detail).toMatch(/plainer language/);
    expect(r5[0].detail).not.toMatch(/SECRET INTERNAL/); // internal learning never leaks
  });

  it('R5: an already-acted-on correction is owned by the correction loop, not surfaced', () => {
    const now = new Date('2026-06-09T00:00:00Z');
    const rec = { dedupeKey: 'k', occurrenceCount: 9, status: 'acted-on', scrubbedSummary: 's' } as any as CorrectionRecord;
    const a = makeRaw({ stateDir: tmp, correctionLedger: { list: () => [rec] }, now: () => now });
    expect(a.computeFindings(now).filter((f) => f.rule === 'R5').length).toBe(0);
  });
});

// ── ANALYST: calm digest + aggregation discipline (anti-flood guardrail) ─────

describe('GrowthMilestoneAnalyst — digest', () => {
  it('renders a calm "all healthy" digest when nothing crosses a rule', () => {
    const now = new Date('2026-06-09T00:00:00Z');
    const d = makeRaw({ stateDir: tmp, now: () => now }).buildDigest(now);
    expect(d.calm).toBe(true);
    expect(d.findings.length).toBe(0);
    expect(d.summary).toMatch(/All healthy/);
  });

  it('AGGREGATION INVARIANT: a burst of 500 expired features yields ONE digest, not 500 — counts carry the volume', () => {
    const t0 = new Date('2026-06-01T00:00:00Z');
    const many = Array.from({ length: 500 }, (_, i) => feat(`f${i}`, 'dark'));
    makeRaw({ stateDir: tmp, tracker: fakeTracker({ initiatives: many }), evidenceCounter: () => 0, now: () => t0 }).observeStages(t0);
    const later = new Date('2026-06-20T00:00:00Z'); // all past their 7d window
    const digest = makeRaw({ stateDir: tmp, tracker: fakeTracker({ initiatives: many }), evidenceCounter: () => 0, now: () => later }).buildDigest(later);
    // The digest object is singular; the volume lives in counts, not in a fan-out.
    expect(typeof digest.summary).toBe('string');
    expect(digest.counts.expiredUnproven).toBe(500);
    expect(digest.findings.filter((f) => f.rule === 'R2').length).toBe(500);
    expect(digest.calm).toBe(false);
  });
});

// ── ANALYST: default settings sanity ────────────────────────────────────────

describe('DEFAULT_GROWTH_SETTINGS', () => {
  it('ships dark with a tight standard window', () => {
    expect(DEFAULT_GROWTH_SETTINGS.enabled).toBe(false);
    expect(DEFAULT_GROWTH_SETTINGS.incubationWindows.standard).toBeLessThanOrEqual(7);
    expect(DEFAULT_GROWTH_SETTINGS.incubationWindows.lowRisk).toBeLessThanOrEqual(3);
  });
});
