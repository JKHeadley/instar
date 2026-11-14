/**
 * T13 (frozen acceptance list, step3/acceptance-tests.md): the console run-history reader
 * ignores the new `launch` key (spec job-launch-intent-record, Testing → Surface; D5 "readers
 * must tolerate values they don't know"). Green on main: a regression guard.
 *
 * The console sheet (dashboard/console/schedule.js:195) fetches GET /jobs/:slug/history and
 * hands the answer to `buildHistory` / `medianDurations` / `markText` in schedule-model.js.
 * Those pure functions are the reader under test.
 */
import { describe, it, expect } from 'vitest';
import { buildHistory, medianDurations, markText, buildSchedulePage } from '../../dashboard/console/schedule-model.js';

const NOW = Date.parse('2026-11-11T12:00:00Z');
const ok = (data: unknown) => ({ ok: true, data });
const minsAgo = (m: number) => new Date(NOW - m * 60000).toISOString();

const LAUNCH = {
  cliVersion: '2.1.322',
  requested: { thinkingMode: 'low' },
  applied: [{ feature: 'thinkingMode', requestedValue: 'low', value: 'low', channel: 'argv' }],
  dropped: [{ feature: 'thinkingMode', reason: 'some-future-reason' }],
  omitted: 0,
};

type Row = Record<string, unknown>;
const baseRows = (): Row[] => [
  { runId: 'r1', slug: 'bugs-overseer', sessionId: 's1', trigger: 'scheduled', startedAt: minsAgo(30), completedAt: minsAgo(25), durationSeconds: 300, result: 'success', framework: 'claude-code', model: 'opus' },
  { runId: 'r2', slug: 'bugs-overseer', sessionId: 's2', trigger: 'manual', startedAt: minsAgo(90), completedAt: minsAgo(88), durationSeconds: 120, result: 'failure', error: 'boom', framework: 'gemini-cli', model: 'x' },
  { runId: 'r3', slug: 'bugs-overseer', sessionId: 's3', trigger: 'scheduled', startedAt: minsAgo(2), result: 'pending' },
];
const withLaunch = (): Row[] => baseRows().map((r) => ({ ...r, launch: structuredClone(LAUNCH) }));

// Everything the reader derives, minus the raw `record` pass-through (which carries the row as-is).
function derived(h: ReturnType<typeof buildHistory>) {
  return {
    ok: h.ok, reason: h.reason, total: h.total, notes: h.notes,
    marks: h.marks.map((m: Record<string, unknown>) => { const { record: _r, ...rest } = m; return rest; }),
    text: h.marks.map((m: Parameters<typeof markText>[0]) => markText(m, NOW)),
  };
}

describe('T13 console history reader ignores `launch`', () => {
  it('buildHistory derives identical marks with and without `launch` on every row', () => {
    const skips = ok({ events: [] });
    const a = buildHistory(ok({ runs: baseRows(), total: 3 }), skips, NOW);
    const b = buildHistory(ok({ runs: withLaunch(), total: 3 }), skips, NOW);
    expect(b.ok).toBe(true);
    expect(derived(b)).toEqual(derived(a));
  });

  it('no mark text mentions launch, thinking mode or the CLI version', () => {
    const h = buildHistory(ok({ runs: withLaunch(), total: 3 }), ok({ events: [] }), NOW);
    for (const m of h.marks) {
      const t = markText(m, NOW);
      expect(t).not.toMatch(/launch|thinking|2\.1\.322|applied|dropped/i);
    }
  });

  it('tolerates unknown enum values and odd shapes inside `launch` without throwing', () => {
    const odd: Row[] = baseRows().map((r, i) => ({ ...r, launch: [null, 'string', { applied: 'not-an-array', dropped: 7, cliVersion: 42 }][i] }));
    expect(() => buildHistory(ok({ runs: odd, total: 3 }), null, NOW)).not.toThrow();
    const h = buildHistory(ok({ runs: odd, total: 3 }), null, NOW);
    expect(h.marks.map((m: { kind: string }) => m.kind)).toEqual(['pending', 'success', 'failure']);
  });

  it('medianDurations is unchanged by `launch`', () => {
    expect(medianDurations(ok({ runs: withLaunch() }))).toEqual(medianDurations(ok({ runs: baseRows() })));
  });

  it('the schedule page built from /jobs/history ignores `launch` too', () => {
    const job = { slug: 'bugs-overseer', name: 'Bugs overseer', description: 'd', schedule: '0 * * * *', priority: 'medium', expectedDurationMinutes: 5, model: 'opus', enabled: true,
      execute: { type: 'prompt', value: 'x' }, origin: 'user', hasUserFork: false, runsOnThisMachine: true,
      state: { slug: 'bugs-overseer', lastRun: minsAgo(30), lastResult: 'success', nextScheduled: new Date(NOW + 30 * 60000).toISOString(), consecutiveFailures: 0 } };
    const res = (runs: Row[]) => ({
      local: ok({ jobs: [job], queue: [] }),
      pool: ok({ jobs: [{ ...job, machineId: 'm1' }], count: 1, pool: { enabled: true, selfMachineId: 'm1', peersQueried: 1, peersOk: 1, failed: [] } }),
      history: ok({ runs, total: runs.length, stats: [] }),
      migration: ok({ hasLegacyJobsJson: false, hasMigrationComplete: true, hasMigrationAbandoned: false, canConfirm: false, canAbandon: false, scheduleEntryCount: 0 }),
      reconcile: ok({ findings: [], summary: { total: 0, byKind: {} } }),
    });
    expect(JSON.stringify(buildSchedulePage(res(withLaunch()), NOW))).toBe(JSON.stringify(buildSchedulePage(res(baseRows()), NOW)));
  });
});
