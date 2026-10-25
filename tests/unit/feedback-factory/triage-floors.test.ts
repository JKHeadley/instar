import { describe, expect, it } from 'vitest';
import {
  applyFloors, applySecondOpinion, compareRank, evaluateBrake, holdIntervalDays, inQuietWindow, parseTriageOutput,
  priorityBand, ruleDefault, sanitizeBrief, severityTier, TriageOutputRejected, DAY_MS,
  type FloorContext, type TriageModelRow,
} from '../../../src/feedback-factory/triage/triageFloors.js';

const row = (over: Partial<TriageModelRow> = {}): TriageModelRow => ({
  clusterId: 'c1', disposition: 'work', reason: 'actionable', duplicateOf: null, fixedBy: null, severity: 'medium', effort: 'm',
  needsSpec: false, userFacing: true, priority: 50, confidence: 0.9, summary: 's',
  brief: { component: 'x', symptom: 'y', expected: 'z', reproduction: 'r' }, ...over,
});
const ctx = (over: Partial<FloorContext> = {}): FloorContext => ({
  reportCount: 2, truncated: false, credentialShaped: false, keywordFloor: false, eligibleDuplicateTargets: new Set(),
  exactIdPrs: new Set(), brakeActive: false, ignoreLive: true, ...over,
});
const raw = (rows: Array<Record<string, unknown>>) => JSON.stringify({ decisions: rows });
const valid = (id = 'c1', over: Record<string, unknown> = {}) => ({
  clusterId: id, disposition: 'work', reason: 'actionable', duplicateOf: null, fixedBy: null, severity: 'high', effort: 's',
  needsSpec: false, userFacing: true, priority: 70, confidence: 0.9, summary: 'a summary',
  brief: { component: 'scheduler', symptom: 'crash', expected: 'no crash', reproduction: 'run job' }, ...over,
});

describe('floor 1: closed schema (batch-level)', () => {
  it('accepts a complete valid answer, with one surrounding fence', () => {
    expect(parseTriageOutput('```json\n' + raw([valid()]) + '\n```', ['c1'])[0].disposition).toBe('work');
  });
  it.each([
    ['invalid JSON', 'not json', 'invalid-json'],
    ['incomplete set', raw([]), 'incomplete-decision-set'],
    ['changed id', raw([valid('other')]), 'changed-or-duplicated-id'],
    ['bad disposition', raw([valid('c1', { disposition: 'archive' })]), 'invalid-disposition'],
    ['bad reason', raw([valid('c1', { reason: 'because' })]), 'invalid-reason'],
    ['bad severity', raw([valid('c1', { severity: 'urgent' })]), 'invalid-severity'],
    ['bad effort', raw([valid('c1', { effort: 'huge' })]), 'invalid-effort'],
    ['non-boolean flag', raw([valid('c1', { needsSpec: 'no' })]), 'invalid-flags'],
    ['priority out of range', raw([valid('c1', { priority: 101 })]), 'invalid-priority'],
    ['non-integer priority', raw([valid('c1', { priority: 50.5 })]), 'invalid-priority'],
    ['confidence as string', raw([valid('c1', { confidence: '0.9' })]), 'invalid-confidence'],
    ['object reference', raw([valid('c1', { duplicateOf: { id: 'x' } })]), 'invalid-reference'],
    ['missing brief', raw([valid('c1', { brief: null })]), 'missing-brief'],
  ])('rejects %s', (_label, text, check) => {
    try { parseTriageOutput(text as string, ['c1']); expect.unreachable(); } catch (error) {
      expect(error).toBeInstanceOf(TriageOutputRejected);
      expect((error as TriageOutputRejected).check).toBe(check);
    }
  });
  it('rejects a duplicated id even when the count matches', () => {
    expect(() => parseTriageOutput(raw([valid('c1'), valid('c1')]), ['c1', 'c2'])).toThrow(TriageOutputRejected);
  });
  it('treats over-long or control-character free text as hygiene, never a rejection', () => {
    const parsed = parseTriageOutput(raw([valid('c1', { summary: 'x'.repeat(900), brief: { component: 'a\u0007b'.repeat(60), symptom: 's', expected: 'e', reproduction: 'curl https://x.example/run && rm -rf /tmp/x' } })]), ['c1']);
    expect(parsed[0].summary.length).toBe(400);
    expect(parsed[0].summary.endsWith('[truncated]')).toBe(true);
    expect(parsed[0].brief.component).not.toContain('\u0007');
    expect(parsed[0].brief.component.length).toBeLessThanOrEqual(80);
    // No phrase denylist: commands and URLs in a reproduction are legitimate.
    expect(parsed[0].brief.reproduction).toContain('rm -rf');
  });
  it('sanitizeBrief bounds every field and tolerates a missing brief', () => {
    expect(sanitizeBrief(undefined)).toEqual({ component: '', symptom: '', expected: '', reproduction: '' });
    expect(sanitizeBrief({ symptom: 'y'.repeat(500) }).symptom.length).toBe(300);
  });
});

