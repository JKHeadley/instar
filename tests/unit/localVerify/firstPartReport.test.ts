// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FirstPartReport, DAY, redMainEpisode, currentTrial, observation, summarize, validFirstPartEvidence, type Observation } from '../../../src/localVerify/firstPartReport.js';
import { validateRecord } from '../../../src/localVerify/record.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'firstPartReport.test.ts' }); });
function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'report-')); dirs.push(dir);
  let now = Date.parse('2026-11-01T00:00:00Z');
  const audit = vi.fn();
  const store = () => new FirstPartReport(dir, () => now, audit);
  return { dir, audit, store: store(), restart: store, now: () => now, advance: (ms: number) => { now += ms; } };
}
let id = 0;
function row(at: number, over: Partial<Observation> = {}): Observation {
  return { type: 'observation', id: String(++id), at, startedAt: at, pr: id, head: 'a'.repeat(40), base: 'b'.repeat(40),
    setting: 'alternate', group: 'with', ran: true, outcome: 'failure', minutes: 10, incomplete: false,
    completedLanes: ['unit', 'integration', 'e2e'], firstPartFiles: { unit: ['tests/unit/x.test.ts'] },
    failures: [{ file: 'tests/unit/x.test.ts', lane: 'unit', firstPart: true, own: false, result: 'failed' }], failuresTotal: 1, ...over };
}
function add(h: ReturnType<typeof harness>, n: number, over: Partial<Observation> = {}) { for (let i = 0; i < n; i++) h.store.observe(row(h.now(), over)); }

describe('observation and trial history', () => {
  it('bounds named failures, preserves totals, error step and start evidence', () => {
    const r = { pr: 1, headSha: 'a', baseSha: 'b', startedAt: new Date(0).toISOString(), finishedAt: new Date(60000).toISOString(), outcome: 'error', errorStep: 'deadline:total' } as never;
    const failures = Array.from({ length: 51 }, (_, i) => ({ ...row(0).failures[0], file: `f${i}` }));
    const o = observation(r, 'attempt', { setting: 'alternate', group: 'without', ran: false }, { ...row(0), failures, failuresTotal: 51 });
    expect(o).toMatchObject({ id: 'attempt', minutes: 1, errorStep: 'deadline:total', failuresTotal: 51 });
    expect(o.failures).toHaveLength(50);
    expect(observation(r, 'token', { setting: 'off', group: 'with', ran: false }).incomplete).toBe(true);
  });
  it('keeps markers, expires old rows and survives restart', () => {
    const h = harness(); h.store.readSetting('alternate'); add(h, 1);
    h.advance(31 * DAY); add(h, 1);
    expect(h.restart().rows().map((r) => r.type)).toEqual(['marker', 'observation']);
  });
  it('counts assignments including empty first parts, excludes off, retains an ended trial and starts anew', () => {
    const h = harness(); h.store.readSetting('alternate'); add(h, 1, { ran: false }); add(h, 1, { setting: 'off' });
    expect(h.store.report('alternate').groups.with.verifies).toBe(1);
    h.advance(1); h.store.marker('off', 'limit');
    expect(h.store.report('off').trial.ended).toBe(true);
    expect(h.store.report('off', true).groups.with.verifies).toBe(1);
    h.advance(1); h.store.readSetting('alternate'); h.advance(1); add(h, 1, { group: 'without' });
    expect(h.store.report('alternate').groups.with.verifies).toBe(0);
    expect(h.store.report('alternate').groups.without.verifies).toBe(1);
  });
  it('an explicit joint marker starts the continuously alternate machine again', () => {
    const h = harness(); h.store.readSetting('alternate'); add(h, 3); h.advance(1); h.store.marker('alternate'); h.advance(1); add(h, 1);
    expect(h.store.report('alternate').groups.with.verifies).toBe(1);
    expect(currentTrial(h.store.rows()).observations).toHaveLength(1);
    h.advance(DAY); expect(h.store.report('alternate').stale).toBeNull();
    h.advance(1); expect(h.store.report('alternate').stale).toContain('24 hours');
  });
});

