/**
 * T12 (frozen acceptance list, step3/acceptance-tests.md): the dev-rung graduation counter for
 * the launch mechanism (spec job-launch-intent-record, Maturation plan → graduation criterion;
 * "Decision points touched" → Mechanism graduation verdict, conservative default not graduated).
 *
 * Contract fixed here (the spec names the counts, not the module):
 *   src/scheduler/launchIntentEvidence.ts exports
 *   evaluateLaunchMechanismGraduation(runs, { jobSlug, expectedValue, minRuns, evidence? })
 *     → { verdict: 'pass' | 'fail' | 'unknown', reasons: string[] }
 *   - runs: JobRun rows as GET /jobs/:slug/history returns them (any slug).
 *   - evidence: FeatureEvidenceRow objects as the feature-evidence log stores them
 *     ({ featureId, kind: 'fired' | 'error' | ..., reason, context }). Only featureId
 *     'jobs.launchIntent' counts. A `fired` record names its run in `context.runId`.
 *   - A counted run: row.slug === jobSlug, launch.applied has a thinkingMode entry whose
 *     requestedValue === expectedValue AND whose native value/channel is the launched engine's
 *     (row.framework) mapping of it: claude-code off → {MAX_THINKING_TOKENS=0, env}, other modes →
 *     {mode, argv}; codex-cli off/low → low, max → xhigh, others → mode, all argv; any other
 *     engine never counts. launch.dropped is empty, AND a jobs.launchIntent `fired`
 *     record with context.runId === row.runId exists. A run with no correlated `fired` is not counted.
 *   - Main-path rows are rows that are not script (runner 'script'), triage (origin 'triage') or
 *     spawn-error (result 'spawn-error'). Every other slug's main-path row must carry `launch` with
 *     empty applied and dropped. A main-path row (any slug) with NO `launch` is a violation unless
 *     it carries the row-level cap marker `truncated: true`.
 *     KNOWN LIMIT: `truncated: true` only says the row cap shed SOMETHING; it cannot prove that
 *     `launch` was among the shed fields (a row that shed only outputSummary would also be
 *     excused). The row carries no per-field shed record today, so the evaluator cannot tell;
 *     the unit cap test (T6) is what proves launch is shed only after the other optional fields.
 *   - Any jobs.launchIntent `error` record → fail. Main-path violation → fail.
 *   - Counted runs < minRuns → unknown (never pass).
 *   - Known cliVersion (not 'unknown') on < 90% of rows that carry `launch` → fail.
 *   - Otherwise pass. `reasons` is non-empty for every non-pass verdict.
 * Red on main: the module does not exist.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MOD = path.join(ROOT, 'src/scheduler/launchIntentEvidence.ts');
type Verdict = { verdict: 'pass' | 'fail' | 'unknown'; reasons: string[] };
type Fn = (runs: unknown[], opts: { jobSlug: string; expectedValue: string; minRuns: number; evidence?: unknown[] }) => Verdict;

async function load(): Promise<Fn> {
  let mod: Record<string, unknown>;
  try {
    mod = await import(/* @vite-ignore */ MOD);
  } catch (e) {
    expect.fail(`module missing: src/scheduler/launchIntentEvidence.ts (${(e as Error).message.split('\n')[0]})`);
  }
  expect(typeof mod.evaluateLaunchMechanismGraduation, 'evaluateLaunchMechanismGraduation is not exported').toBe('function');
  return mod.evaluateLaunchMechanismGraduation as Fn;
}

