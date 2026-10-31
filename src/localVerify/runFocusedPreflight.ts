/** Bounded, diagnostic-only affected-test check in a verifier's synthetic merge tree. */
import path from 'node:path';
import type { OrchestratorSeams } from './orchestrator.js';
import type { PreflightEvidence } from './record.js';
import { readUnhandledErrors } from './unhandledErrorsReporter.js';
import { parsePreflightList, preflightAssertionFailures, preflightBreadth, PREFLIGHT_LIMITS, repeatedFailedFile } from './preflight.js';

export class PreflightCleanupError extends Error {}

export interface FocusedPreflightInput {
  seams: OrchestratorSeams;
  runDir: string;
  reportsDir: string;
  binDir: string;
  baseEnv: NodeJS.ProcessEnv;
  baseSha: string;
  headSha: string;
  mode: 'observe' | 'enforce';
  changedFiles: number;
  reporter: string | null;
  /** The parent active-work clock, already extended by exactly 90 seconds. */
  activeRemainingMs(): number;
  onPid(pid: number): void;
}

export async function runFocusedPreflight(i: FocusedPreflightInput): Promise<PreflightEvidence> {
  const { seams, runDir, reportsDir, binDir } = i;
  const t0 = seams.now();
  const evidence: PreflightEvidence = {
    mode: i.mode, outcome: 'skip', reason: 'indeterminate', elapsedMs: 0,
    changedFiles: Math.min(i.changedFiles, 10_000), selectedFiles: [], selectedCases: 0,
    headSha: i.headSha, baseSha: i.baseSha,
  };
  const artifacts: string[] = [];
  const finish = (outcome: PreflightEvidence['outcome'], reason: string): PreflightEvidence => {
    evidence.outcome = outcome;
    evidence.reason = reason;
    evidence.elapsedMs = Math.min(PREFLIGHT_LIMITS.totalMs, Math.max(0, seams.now() - t0));
    return evidence;
  };
  const deadline = () => Math.min(
    PREFLIGHT_LIMITS.totalMs - (seams.now() - t0) - PREFLIGHT_LIMITS.teardownReserveMs,
    i.activeRemainingMs() - PREFLIGHT_LIMITS.teardownReserveMs,
  );
  const step = async (name: string, args: string[], report: string, withReporter = false) => {
    const ms = deadline();
    if (ms <= 0) return { status: null, timeout: true };
    artifacts.push(report);
    const temp = seams.fs.mkdtemp('lv-tmp-');
    const tmux = seams.fs.mkdtemp('lv-tmux-');
    const errors = `${report}.errors.json`;
    if (withReporter) artifacts.push(errors);
    const env = { ...i.baseEnv, TMPDIR: temp, TMUX_TMPDIR: tmux,
      ...(withReporter && i.reporter ? { LOCAL_VERIFY_UNHANDLED_ERRORS_FILE: errors } : {}) };
    let r;
    try {
      r = await seams.exec(path.join(binDir, 'vitest'), args, {
        cwd: runDir, env, deadlineMs: Math.max(1, ms), isolatedGroup: true, onPid: i.onPid,
      });
    } finally {
      // A failed temp cleanup leaves a possible test side effect: do not start full lanes.
      try { await seams.fs.removeTree(temp); await seams.fs.removeTree(tmux); }
      catch (e) { throw new PreflightCleanupError(`${name}: temporary files could not be removed: ${String(e)}`); }
    }
    if (r.quiescent !== true) throw new PreflightCleanupError(`${name}: process group did not exit`);
    return { status: r.status, timeout: r.deadlineKilled, report: seams.fs.readFile(report), errors: withReporter && i.reporter ? readUnhandledErrors(seams.fs.readFile(errors)) : null };
  };
  try {
    const changedCap = preflightBreadth(i.changedFiles, 1, 1);
    if (changedCap) return finish('skip', changedCap);
    const filesReport = path.join(reportsDir, 'preflight-files.json');
    const listedFiles = await step('files-list', ['list', '--filesOnly', '--config', 'vitest.push.config.ts', '--changed', i.baseSha, `--json=${filesReport}`], filesReport);
    if (listedFiles.timeout) return finish('timeout', 'files-list-timeout');
    if (listedFiles.status !== 0) return finish('skip', 'files-list-failed');
    const files = parsePreflightList(listedFiles.report ?? null, runDir, true);
    if (!files) return finish('skip', 'files-list-invalid');
    if (files.files.length > PREFLIGHT_LIMITS.testFiles) return finish('skip', 'selected-files-cap');
    evidence.selectedFiles = files.files;
    if (!files.files.length) return finish('skip', 'no-selected-tests');

    const casesReport = path.join(reportsDir, 'preflight-cases.json');
    const listedCases = await step('case-list', ['list', '--config', 'vitest.push.config.ts', '--changed', i.baseSha, `--json=${casesReport}`], casesReport);
    if (listedCases.timeout) return finish('timeout', 'case-list-timeout');
    if (listedCases.status !== 0) return finish('skip', 'case-list-failed');
    const cases = parsePreflightList(listedCases.report ?? null, runDir, false);
    if (!cases) return finish('skip', 'case-list-invalid');
    evidence.selectedCases = Math.min(cases.cases, 10_000);
    if (cases.files.join('\n') !== files.files.join('\n')) return finish('skip', 'selection-mismatch');
    const breadth = preflightBreadth(i.changedFiles, files.files.length, cases.cases);
    if (breadth) return finish('skip', breadth);

    const firstReport = path.join(reportsDir, 'preflight-first.json');
    const first = await step('first-run', ['run', '--config', 'vitest.push.config.ts', '--changed', i.baseSha, '--allowOnly=false', '--reporter=json', ...(i.reporter ? [`--reporter=${i.reporter}`] : []), `--outputFile.json=${firstReport}`], firstReport, true);
    if (first.timeout) return finish('timeout', 'first-run-timeout');
    const firstFailed = preflightAssertionFailures(first.report ?? null, runDir, files.files);
    if (!firstFailed) return finish('error', 'first-report-indeterminate');
    if (first.status === 0 && firstFailed.length === 0) return finish('pass', 'first-run-green');
    if (first.status === 0 || firstFailed.length === 0) return finish('error', 'first-status-report-mismatch');
    if (first.errors !== 0) return finish('error', 'first-unhandled-unknown-or-nonzero');

    const retryReport = path.join(reportsDir, 'preflight-retry.json');
    const retry = await step('retry', ['run', '--config', 'vitest.push.config.ts', '--allowOnly=false', '--reporter=json', ...(i.reporter ? [`--reporter=${i.reporter}`] : []), `--outputFile.json=${retryReport}`, ...firstFailed], retryReport, true);
    if (retry.timeout) return finish('timeout', 'retry-timeout');
    const retryFailed = preflightAssertionFailures(retry.report ?? null, runDir, firstFailed);
    if (!retryFailed) return finish('error', 'retry-report-indeterminate');
    if (retry.status === 0 && retryFailed.length === 0) return finish('pass', 'retry-green');
    if (retry.status === 0 || retryFailed.length === 0) return finish('error', 'retry-status-report-mismatch');
    const repeated = repeatedFailedFile(firstFailed, retryFailed, first.errors ?? null, retry.errors ?? null);
    if (!repeated) return finish('error', 'not-stable-assertion-red');
    evidence.repeatedFailedFile = repeated;
    return finish('red', i.mode === 'enforce' ? 'preflight-red' : 'observed-stable-red');
  } finally {
    for (const artifact of artifacts) {
      try { await seams.fs.removeTree(artifact); }
      catch (e) { throw new PreflightCleanupError(`report cleanup failed: ${String(e)}`); }
    }
    const elapsed = Math.max(0, seams.now() - t0);
    evidence.elapsedMs = Math.min(PREFLIGHT_LIMITS.totalMs, elapsed);
    if (elapsed > PREFLIGHT_LIMITS.totalMs) {
      evidence.outcome = 'timeout';
      evidence.reason = 'aggregate-timeout';
      delete evidence.repeatedFailedFile;
    }
  }
}