describe('suspects and findings', () => {
  it.each(['with', 'without'] as const)('uses four failures, three PRs and the third boundary in %s', (group) => {
    const h = harness(); h.store.readSetting('alternate'); add(h, 3, { group });
    expect(h.store.report('alternate', true).open).toBe(0);
    add(h, 1, { group }); expect(h.store.report('alternate', true).open).toBe(1);
    const h2 = harness(); h2.store.readSetting('alternate'); add(h2, 4, { group, pr: 1 });
    expect(h2.store.report('alternate', true).open).toBe(0);
    add(h2, 2, { group: group === 'with' ? 'without' : 'with' });
    expect(h2.store.report('alternate', true).open).toBe(0);
  });
  it('never suspects own test files and distinguishes reached lanes from unknown exposure', () => {
    const rs = Array.from({ length: 4 }, () => row(0, { failures: [{ ...row(0).failures[0], own: true }] }));
    const h = harness(); h.store.readSetting('alternate'); for (const r of rs) h.store.observe({ ...r, at: h.now(), startedAt: h.now() });
    expect(h.store.report('alternate', true).open).toBe(0);
    const table = summarize([...rs, row(0, { group: 'without', failures: [], completedLanes: [], firstPartFiles: {} })]).files[0];
    expect(table.with.ran).toBe(4); expect(table.without.unknown).toBe(1);
  });
  it('marks overdue strictly after three days, unknown unresolved, and later findings close it', () => {
    const h = harness(); h.store.readSetting('alternate'); add(h, 4); h.store.evaluate();
    h.advance(3 * DAY); expect(h.store.report('alternate').overdue).toBe(0);
    h.advance(1); expect(h.store.report('alternate').overdue).toBe(1);
    const body = { suspect: 'tests/unit/x.test.ts', finding: 'unknown', reason: 'investigating' };
    expect(h.store.finding(body)).toBe(true);
    expect(h.store.report('alternate').suspects[0]).toMatchObject({ unresolved: true, open: true, overdue: false });
    expect(h.store.finding({ ...body, finding: 'explained' })).toBe(true);
    expect(h.store.report('alternate').open).toBe(0);
    h.advance(1); add(h, 3); h.store.evaluate(); expect(h.store.report('alternate').open).toBe(0);
    add(h, 1); h.store.evaluate(); expect(h.store.report('alternate').open).toBe(1);
    const at = h.store.report('alternate').suspects[0].at;
    h.advance(DAY); h.store.evaluate(); expect(h.store.report('alternate').suspects[0].at).toBe(at);
    expect(h.store.finding({ ...body, finding: 'confirmed' })).toBe(true);
    expect(h.store.report('alternate').conclusion).toContain('Confirmed');
    h.advance(1); h.store.marker('alternate'); h.advance(1); add(h, 4); h.store.evaluate();
    expect(h.store.report('alternate').open).toBe(1);
    expect(h.store.report('alternate').suspects).toHaveLength(2);
  });
  it('refuses malformed findings and unknown suspects', () => {
    const h = harness(); add(h, 4); h.store.evaluate();
    for (const b of [null, {}, { suspect: 'missing', finding: 'unknown', reason: '' }, { suspect: 'tests/unit/x.test.ts', finding: 'yes', reason: '' }, { suspect: 'tests/unit/x.test.ts', finding: 'unknown', reason: 'x'.repeat(301) }]) expect(h.store.finding(b)).toBe(false);
  });
  it('episodes are written once and only known first-part passes owe findings', () => {
    const h = harness();
    const ep = { redHead: 'red', lastGreenHead: 'green', at: h.now(), historyUnknown: true, commits: [] };
    h.store.episode(ep); h.store.episode(ep); expect(h.store.report('off').episodes).toHaveLength(1);
    expect(h.store.report('off').open).toBe(0);
    h.store.green(); h.store.episode({ ...ep, redHead: 'red2', historyUnknown: false, commits: [{ head: 'c', pr: 3, firstParts: 'yes' }] });
    expect(h.store.report('off').open).toBe(1);
  });
});