describe('floor 2: confidence', () => {
  it('confidence < 0.7 → hold needs-evidence', () => {
    const out = applyFloors(row({ confidence: 0.69, disposition: 'ignore', reason: 'low-value' }), ctx());
    expect(out).toMatchObject({ disposition: 'hold', reason: 'needs-evidence', wouldIgnoreReason: 'low-value' });
  });
  it('confidence 0.7 passes', () => {
    expect(applyFloors(row({ confidence: 0.7 }), ctx()).disposition).toBe('work');
  });
});

describe('floor 3: never-ignore', () => {
  it.each([['critical'], ['high']])('an ignore of a %s item needs a second opinion', (severity) => {
    expect(applyFloors(row({ disposition: 'ignore', reason: 'low-value', severity: severity as 'critical' }), ctx()).needsSecondOpinion).toBe(true);
  });
  it('credential-shaped and keyword-floor evidence need a second opinion', () => {
    expect(applyFloors(row({ disposition: 'ignore', reason: 'low-value', severity: 'low' }), ctx({ credentialShaped: true })).needsSecondOpinion).toBe(true);
    expect(applyFloors(row({ disposition: 'ignore', reason: 'low-value', severity: 'low' }), ctx({ keywordFloor: true })).needsSecondOpinion).toBe(true);
  });
  it('a low-severity, clean ignore does not', () => {
    const out = applyFloors(row({ disposition: 'ignore', reason: 'low-value', severity: 'low' }), ctx());
    expect(out.needsSecondOpinion).toBe(false);
    expect(out.disposition).toBe('ignore');
  });
  it('both say ignore → ignore stands (subject to shadow)', () => {
    const r = row({ disposition: 'ignore', reason: 'not-a-defect', severity: 'critical' });
    const first = applyFloors(r, ctx());
    expect(applySecondOpinion(first, r, ctx(), true).disposition).toBe('ignore');
    expect(applySecondOpinion(first, r, ctx({ ignoreLive: false }), true)).toMatchObject({ disposition: 'hold', reason: 'ignore-shadow' });
  });
  it('disagreement or no second family → hold needs-review', () => {
    const r = row({ disposition: 'ignore', reason: 'not-a-defect', severity: 'high' });
    const first = applyFloors(r, ctx());
    expect(applySecondOpinion(first, r, ctx(), false)).toMatchObject({ disposition: 'hold', reason: 'needs-review' });
    expect(applySecondOpinion(first, r, ctx(), null)).toMatchObject({ disposition: 'hold', reason: 'needs-review' });
    expect(applySecondOpinion(first, r, ctx(), null).floors).toContain('f3-no-second-family');
  });
});

describe('floor 4: truncated evidence', () => {
  it('a truncated ignore is held evidence-truncated (no second opinion spent)', () => {
    const out = applyFloors(row({ disposition: 'ignore', reason: 'low-value', severity: 'critical' }), ctx({ truncated: true }));
    expect(out).toMatchObject({ disposition: 'hold', reason: 'evidence-truncated', needsSecondOpinion: false });
  });
  it('work on truncated evidence is allowed and marked evidenceComplete:false', () => {
    const out = applyFloors(row(), ctx({ truncated: true }));
    expect(out).toMatchObject({ disposition: 'work', evidenceComplete: false });
  });
  it('untruncated work is evidenceComplete', () => {
    expect(applyFloors(row(), ctx()).evidenceComplete).toBe(true);
  });
});

