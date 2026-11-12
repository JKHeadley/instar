/**
 * launchIntentEvidence — the dev-rung graduation counter for the job launch mechanism
 * (docs/specs/job-launch-intent-record.md, Maturation plan → graduation criterion; Decision points
 * touched → "Mechanism graduation verdict", a judgment-candidate whose conservative default is
 * NOT graduated).
 *
 * This is the FLOOR the review model reads, never an authority: it turns run rows and
 * `jobs.launchIntent` feature-evidence rows into the counts the spec names, and says `pass` only
 * when every count is met. Too little evidence is `unknown`, never `pass`.
 *
 * Precedence: any `error` record fails; then a main-path violation fails; then too few counted
 * runs is `unknown`; then a known-version shortfall fails; otherwise pass.
 */

import { clampThinkingMode, expectedThinkingModeApplied } from '../core/frameworkSessionLaunch.js';

export const LAUNCH_INTENT_FEATURE_ID = 'jobs.launchIntent';
/** Share of launch-carrying rows that must show a known cliVersion. */
export const LAUNCH_KNOWN_VERSION_FLOOR = 0.9;

export interface LaunchGraduationVerdict {
  verdict: 'pass' | 'fail' | 'unknown';
  reasons: string[];
}

export interface LaunchGraduationOptions {
  /** The dev-rung job that sets the field (D8). */
  jobSlug: string;
  /** The neutral thinkingMode it sets. */
  expectedValue: string;
  /** Counted runs needed for a verdict (40 in the spec). */
  minRuns: number;
  /** Feature-evidence rows as the log stores them. */
  evidence?: unknown[];
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * Main-path rows: not a script run, not a triage session, not a spawn error.
 * Legacy `execute.type: script` runs (JobScheduler.runScriptJob) carry no `runner`
 * field; their session name is always `script-<slug>-<ts>`, so that marks them too.
 */
function isMainPath(row: Rec): boolean {
  if (row.runner === 'script') return false;
  if (typeof row.sessionId === 'string' && row.sessionId.startsWith('script-')) return false;
  return row.origin !== 'triage' && row.result !== 'spawn-error';
}

export function evaluateLaunchMechanismGraduation(runs: unknown[], opts: LaunchGraduationOptions): LaunchGraduationVerdict {
  const evidence = arr(opts.evidence).filter(isRec).filter((e) => e.featureId === LAUNCH_INTENT_FEATURE_ID);
  const errors = evidence.filter((e) => e.kind === 'error');
  if (errors.length > 0) {
    return { verdict: 'fail', reasons: [`${errors.length} ${LAUNCH_INTENT_FEATURE_ID} error record(s): a launch record could not be built`] };
  }
  const firedRunIds = new Set<string>();
  for (const e of evidence) {
    if (e.kind !== 'fired' || !isRec(e.context)) continue;
    const runId = e.context.runId;
    if (typeof runId === 'string' && runId) firedRunIds.add(runId);
  }

  const mode = clampThinkingMode(opts.expectedValue).mode;
  const violations: string[] = [];
  let counted = 0;
  let withLaunch = 0;
  let knownVersion = 0;

  for (const row of runs.filter(isRec)) {
    const launch = isRec(row.launch) ? row.launch : undefined;
    if (launch) {
      withLaunch++;
      if (typeof launch.cliVersion === 'string' && launch.cliVersion && launch.cliVersion !== 'unknown') knownVersion++;
    }
    if (!isMainPath(row)) continue;
    const id = typeof row.runId === 'string' ? row.runId : '?';
    if (!launch) {
      // `truncated: true` is the row cap's marker; it is the only excuse for a missing launch.
      if (row.truncated !== true) violations.push(`main-path run ${id} (${String(row.slug)}) has no launch record`);
      continue;
    }
    const applied = arr(launch.applied);
    const dropped = arr(launch.dropped);
    if (row.slug !== opts.jobSlug) {
      if (applied.length > 0 || dropped.length > 0) {
        violations.push(`run ${id} of ${String(row.slug)} shows a non-empty launch (applied ${applied.length}, dropped ${dropped.length})`);
      }
      continue;
    }
    if (!mode || dropped.length > 0 || !firedRunIds.has(id)) continue;
    const expected = typeof row.framework === 'string' ? expectedThinkingModeApplied(row.framework, mode) : null;
    if (!expected) continue;
    const match = applied.some((a) => isRec(a) && a.feature === 'thinkingMode' && a.requestedValue === mode
      && a.value === expected.value && a.channel === expected.channel);
    if (match) counted++;
  }

  if (violations.length > 0) return { verdict: 'fail', reasons: violations.slice(0, 20) };
  if (counted < opts.minRuns) {
    return { verdict: 'unknown', reasons: [`${counted} of ${opts.minRuns} needed ${opts.jobSlug} runs show thinkingMode ${opts.expectedValue} applied with a matching fired record`] };
  }
  const share = withLaunch > 0 ? knownVersion / withLaunch : 0;
  if (share < LAUNCH_KNOWN_VERSION_FLOOR) {
    return { verdict: 'fail', reasons: [`known cliVersion on ${knownVersion} of ${withLaunch} launch rows (${Math.round(share * 1000) / 10}%), below 90%`] };
  }
  return { verdict: 'pass', reasons: [] };
}