describe('cost limits', () => {
  const passed = { outcome: 'success' as const, failures: [], failuresTotal: 0 };
  it('requires eight passes each and strictly more than one minute', () => {
    const rows = (n: number, minutes: number) => [...Array.from({ length: n }, () => row(0, { ...passed, minutes })), ...Array.from({ length: 8 }, () => row(0, { ...passed, group: 'without', minutes: 10 }))];
    expect(summarize(rows(7, 12)).limits.passingMedian).toBe(false);
    expect(summarize(rows(8, 11)).limits.passingMedian).toBe(false);
    expect(summarize(rows(8, 11.01)).limits.passingMedian).toBe(true);
  });
  it('uses rates, at least twenty each and three deadline errors, with strict doubling', () => {
    const rows = (n: number, a: number, m: number, b: number) => [...Array.from({ length: n }, (_, i) => row(0, { outcome: i < a ? 'error' : 'success', errorStep: 'deadline:unit-first' })), ...Array.from({ length: m }, (_, i) => row(0, { group: 'without', outcome: i < b ? 'error' : 'success', errorStep: 'deadline:total' }))];
    for (const args of [[100, 5, 20, 2], [19, 3, 20, 0], [20, 2, 20, 0], [20, 4, 20, 2]]) expect(summarize(rows(...args as [number, number, number, number])).limits.deadlineRate).toBe(false);
    expect(summarize(rows(20, 5, 20, 2)).limits.deadlineRate).toBe(true);
  });
  it('requires two daily evaluations with new observations; manual evaluation does not advance it', () => {
    const h = harness(); h.store.readSetting('alternate'); add(h, 8, { ...passed, minutes: 12 }); add(h, 8, { ...passed, group: 'without', minutes: 10 });
    let off = 0; const attention: unknown[] = []; const daily = () => h.store.daily(() => { off++; }, (x) => attention.push(x));
    daily(); expect(off).toBe(0); const first = h.store.report('alternate').lastEvaluation;
    h.advance(DAY); daily(); expect(h.store.report('alternate').lastEvaluation).toEqual(first);
    h.store.report('alternate', true); expect(h.store.report('alternate').lastEvaluation).toEqual(first);
    h.advance(1); daily(); expect(off).toBe(0);
    h.advance(DAY + 1); add(h, 1, passed); daily(); expect(off).toBe(0);
    h.advance(DAY + 1); add(h, 1, passed); daily(); expect(off).toBe(1); expect(attention).toHaveLength(1);
    expect(h.store.report('off').trial.ended).toBe(true);
    expect(h.restart().report('off').lastEvaluation?.configWritten).toBe(true);
  });
  it('names a failed config write and judges it again without a hold file', () => {
    const h = harness(); h.store.readSetting('alternate'); add(h, 8, { ...passed, minutes: 12 }); add(h, 8, { ...passed, group: 'without', minutes: 10 });
    const notices: any[] = []; const daily = () => h.store.daily(() => { throw new Error('read only'); }, (x) => notices.push(x));
    daily(); h.advance(DAY + 1); add(h, 1, { ...passed, minutes: 12 }); daily();
    expect(notices[0].note).toContain('could not be written'); expect(h.store.report('alternate').trial.ended).toBe(false);
    h.advance(DAY + 1); add(h, 1, passed); daily(); expect(notices).toHaveLength(2);
  });
});

it('strictly validates the one optional record field', () => {
  const valid = { setting: 'alternate', group: 'with', ran: true };
  expect(validFirstPartEvidence(valid)).toBe(true);
  for (const firstPart of [null, [], { ...valid, extra: true }, { ...valid, ran: 1 }, { ...valid, group: 'other' }, { ...valid, setting: 'sometimes' }]) {
    expect(validFirstPartEvidence(firstPart)).toBe(false);
    const result = validateRecord({ firstPart }); expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain('firstPart');
  }
});


it('episodes retain commit numbers, known groups and every kind of unknown', () => {
  const record = (pr: number, ran: boolean) => ({ pr, outcome: 'success', finishedAt: new Date(0).toISOString(), firstPart: { setting: 'alternate', group: 'with', ran } }) as never;
  const episode = redMainEpisode('red', 'green', 1000, [
    { head: 'a', message: 'fix (#1)' }, { head: 'b', message: 'Merge pull request #2 from x' },
    { head: 'c', message: 'fix (#3)' }, { head: 'd', message: 'release' },
  ], [record(1, true), record(2, false)]);
  expect(episode.commits.map((c) => [c.pr, c.firstParts])).toEqual([[1, 'yes'], [2, 'no'], [3, 'unknown'], [null, 'unknown']]);
  expect(redMainEpisode('r', null, 1000, null, []).historyUnknown).toBe(true);
});

it.each(['with', 'without'] as const)('accepts the exact one-third suspect boundary in %s, but not above it', (group) => {
  const h = harness(); h.store.readSetting('alternate');
  add(h, 6, { group }); add(h, 2, { group: group === 'with' ? 'without' : 'with' });
  expect(h.store.report('alternate', true).open).toBe(1);
  const other = harness(); other.store.readSetting('alternate');
  add(other, 6, { group }); add(other, 3, { group: group === 'with' ? 'without' : 'with' });
  expect(other.store.report('alternate', true).open).toBe(0);
});

it('a deadline limit stops only after its second daily evaluation with new rows', () => {
  const h = harness(); h.store.readSetting('alternate');
  add(h, 3, { outcome: 'error', errorStep: 'deadline:unit' }); add(h, 17, { outcome: 'success' });
  add(h, 20, { group: 'without', outcome: 'success' });
  let stopped = 0; const daily = () => h.store.daily(() => { stopped++; }, () => {});
  daily(); expect(stopped).toBe(0);
  h.advance(DAY + 1); add(h, 1, { outcome: 'success' }); daily(); expect(stopped).toBe(1);
});