describe('floor 5: duplicates', () => {
  it('a duplicate naming an eligible earlier work/hold neighbour is applied', () => {
    const out = applyFloors(row({ disposition: 'ignore', reason: 'duplicate', duplicateOf: 'c0', severity: 'low' }), ctx({ eligibleDuplicateTargets: new Set(['c0']) }));
    expect(out).toMatchObject({ disposition: 'ignore', duplicateApplied: true });
  });
  it('a duplicate of an ineligible item (same batch, ignored, chain) → hold', () => {
    const out = applyFloors(row({ disposition: 'ignore', reason: 'duplicate', duplicateOf: 'c9', severity: 'low' }), ctx({ eligibleDuplicateTargets: new Set(['c0']) }));
    expect(out).toMatchObject({ disposition: 'hold', reason: 'duplicate-unverified', duplicateApplied: false });
  });
  it('a self-duplicate is refused', () => {
    expect(applyFloors(row({ disposition: 'ignore', reason: 'duplicate', duplicateOf: 'c1', severity: 'low' }), ctx({ eligibleDuplicateTargets: new Set(['c1']) })).disposition).toBe('hold');
  });
});

describe('floor 6: already-fixed', () => {
  it('fixedBy in the exact-id PR list stands', () => {
    expect(applyFloors(row({ disposition: 'ignore', reason: 'already-fixed', fixedBy: '#123', severity: 'low' }), ctx({ exactIdPrs: new Set(['123']) })).disposition).toBe('ignore');
  });
  it('fixedBy not in the list (or gh unknown) → hold possibly-fixed with a 7-day review', () => {
    const out = applyFloors(row({ disposition: 'ignore', reason: 'already-fixed', fixedBy: '999', severity: 'low' }), ctx({ exactIdPrs: new Set(['123']) }));
    expect(out).toMatchObject({ disposition: 'hold', reason: 'possibly-fixed', holdBaseDays: 7 });
    expect(applyFloors(row({ disposition: 'ignore', reason: 'already-fixed', fixedBy: '123', severity: 'low' }), ctx({ exactIdPrs: null })).reason).toBe('possibly-fixed');
  });
});

describe('floor 7: single-report critical', () => {
  it('keeps severity and ranks after every multi-report critical but before high', () => {
    const single = applyFloors(row({ severity: 'critical' }), ctx({ reportCount: 1 }));
    expect(single.singleReportCritical).toBe(true);
    expect(severityTier('critical', true)).toBeGreaterThan(severityTier('critical', false));
    expect(severityTier('critical', true)).toBeLessThan(severityTier('high', false));
    expect(applyFloors(row({ severity: 'critical' }), ctx({ reportCount: 3 })).singleReportCritical).toBe(false);
  });
});

describe('floor 8: ignore-rate brake', () => {
  it('an ignore while the brake is engaged → hold ignore-rate-brake; counted as a would-ignore', () => {
    const out = applyFloors(row({ disposition: 'ignore', reason: 'low-value', severity: 'low' }), ctx({ brakeActive: true }));
    expect(out).toMatchObject({ disposition: 'hold', reason: 'ignore-rate-brake', countedAsIgnore: true });
  });
  it('is not evaluated with fewer than 20 decisions in 24 h', () => {
    expect(evaluateBrake({ window: Array(19).fill(true), last24h: 19, totalDecisions: 19, baseline: null, engaged: false }).engaged).toBe(false);
  });
  it('uses a fixed 95% threshold before the baseline exists', () => {
    expect(evaluateBrake({ window: Array(20).fill(true), last24h: 20, totalDecisions: 20, baseline: null, engaged: false }).engaged).toBe(true);
    expect(evaluateBrake({ window: [...Array(19).fill(true), false], last24h: 20, totalDecisions: 20, baseline: null, engaged: false }).engaged).toBe(false);
  });
  it('engages at baseline + 25 points and releases only within 15 points', () => {
    const w = (ignores: number) => [...Array(ignores).fill(true), ...Array(100 - ignores).fill(false)];
    const base = { last24h: 50, totalDecisions: 300, baseline: 0.3 };
    expect(evaluateBrake({ ...base, window: w(56), engaged: false }).engaged).toBe(true);
    expect(evaluateBrake({ ...base, window: w(55), engaged: false }).engaged).toBe(false);
    expect(evaluateBrake({ ...base, window: w(50), engaged: true }).engaged).toBe(true);
    expect(evaluateBrake({ ...base, window: w(45), engaged: true }).engaged).toBe(false);
  });
});