const JOB = 'bugs-overseer';
const OPTS = { jobSlug: JOB, expectedValue: 'low', minRuns: 40 };
let n = 0;
const applied = (over: { cliVersion?: string; slug?: string } = {}) => ({
  runId: `r${n++}`, slug: over.slug ?? JOB, trigger: 'scheduled', result: 'success', framework: 'claude-code', model: 'opus', startedAt: '2026-11-12T00:00:00Z',
  launch: { cliVersion: over.cliVersion ?? '2.1.322', requested: { thinkingMode: 'low' }, applied: [{ feature: 'thinkingMode', requestedValue: 'low', value: 'low', channel: 'argv' }], dropped: [] },
});
const dropped = (reason: string) => ({
  runId: `r${n++}`, slug: JOB, trigger: 'scheduled', result: 'success', framework: 'gemini-cli', model: 'x', startedAt: '2026-11-12T00:00:00Z',
  launch: { cliVersion: '1.0.0', requested: { thinkingMode: 'low' }, applied: [], dropped: [{ feature: 'thinkingMode', requestedValue: 'low', reason }] },
});
const otherEmpty = (slug = 'git-sync') => ({
  runId: `r${n++}`, slug, trigger: 'scheduled', result: 'success', framework: 'claude-code', model: 'haiku', startedAt: '2026-11-12T00:00:00Z',
  launch: { cliVersion: '2.1.322', requested: {}, applied: [], dropped: [] },
});
const many = <T>(k: number, f: () => T) => Array.from({ length: k }, f);
/** The jobs.launchIntent `fired` record the scheduler writes for one run. */
const fired = (runId: string, featureId = 'jobs.launchIntent') => ({ eventId: `e-${runId}`, at: '2026-11-12T00:00:00Z', featureId, kind: 'fired', reason: 'launch-recorded', context: { runId } });
const errorRec = (reason = 'launch record could not be built') => ({ eventId: `e-err-${n++}`, at: '2026-11-12T00:00:00Z', featureId: 'jobs.launchIntent', kind: 'error', reason, context: {} });
/** Correlated evidence for every row given. */
const ev = (rows: Array<{ runId: string }>) => rows.map((r) => fired(r.runId));
/** Evaluate with fired evidence for every row passed (the normal, fully-instrumented case). */
const withEv = (f: Fn, runs: Array<{ runId: string }>, extra: unknown[] = []) => f(runs, { ...OPTS, evidence: [...ev(runs), ...extra] });

