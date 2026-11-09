/** Quality history at a glance (docs/specs/quality-history-glance.md): the
 * server's ranking/thinning signals and the page that draws them. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { thinPoints, glanceStatus, rankGlance, glanceItems, type GlanceItem } from '../../src/server/measurementQualityGlance.js';
import { qualityHistoryView, statusText, summarize, comparisonVerified, QUALITY_HREF } from '../../dashboard/console/quality-history.js';
import { measurementChart } from '../../dashboard/console/measurement-trend.js';
import { parseState } from '../../dashboard/console/maturation-board-model.js';
import type { MeasurementPoint } from '../../src/monitoring/MeasurementTrend.js';

const metric = { id: 'unknown-reads', source: 'feature-summary', sourceRef: 'ref', direction: 'at-most' as const, threshold: 48, minSamples: 10,
  outcome: false, qualityGuard: false, historyAvailable: true };
const pt = (at: number, value: number, samples = 20, joinPrevious = false): MeasurementPoint => ({ at, value, samples, joinPrevious, evaluation: null });
function item(over: Partial<GlanceItem> = {}): GlanceItem {
  const points = [1, 2, 3].map(i => ({ at: Date.parse('2026-11-0' + (i + 3) + 'T00:00:00Z'), value: 40 + i * 20, samples: 20, joinPrevious: false, current: true }));
  return { subjectId: 'throughput-floor', name: { kind: 'feature', id: 'monitoring.throughputFloor', title: 'monitoring.throughputFloor' }, metric,
    series: { source: 'feature-summary', sourceRef: 'ref', descriptorVersion: 1, points }, totalPoints: 3, contractHash: 'a'.repeat(64),
    evidenceState: 'missing-contract', proof: null, status: 'off-goal', first: { at: points[0].at, value: 60, samples: 20 },
    latest: { at: points[2].at, value: 100, samples: 20 }, change: 40, gap: 1.08, ...over };
}

describe('glance signals (server)', () => {
  it('thins to real recorded points only, keeps both ends, and joins only fully continuous runs', () => {
    const points = Array.from({ length: 100 }, (_, i) => pt(i, i * 2, 20, i > 0 && i !== 50));
    const thin = thinPoints(points, 10);
    expect(thin).toHaveLength(10);
    expect(thin[0].at).toBe(0); expect(thin[9].at).toBe(99);
    for (const p of thin) expect(points.some(o => o.at === p.at && o.value === p.value)).toBe(true);
    expect(thin[0].joinPrevious).toBe(false);
    const across50 = thin.findIndex(p => p.at > 50);
    expect(thin[across50].joinPrevious).toBe(false); // the original break at 50 is never bridged
    expect(thin[across50 + 1].joinPrevious).toBe(true);
    expect(thinPoints(points.slice(0, 5), 10)).toEqual(points.slice(0, 5));
  });

  it('judges the latest point against the target on both sides of each boundary', () => {
    expect(glanceStatus(null, metric)).toBe('no-points');
    expect(glanceStatus({ at: 1, value: 48, samples: 10 }, metric)).toBe('at-goal');
    expect(glanceStatus({ at: 1, value: 48.01, samples: 10 }, metric)).toBe('off-goal');
    expect(glanceStatus({ at: 1, value: 999, samples: 9 }, metric)).toBe('too-few-samples');
    const atLeast = { ...metric, direction: 'at-least' as const, threshold: 5 };
    expect(glanceStatus({ at: 1, value: 5, samples: 10 }, atLeast)).toBe('at-goal');
    expect(glanceStatus({ at: 1, value: 4.9, samples: 10 }, atLeast)).toBe('off-goal');
  });

  it('ranks off-goal by distance first, then the most changed', () => {
    const ranked = rankGlance([
      item({ subjectId: 'a', status: 'at-goal', change: 500, gap: 0 }),
      item({ subjectId: 'b', status: 'off-goal', gap: 0.2 }),
      item({ subjectId: 'c', status: 'too-few-samples', gap: 9 }),
      item({ subjectId: 'd', status: 'off-goal', gap: 3 }),
      item({ subjectId: 'e', status: 'at-goal', change: 1, gap: 0 }),
      item({ subjectId: 'f', status: 'no-points', series: null, latest: null, first: null, change: null }),
    ]);
    expect(ranked.map(i => i.subjectId)).toEqual(['d', 'b', 'c', 'a', 'e', 'f']);
  });

  it('builds rows from a detail read without carrying evaluation records, and nothing from an unavailable read', () => {
    const now = Date.parse('2026-11-09T00:00:00Z'), hash = 'b'.repeat(64);
    const read = { schema: 'measurement-read/1', advisory: true, authority: 'none', origin: 'm', subjectId: 's', generatedAt: '', windowDays: 90, state: 'available', sources: [],
      detail: { currentContractHash: hash, evidence: { state: 'missing-contract', metrics: [] }, metrics: [{ ...metric, total: 2, omitted: 0, series: [{ source: 'feature-summary', sourceRef: 'ref', descriptorVersion: 1,
        points: [{ at: now - 2000, value: 50, samples: 20, joinPrevious: false, evaluation: { contractHash: hash, dueSlotMs: 0, evaluatedAtMs: 0, rung: 'live', status: 'ready' } },
          { at: now - 1000, value: 40, samples: 20, joinPrevious: false, evaluation: null }, { at: now + 5000, value: 1, samples: 20, joinPrevious: false, evaluation: null }] }] }] } } as never;
    const { items } = glanceItems(read, null, now);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ status: 'at-goal', latest: { value: 40 }, first: { value: 50 }, change: -10, proof: null });
    expect(items[0].series!.points.map(p => p.current)).toEqual([true, false, false]);
    expect(glanceItems({ ...(read as object), state: 'unavailable', detail: null } as never, null, now).items).toEqual([]);
  });
});

describe('quality history page', () => {
  let dom: JSDOM;
  beforeEach(() => { dom = new JSDOM('<!doctype html><body></body>'); Object.assign(globalThis, { document: dom.window.document }); });
  afterEach(() => dom.window.close());
  const data = (items: GlanceItem[]) => ({ schema: 'measurement-quality-glance/1', generatedAt: new Date().toISOString(), windowDays: 90, items, itemsOmitted: 0,
    subjects: 1, subjectsOmitted: 0, notReadable: {}, sourcesComplete: true });

  it('has its own direct link on the board', () => {
    expect(QUALITY_HREF).toBe('#/work/maturation?s=quality');
    expect(parseState('?s=quality').s).toBe('quality');
  });

  it('draws a chart per item with the goal line, hollow unverified dots, and a way to act on each warning', () => {
    const node = qualityHistoryView(data([item(), item({ subjectId: 'x', status: 'at-goal', latest: { at: 1, value: 10, samples: 20 } })]));
    expect(node.querySelector('h1')?.textContent).toBe('1 of 2 measured items are off their goal.');
    expect(node.querySelectorAll('svg')).toHaveLength(2);
    const first = node.querySelector('.qh-card')!;
    expect(first.querySelector('line[stroke="var(--attn)"]')).not.toBeNull();
    expect(first.textContent).toContain('goal ≤ 48');
    expect([...first.querySelectorAll('circle')].every(c => c.getAttribute('fill') === 'var(--bg)')).toBe(true);
    expect(first.textContent).toContain('Comparison not verified');
    expect(first.querySelector('a.ask-link')).not.toBeNull();
    expect(node.querySelectorAll('.qh-card')[1].querySelector('a.ask-link')).toBeNull();
    expect(node.querySelector('.qh-warn a.ask-link')).not.toBeNull();
    expect(node.querySelector('.qh-back')?.getAttribute('href')).toBe('#/work/maturation');
  });

  it('marks a corroborated starting point and drops the unverified label only when the proof verifies it', () => {
    const proof = { id: 'unknown-reads', descriptorVersion: 1, comparisonAvailable: true, baseline: { state: 'verified', value: 60 }, current: { state: 'verified', value: 100 } };
    const verified = item({ proof: proof as never });
    expect(comparisonVerified(verified)).toBe(true);
    const node = qualityHistoryView(data([verified]));
    expect(node.textContent).not.toContain('Comparison not verified');
    expect(node.querySelector('line[stroke-dasharray="4 4"]')).not.toBeNull();
    expect(node.querySelector('.qh-warn')).toBeNull();
  });

  it('shows the first twelve, the rest on request', () => {
    const many = Array.from({ length: 15 }, (_, i) => item({ subjectId: `s${i}` }));
    const node = qualityHistoryView(data(many));
    expect(node.querySelectorAll('.qh-card')).toHaveLength(12);
    (node.querySelector('.qh-more') as HTMLButtonElement).click();
    expect(node.querySelectorAll('.qh-card')).toHaveLength(15);
  });

  it('says plainly when it cannot be read, with a way to ask, and never fabricates a trend', () => {
    const node = qualityHistoryView(null);
    expect(node.textContent).toContain('cannot be read');
    expect(node.querySelector('a.ask-link')).not.toBeNull();
    expect(node.querySelector('svg')).toBeNull();
    const empty = qualityHistoryView(data([item({ series: null, latest: null, first: null, change: null, status: 'no-points' })]));
    expect(empty.querySelector('svg')).toBeNull();
    expect(empty.textContent).toContain('No recorded values');
  });

  it('writes plain status lines and counts', () => {
    expect(statusText(item())).toMatch(/^Off goal: now 100, goal at most 48\. Was 60 on /);
    expect(statusText(item({ status: 'too-few-samples', latest: { at: 1, value: 3, samples: 4 } }))).toContain('too few samples to judge (4 of 10 needed)');
    expect(summarize(data([item(), item({ status: 'at-goal' })]) as never)).toMatchObject({ total: 2, off: 1, at: 1, verified: 0 });
  });

  it('keeps names literal', () => {
    const node = qualityHistoryView(data([item({ name: { kind: 'feature', id: 'x', title: '<img src=x onerror=alert(1)>' } })]));
    expect(node.querySelector('img')).toBeNull();
    expect(node.textContent).toContain('<img');
  });

  it('leaves the detail chart unchanged when no goal is asked for', () => {
    const i = item();
    const plain = measurementChart(i.metric, { ...i.series!, points: i.series!.points.map(p => ({ ...p, evaluation: null })) }, { generatedAt: new Date().toISOString(), currentContractHash: i.contractHash }, null);
    expect(plain.querySelector('line[stroke="var(--attn)"]')).toBeNull();
    expect(plain.querySelector('figcaption')).not.toBeNull();
  });
});
