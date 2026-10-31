/**
 * Console Pace card view model (docs/specs/queue-pace.md §Surfaces): one plain line per queue in
 * the frozen wording, colour by verdict except person (neutral), no days-to-clear for person,
 * PR links only from numbers + a validated repo, and the maturation board's pace line.
 */
import { describe, it, expect } from 'vitest';
import { paceLine, toneOf, prLinks, paceSummary, maturationPaceLine, fmtRate } from '../../dashboard/console/pace-model.js';

const q = (over: Record<string, unknown> = {}) => ({
  id: 'feedback.triage', label: 'Feedback sorting', machine: 'Studio', verdict: 'falling-behind', rawVerdict: 'falling-behind',
  inflowPerDay: 120, outflowPerDay: 90, daysToClear: null, bottleneck: { kind: 'worker', detail: '', matched: ['worker'] },
  tuner: { state: 'speeding-up' }, coverage: { last3Ok: true }, ...over,
});

describe('pace line wording', () => {
  it('matches the spec example', () => {
    expect(paceLine(q())).toBe('Feedback sorting: 120 a day in, 90 done — falling behind; speeding up');
  });
  it('dry-run tuner and tuner off read plainly', () => {
    expect(paceLine(q({ tuner: { state: 'speeding-up-dry-run' } }))).toContain('trial mode, nothing changed');
    expect(paceLine(q({ tuner: { state: 'off' } }))).toContain('the sorting rounds keep running out of time');
  });
  it('cap and quota name the limit', () => {
    expect(paceLine(q({ bottleneck: { kind: 'cap', detail: 'the daily sorting call limit would be reached' } }))).toContain('held back by a fixed limit: the daily sorting call limit would be reached');
    expect(paceLine(q({ bottleneck: { kind: 'quota', detail: '' } }))).toContain('paused by the account usage limit');
  });
  it('person is information: "waiting on you", neutral tone, no days to clear', () => {
    const p = q({ id: 'feedback.fix', label: 'Feedback fixes', bottleneck: { kind: 'person', detail: '2 fixes are ready for your review', prs: [2439, 2442], repo: 'JKHeadley/instar' } });
    expect(paceLine(p)).toBe('Feedback fixes: 120 a day in, 90 done — waiting on you; 2 fixes are ready for your review');
    expect(paceLine(p)).not.toContain('falling behind');
    expect(toneOf(p)).toBe('muted');
    expect(paceLine({ ...p, verdict: 'catching-up', daysToClear: 4 })).not.toContain('days to clear');
  });
  it('catching up shows days to clear; holding and unknown read plainly', () => {
    expect(paceLine(q({ verdict: 'catching-up', rawVerdict: 'catching-up', daysToClear: 4.2, bottleneck: null }))).toContain('catching up, about 4.2 days to clear');
    expect(paceLine(q({ verdict: 'holding', rawVerdict: 'holding', bottleneck: null }))).toContain('holding steady');
    expect(paceLine(q({ verdict: 'unknown', rawVerdict: 'unknown', bottleneck: null, inflowPerDay: null, coverage: { last3Ok: false } }))).toBe('Feedback sorting: can’t tell yet (not enough recent measurements)');
    expect(paceLine(q({ verdict: 'shrinking-by-exits', rawVerdict: 'shrinking-by-exits', bottleneck: null }))).toContain('shrinking, but not by finishing work');
  });
  it('a first falling-behind reading shows before hysteresis promotes it', () => {
    expect(paceLine(q({ verdict: 'holding', bottleneck: null }))).toContain('may be falling behind — checking again next hour');
  });
  it('names the machine when several answer', () => {
    expect(paceLine(q(), true)).toContain('Feedback sorting (on Studio):');
  });
});

describe('tone, links, summary', () => {
  it('colour by verdict', () => {
    expect(toneOf(q())).toBe('attn');
    expect(toneOf(q({ verdict: 'holding', bottleneck: null }))).toBe('ok');
    expect(toneOf(q({ verdict: 'unknown', bottleneck: null }))).toBe('unknown');
  });
  it('PR links are built only from numbers and a valid repo', () => {
    const p = q({ bottleneck: { kind: 'person', prs: [12, -1, 1.5], repo: 'o/r' } });
    expect(prLinks(p)).toEqual([{ n: 12, href: 'https://github.com/o/r/pull/12' }]);
    expect(prLinks(q({ bottleneck: { kind: 'person', prs: [12], repo: 'evil.com/x/y' } }))).toEqual([]);
    expect(prLinks(q())).toEqual([]);
  });
  it('summary sentence', () => {
    expect(paceSummary([])).toContain('Nothing is being measured');
    expect(paceSummary([q()])).toBe('1 pile is growing faster than work gets done.');
    expect(paceSummary([q({ verdict: 'holding', bottleneck: null })])).toContain('keeping up');
  });
  it('maturation pace line and rate formatting', () => {
    expect(maturationPaceLine({ queues: [q({ id: 'maturation.fix', label: 'Maturation fixes', verdict: 'holding', rawVerdict: 'holding', bottleneck: null, inflowPerDay: 1.25, outflowPerDay: 1 })] }))
      .toBe('Pace: 1.3 a day in, 1 done — holding steady');
    expect(maturationPaceLine({ queues: [] })).toBeNull();
    expect(fmtRate(Number.NaN)).toBeNull();
  });
});