it.each(['damaged middle line', 'read error'])('preserves other log rows after a %s', (fault) => {
  const h = harness(); h.store.readSetting('alternate'); add(h, 2);
  const before = h.store.rows();
  if (fault === 'damaged middle line') {
    const lines = fs.readFileSync(h.store.log, 'utf8').split('\n');
    lines.splice(2, 0, '{damaged'); fs.writeFileSync(h.store.log, lines.join('\n'));
    add(h, 1);
    expect(h.audit).toHaveBeenCalledWith({ event: 'first-part-observations-unreadable', damagedLines: 1 });
  } else {
    const read = fs.readFileSync;
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((file: any, ...args: any[]) => {
      if (file === h.store.log) throw Object.assign(new Error('temporary I/O failure'), { code: 'EIO' });
      return (read as any)(file, ...args);
    }) as any);
    try { add(h, 1); } finally { spy.mockRestore(); }
  }
  expect(h.store.rows().slice(0, before.length)).toEqual(before);
  expect(h.store.rows()).toHaveLength(before.length + 1);
});

it('audits a cost stop once and the ladder harm measure reads that event', () => {
  const h = harness(); h.store.readSetting('alternate');
  add(h, 8, { outcome: 'success', minutes: 12 }); add(h, 8, { outcome: 'success', group: 'without', minutes: 10 });
  const off = vi.fn(); h.store.daily(off, () => {});
  h.advance(DAY + 1); add(h, 1, { outcome: 'success', minutes: 12 }); h.store.daily(off, () => {});
  h.advance(DAY + 1); h.store.daily(off, () => {});
  const events = h.audit.mock.calls.map(([e]) => e).filter((e) => e.event === 'first-part-cost-limit');
  expect(events).toEqual([expect.objectContaining({ limits: ['passingMedian'], configWritten: true,
    groups: expect.objectContaining({ with: expect.objectContaining({ passes: 9 }), without: expect.objectContaining({ passes: 8 }) }) })]);
  const ladder = JSON.parse(fs.readFileSync(new URL('../../../src/data/feature-ladders.json', import.meta.url), 'utf8'));
  const feature = ladder.entries.find((f: any) => f.id === 'local-verify-likely-failing-first');
  expect(feature.rungs['dev-agent-live'].metrics.find((m: any) => m.role === 'harm').ref.where.event).toBe(events[0].event);
  expect(h.store.report('off').markers.map((m) => m.reason)).toEqual(['setting', 'limit']);
});

it('reports requested and setting markers with their values and times', () => {
  const h = harness(); h.store.readSetting('alternate'); h.advance(1); h.store.marker('alternate');
  expect(h.store.report('alternate').markers).toEqual([
    expect.objectContaining({ old: null, setting: 'alternate', reason: 'setting', at: h.now() - 1 }),
    expect.objectContaining({ old: 'alternate', setting: 'alternate', reason: 'requested', at: h.now() }),
  ]);
});

it('uses the latest finding in its conclusion and counts without log reads', () => {
  const h = harness(); h.store.readSetting('alternate'); add(h, 4); h.store.evaluate();
  expect(h.store.report('alternate').conclusion).toContain('not proof');
  h.store.finding({ suspect: 'tests/unit/x.test.ts', finding: 'confirmed', reason: '' });
  expect(h.store.report('alternate').conclusion).toContain('Confirmed');
  h.store.finding({ suspect: 'tests/unit/x.test.ts', finding: 'explained', reason: '' });
  expect(h.store.report('alternate').conclusion).not.toContain('Confirmed');
  const read = vi.spyOn(fs, 'readFileSync').mockImplementation(() => { throw new Error('must not read'); });
  try { expect(h.store.counts()).toEqual({ open: 0, overdue: 0 }); } finally { read.mockRestore(); }
});

it('attributes a revert to its trailing squash PR number', () => {
  expect(redMainEpisode('red', 'green', 1, [{ head: 'c', message: 'Revert "fix (#12)" (#15)' }], []).commits[0].pr).toBe(15);
});

it('findings use start time even when an old verify finishes after the next marker', () => {
  const h = harness(); h.store.readSetting('alternate'); add(h, 4);
  h.store.evaluate(); const trial = h.store.report('alternate').trial.id;
  const startedAt = h.now(); h.advance(1); h.store.marker('alternate'); h.advance(1);
  add(h, 1, { startedAt, pr: 999 });
  h.store.finding({ trial, suspect: 'tests/unit/x.test.ts', finding: 'explained', reason: '' });
  expect(h.store.report('alternate').suspects[0].findings[0].prs.with).toContain(999);
});

it('green saves only an episode transition', () => {
  const h = harness(); h.store.episode({ redHead: 'r', lastGreenHead: null, at: h.now(), historyUnknown: true, commits: [] });
  const write = vi.spyOn(fs, 'writeFileSync');
  try { h.store.green(); h.store.green(); expect(write).toHaveBeenCalledTimes(1); } finally { write.mockRestore(); }
});