describe('T12 evaluateLaunchMechanismGraduation', () => {
  it('40 applied-low runs with correlated fired evidence, clean neighbours, all versions known → pass', async () => {
    const f = await load();
    const r = withEv(f, [...many(40, () => applied()), ...many(20, () => otherEmpty())]);
    expect(r.verdict).toBe('pass');
    expect(r.reasons).toEqual([]);
  });

  it('without any fired evidence nothing counts → unknown, never pass', async () => {
    const f = await load();
    const runs = many(45, () => applied());
    expect(f(runs, OPTS).verdict).toBe('unknown');
    expect(f(runs, { ...OPTS, evidence: [] }).verdict).toBe('unknown');
  });

  it('a run counts only with a fired record naming ITS runId', async () => {
    const f = await load();
    const runs = many(40, () => applied());
    // 39 correlated + 1 fired record for a run id that is not in the window.
    const evidence = [...ev(runs.slice(0, 39)), fired('some-other-run')];
    expect(f(runs, { ...OPTS, evidence }).verdict).toBe('unknown');
    // A fired record for the right run but another feature does not count either.
    const wrongFeature = [...ev(runs.slice(0, 39)), fired(runs[39].runId, 'jobs.toolAllowlistEnforcement')];
    expect(f(runs, { ...OPTS, evidence: wrongFeature }).verdict).toBe('unknown');
    // Uncorrelated fired records (no runId) do not count.
    const noRunId = [...ev(runs.slice(0, 39)), { ...fired('x'), context: {} }];
    expect(f(runs, { ...OPTS, evidence: noRunId }).verdict).toBe('unknown');
  });

  it('fewer than 40 counted runs → unknown, never pass', async () => {
    const f = await load();
    const r = withEv(f, many(39, () => applied()));
    expect(r.verdict).toBe('unknown');
    expect(r.reasons.length).toBeGreaterThan(0);
    expect(f([], { ...OPTS, evidence: [] }).verdict).toBe('unknown');
  });

  it('dropped or overridden runs do not count toward the 40', async () => {
    const f = await load();
    const runs = [...many(38, () => applied()), dropped('not-supported'), dropped('overridden-by-effort-pin'), dropped('invalid')];
    expect(withEv(f, runs).verdict).toBe('unknown');
  });

  it('applied with a different REQUESTED value does not count', async () => {
    const f = await load();
    const medium = () => { const r = applied(); r.launch.applied[0].requestedValue = 'medium'; r.launch.applied[0].value = 'medium'; r.launch.requested.thinkingMode = 'medium'; return r; };
    expect(withEv(f, [...many(39, () => applied()), medium()]).verdict).toBe('unknown');
  });

  it('requested low but a different NATIVE value applied does not count (claude-code needs --effort low)', async () => {
    const f = await load();
    const wrongNative = () => { const r = applied(); r.launch.applied[0].value = 'high'; return r; };
    expect(withEv(f, [...many(39, () => applied()), wrongNative()]).verdict).toBe('unknown');
    const wrongChannel = () => { const r = applied(); (r.launch.applied[0] as { channel: string }).channel = 'env'; return r; };
    expect(withEv(f, [...many(39, () => applied()), wrongChannel()]).verdict).toBe('unknown');
  });

  it('the mapping follows the launched engine (row.framework)', async () => {
    const f = await load();
    const as = (framework: string, requestedValue: string, value: string, channel = 'argv') => {
      const r = applied(); r.framework = framework;
      r.launch.requested.thinkingMode = requestedValue;
      r.launch.applied[0] = { feature: 'thinkingMode', requestedValue, value, channel };
      return r;
    };
    // codex-cli: low → low counts.
    expect(withEv(f, many(40, () => as('codex-cli', 'low', 'low'))).verdict).toBe('pass');
    // codex-cli: max → xhigh counts; a literal "max" sent to codex does not.
    const max = { ...OPTS, expectedValue: 'max' };
    expect(f(many(40, () => as('codex-cli', 'max', 'xhigh')), { ...max, evidence: [] }).verdict).toBe('unknown'); // no evidence yet
    const good = many(40, () => as('codex-cli', 'max', 'xhigh'));
    expect(f(good, { ...max, evidence: ev(good) }).verdict).toBe('pass');
    const bad = [...many(39, () => as('codex-cli', 'max', 'xhigh')), as('codex-cli', 'max', 'max')];
    expect(f(bad, { ...max, evidence: ev(bad) }).verdict).toBe('unknown');
    // codex-cli: off → low counts.
    const off = { ...OPTS, expectedValue: 'off' };
    const codexOff = many(40, () => as('codex-cli', 'off', 'low'));
    expect(f(codexOff, { ...off, evidence: ev(codexOff) }).verdict).toBe('pass');
    // claude-code: off rides the env channel; an argv "off" does not count.
    const claudeOff = many(40, () => as('claude-code', 'off', 'MAX_THINKING_TOKENS=0', 'env'));
    expect(f(claudeOff, { ...off, evidence: ev(claudeOff) }).verdict).toBe('pass');
    const claudeOffBad = [...many(39, () => as('claude-code', 'off', 'MAX_THINKING_TOKENS=0', 'env')), as('claude-code', 'off', 'off')];
    expect(f(claudeOffBad, { ...off, evidence: ev(claudeOffBad) }).verdict).toBe('unknown');
    // An engine with no native setting never counts, even if a row claims applied.
    const gem = [...many(39, () => applied()), as('gemini-cli', 'low', 'low')];
    expect(withEv(f, gem).verdict).not.toBe('pass');
  });

  it('other jobs’ applied-low rows do not count toward the target job', async () => {
    const f = await load();
    const r = withEv(f, [...many(39, () => applied()), applied({ slug: 'other-job' })]);
    expect(r.verdict).not.toBe('pass');
  });

  it('any error evidence record fails, even with enough runs', async () => {
    const f = await load();
    const r = withEv(f, many(45, () => applied()), [errorRec()]);
    expect(r.verdict).toBe('fail');
    expect(r.reasons.join(' ')).toMatch(/error/i);
  });

  it('an error record fails even when the run count is short (fail beats unknown)', async () => {
    const f = await load();
    expect(withEv(f, many(5, () => applied()), [errorRec()]).verdict).toBe('fail');
    expect(f([], { ...OPTS, evidence: [errorRec()] }).verdict).toBe('fail');
  });

  it('an error record for another feature is not this feature’s error', async () => {
    const f = await load();
    expect(withEv(f, many(40, () => applied()), [{ ...errorRec(), featureId: 'jobs.toolAllowlistEnforcement' }]).verdict).toBe('pass');
  });

  it('another main-path job showing non-empty applied or dropped fails', async () => {
    const f = await load();
    const leaky = otherEmpty(); (leaky.launch as { dropped: unknown[] }).dropped = [{ feature: 'thinkingMode', reason: 'invalid' }];
    expect(withEv(f, [...many(40, () => applied()), leaky]).verdict).toBe('fail');
    expect(withEv(f, [...many(40, () => applied()), applied({ slug: 'git-sync' })]).verdict).toBe('fail');
  });

  it('a main-path row with NO launch and no truncated marker is a violation (other job or target job)', async () => {
    const f = await load();
    const missing = { runId: 'missing', slug: 'git-sync', trigger: 'scheduled', result: 'success', framework: 'claude-code', startedAt: '2026-11-12T00:00:00Z' };
    const r = withEv(f, [...many(40, () => applied()), missing]);
    expect(r.verdict).toBe('fail');
    expect(r.reasons.join(' ')).toMatch(/launch/i);
    const targetMissing = { ...missing, runId: 'missing-target', slug: JOB };
    expect(withEv(f, [...many(40, () => applied()), targetMissing]).verdict).toBe('fail');
    // truncated: false is not the cap marker.
    expect(withEv(f, [...many(40, () => applied()), { ...missing, runId: 'not-shed', truncated: false }]).verdict).toBe('fail');
  });

  it('a missing-launch violation fails even when the run count is short', async () => {
    const f = await load();
    const missing = { runId: 'missing2', slug: 'git-sync', trigger: 'scheduled', result: 'success', startedAt: '2026-11-12T00:00:00Z' };
    expect(withEv(f, [...many(5, () => applied()), missing]).verdict).toBe('fail');
  });

  it('exempt rows: cap-shed (truncated: true), script, triage and spawn-error rows without launch are tolerated', async () => {
    const f = await load();
    const shed = { runId: 'shed', slug: 'git-sync', trigger: 'scheduled', result: 'success', truncated: true, startedAt: '2026-11-12T00:00:00Z' };
    const shedTarget = { ...shed, runId: 'shed-target', slug: JOB };
    const script = { runId: 'script', slug: 'script-job', trigger: 'scheduled', result: 'success', runner: 'script', startedAt: '2026-11-12T00:00:00Z' };
    const triage = { runId: 'triage', slug: 'git-sync', trigger: 'triage:run-1', result: 'success', origin: 'triage', startedAt: '2026-11-12T00:00:00Z' };
    const spawnErr = { runId: 'spawnerr', slug: JOB, trigger: 'scheduled', result: 'spawn-error', error: 'spawn-error: x', startedAt: '2026-11-12T00:00:00Z' };
    const counted = many(40, () => applied());
    expect(withEv(f, [...counted, shed, shedTarget, script, triage, spawnErr]).verdict).toBe('pass');
  });

  it('unknown versions do not count toward the 90% known', async () => {
    const f = await load();
    // 36 known of 40 = 90% → pass
    expect(withEv(f, [...many(36, () => applied()), ...many(4, () => applied({ cliVersion: 'unknown' }))]).verdict).toBe('pass');
    // 35 known of 40 = 87.5% → fail (the 5 unknown-version runs still count toward the 40)
    const r = withEv(f, [...many(35, () => applied()), ...many(5, () => applied({ cliVersion: 'unknown' }))]);
    expect(r.verdict).toBe('fail');
    expect(r.reasons.join(' ')).toMatch(/version/i);
  });

  it('the 90% is over every row carrying launch, not only the target job', async () => {
    const f = await load();
    const unknownOthers = many(10, () => { const r = otherEmpty(); r.launch.cliVersion = 'unknown'; return r; });
    // 40 known + 10 unknown = 80% known → fail
    expect(withEv(f, [...many(40, () => applied()), ...unknownOthers]).verdict).toBe('fail');
  });
});