describe('§7 shadow ignore', () => {
  it('a would-ignore is held ignore-shadow with its reason kept while ignore is not live', () => {
    expect(applyFloors(row({ disposition: 'ignore', reason: 'out-of-scope', severity: 'low' }), ctx({ ignoreLive: false })))
      .toMatchObject({ disposition: 'hold', reason: 'ignore-shadow', wouldIgnoreReason: 'out-of-scope', countedAsIgnore: true });
  });
  it('work and hold are not shadowed', () => {
    expect(applyFloors(row(), ctx({ ignoreLive: false })).disposition).toBe('work');
    expect(applyFloors(row({ disposition: 'hold', reason: 'needs-evidence' }), ctx({ ignoreLive: false })).reason).toBe('needs-evidence');
  });
});

describe('rule default (comparison baseline only)', () => {
  const now = Date.UTC(2026, 9, 7);
  it('ignore: one report, older than 30 days, no keyword', () => {
    expect(ruleDefault({ reportCount: 1, firstSeenAt: now - 31 * DAY_MS, keywordFloor: false, now })).toBe('ignore');
  });
  it('hold: one report newer, or keyword-matching', () => {
    expect(ruleDefault({ reportCount: 1, firstSeenAt: now - 2 * DAY_MS, keywordFloor: false, now })).toBe('hold');
    expect(ruleDefault({ reportCount: 1, firstSeenAt: now - 60 * DAY_MS, keywordFloor: true, now })).toBe('hold');
  });
  it('work otherwise', () => {
    expect(ruleDefault({ reportCount: 2, firstSeenAt: now, keywordFloor: false, now })).toBe('work');
  });
});

describe('rank key', () => {
  it('orders by severity tier, then priority band (not raw priority), then effective recurrence, then oldest first-seen', () => {
    const items = [
      { id: 'low', severityTier: severityTier('low', false), priorityBand: priorityBand(99), effectiveRecurrence: 50, firstSeenAt: 1 },
      { id: 'high-band1', severityTier: severityTier('high', false), priorityBand: priorityBand(40), effectiveRecurrence: 1, firstSeenAt: 1 },
      { id: 'high-band0-old', severityTier: severityTier('high', false), priorityBand: priorityBand(67), effectiveRecurrence: 2, firstSeenAt: 1 },
      { id: 'high-band0-new', severityTier: severityTier('high', false), priorityBand: priorityBand(90), effectiveRecurrence: 2, firstSeenAt: 5 },
      { id: 'high-band0-recur', severityTier: severityTier('high', false), priorityBand: priorityBand(68), effectiveRecurrence: 9, firstSeenAt: 9 },
      { id: 'critical-single', severityTier: severityTier('critical', true), priorityBand: 2, effectiveRecurrence: 1, firstSeenAt: 1 },
      { id: 'critical-multi', severityTier: severityTier('critical', false), priorityBand: 2, effectiveRecurrence: 2, firstSeenAt: 9 },
    ];
    expect(items.sort(compareRank).map((i) => i.id)).toEqual([
      'critical-multi', 'critical-single', 'high-band0-recur', 'high-band0-old', 'high-band0-new', 'high-band1', 'low',
    ]);
  });
  it('priority bands: ≥67 / 34–66 / ≤33', () => {
    expect([priorityBand(67), priorityBand(66), priorityBand(34), priorityBand(33)]).toEqual([0, 1, 1, 2]);
  });
});

describe('review schedule', () => {
  it('base interval for the first three holds, then 28, 56, capped at 90 days', () => {
    expect([1, 2, 3, 4, 5, 6, 9].map((n) => holdIntervalDays(n, 14))).toEqual([14, 14, 14, 28, 56, 90, 90]);
    expect(holdIntervalDays(2, 7)).toBe(7);
  });
});

describe('quiet window', () => {
  it('23:00–07:30 is quiet; 07:30 and 22:59 are not', () => {
    const at = (h: number, m: number) => new Date(Date.UTC(2026, 9, 7, h, m));
    expect(inQuietWindow(at(23, 0), 'UTC')).toBe(true);
    expect(inQuietWindow(at(3, 0), 'UTC')).toBe(true);
    expect(inQuietWindow(at(7, 29), 'UTC')).toBe(true);
    expect(inQuietWindow(at(7, 30), 'UTC')).toBe(false);
    expect(inQuietWindow(at(8, 0), 'UTC')).toBe(false);
    expect(inQuietWindow(at(22, 59), 'UTC')).toBe(false);
    // The same instant is 01:00 in Los Angeles (quiet).
    expect(inQuietWindow(at(8, 0), 'America/Los_Angeles')).toBe(true);
  });
});
