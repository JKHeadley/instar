/**
 * Lane reports and the run predicate for local-verify (spec
 * local-verify-merge-authority.md §2 step 5).
 *
 * `parseVitestJson` reads vitest 2.1.9's `--reporter=json` output (the
 * `JsonTestResults` shape in vitest/dist/reporters.d.ts: `testResults[]` with
 * an absolute `name`, a file `status` and `assertionResults[].status` in
 * passed|failed|skipped|pending|todo|disabled). `evaluateRun` applies the rule
 * set: every inventoried file in exactly one lane report, zero failures, at
 * least one collected test per file, and at least one passed test per gating
 * lane. Only gating lanes count toward success.
 */

import crypto from 'node:crypto';
import { boundedHead, boundedTail } from '../core/boundedInput.js';
import { normalizePath } from './glob.js';
import { LANES, type Inventory, type LaneDefinition, type LaneName } from './inventory.js';
import { IMPORT_RELATED_RERUN } from './policy.js';

/** One named failed test of a failed file (spec local-verify-import-related-rerun.md). Stays in the run child. */
export interface FailedTest {
  /** The full test name, whole (a name over the length bound is never listed). */
  name: string;
  /** The first line of the failure message that names an error, bounded with its disclosure. */
  line: string;
  /** Set when `line` was shortened: the reader opens the full output. */
  lineCut?: true;
  /** The whole first failure message, bounded keeping its end (for the run log's `failure-full` event). */
  full: string;
}

export interface FileCounts {
  passed: number;
  failed: number;
  skipped: number;
  todo: number;
  /** Proven failed assertions; collection/import errors do not count. */
  assertionFailures?: number;
  /** A pending/unknown assertion or file-level failure makes comparison unsafe. */
  nonAssertionFailure?: boolean;
  /** Vitest's file-level message (an import/collect error); '' when none. */
  message?: string;
  /** Wall time of the file in ms (vitest's start/end), when the report carried both. */
  ms?: number;
  /**
   * Failed files only: each failed test with a usable name (1..300 characters), in report order.
   * A failed test with a longer or empty name is NOT here, so `failedTests.length < failed`
   * discloses it. Never written outside the run child except as the bounded record fields.
   */
  failedTests?: FailedTest[];
  /** Failed or solo files: sha256 of the file's full test names in report (definition) order. */
  testSetHash?: string;
  /** Expected full-file outcome after ordinary assertion failures become passes. */
  recoveredOutcomeHash?: string;
  /** Failed files only: a failed test's full name occurs more than once in the file. */
  duplicateFailedName?: boolean;
  /** Failed or solo files: an import/hook error or a file-level message, alone or beside named failures. */
  fileLevelFailure?: boolean;
  /** Solo-run reports only: the full names of the tests reported `passed`. */
  passedTests?: string[];
  /** Solo-run reports only: every test that was not `passed`, with its status (for the failure text). */
  notPassedTests?: Array<{ name: string; status: string }>;
  /**
   * Only with `opts.outcomeDigest`: the file's names-and-outcomes digest (see `outcomeDigest`).
   * Every file of the report gets one, passing or failing.
   */
  outcomeDigest?: string;
}

export interface ParsedLaneReport {
  files: Map<string, FileCounts>;
  completeAndClean?: boolean;
}

/** Bound on a stored failure message (record and audit stay small). */
export const FAILURE_MESSAGE_MAX = 400;

export class LaneReportParseError extends Error {}

/** A test's full name: `fullName` when it is a non-empty string, else the ancestor titles joined with the title. */
export function fullTestName(a: unknown): string {
  if (!a || typeof a !== 'object') return '';
  const x = a as { fullName?: unknown; ancestorTitles?: unknown; title?: unknown };
  if (typeof x.fullName === 'string' && x.fullName) return x.fullName;
  const parts = [...(Array.isArray(x.ancestorTitles) ? x.ancestorTitles : []), x.title].filter((t): t is string => typeof t === 'string' && t.length > 0);
  return parts.join(' ');
}

/**
 * The distinguishing error line of a failure message: its first line that names an error
 * (`AssertionError: …`, `Error: mac-desktop-host-timeout`), else its first non-empty line.
 * Bounded with the disclosing helper; `lineCut` says the stored line is not the whole line.
 */
export function errorLine(message: string): { line: string; lineCut?: true } {
  const lines = message.split('\n').map((l) => l.trim()).filter(Boolean);
  const raw = lines.find((l) => /^(?:[A-Za-z_$][\w$.]*)?(Error|Exception)\b/.test(l)) ?? lines[0] ?? '';
  const line = boundedHead(raw, IMPORT_RELATED_RERUN.lineChars);
  return line === raw ? { line } : { line, lineCut: true };
}

/**
 * Which of the lane-failed test names a solo run reported `passed`, by full name. A name that
 * failed N times needs N passes: fewer and none of its occurrences counts. Pure.
 */
export function passedByName(failed: readonly string[], passed: readonly string[]): { passed: string[]; notPassed: string[] } {
  const count = (list: readonly string[]) => { const m = new Map<string, number>(); for (const n of list) m.set(n, (m.get(n) ?? 0) + 1); return m; };
  const need = count(failed);
  const have = count(passed);
  const out = { passed: [] as string[], notPassed: [] as string[] };
  for (const n of failed) ((have.get(n) ?? 0) >= need.get(n)! ? out.passed : out.notPassed).push(n);
  return out;
}

/** The four outcome classes of one reported test, exactly as the counting rules below sort it. */
export type TestOutcome = 'passed' | 'failed' | 'skipped' | 'todo';

/**
 * The outcome class of a vitest assertion status: `passed` → passed; `skipped` / `disabled` →
 * skipped; `todo` → todo; anything else (`failed`, `pending`, an unknown or missing status) →
 * failed. The digest uses these classes, never vitest's raw status strings, so a status spelling
 * that differs between two systems is not a digest difference.
 */
export function testOutcome(status: unknown): TestOutcome {
  if (status === 'passed') return 'passed';
  if (status === 'skipped' || status === 'disabled') return 'skipped';
  if (status === 'todo') return 'todo';
  return 'failed';
}

/** First line of the hashed text of `outcomeDigest`; a change to the canonical form changes it. */
export const OUTCOME_DIGEST_DOMAIN = 'instar-lv-outcome-digest-v1';

/**
 * The names-and-outcomes digest of one test file (spec local-verify-borrowed-slices-count.md,
 * "What a pass is"): which tests ran, and how each ended.
 *
 * CANONICAL FORM. For every reported test of the file, one line
 * `JSON.stringify([fullName, outcome])`, where `fullName` is `fullTestName` of the entry and
 * `outcome` is its `TestOutcome` class. The lines are sorted by UTF-16 code unit (the default
 * `Array.prototype.sort`), duplicates kept, so the digest does not depend on report order or on
 * how a file's entries were split, and a test registered twice differs from one registered once.
 * The hashed text is the domain line, then every line, each ended by `\n`, as UTF-8. The digest is
 * its SHA-256 in lowercase hex.
 *
 * Not covered: a file-level failure without a failed test (an import or hook error) adds no line.
 * It shows in the file's `failed` count, which every reader of the digest also reads.
 */
export function outcomeDigest(tests: ReadonlyArray<{ name: string; outcome: TestOutcome }>): string {
  const lines = tests.map((t) => JSON.stringify([t.name, t.outcome])).sort();
  const h = crypto.createHash('sha256');
  h.update(`${OUTCOME_DIGEST_DOMAIN}\n`, 'utf8');
  for (const l of lines) h.update(`${l}\n`, 'utf8');
  return h.digest('hex');
}

function relativize(name: string, rootDir: string): string {
  const n = normalizePath(name);
  const root = normalizePath(rootDir).replace(/\/+$/, '');
  if (root && n.startsWith(root + '/')) return n.slice(root.length + 1);
  return n;
}

/**
 * Parse vitest JSON reporter output. Throws LaneReportParseError on anything
 * that is not the expected shape (an unreadable report fails the lane).
 *
 * Counting rules: `passed` → passed; `skipped`/`disabled` → skipped; `todo` →
 * todo; `failed` → failed; `pending` (still running, or an `.only` left in
 * place) and any unknown status → failed. A file whose own status is `failed`
 * with no failed assertion (an import or hook error) counts one failure.
 *
 * Test names (spec local-verify-import-related-rerun.md): a failed file also gets its named
 * failed tests, the hash of all its test names in report order, whether a failed name is not
 * unique, and whether it had a file-level failure (reported alone AND beside named failures).
 * All of a file's names are held only while these are computed; they are summed per path, so
 * two entries for one path in a report count as one file. `opts.solo` (a report of one file run
 * alone) adds the passed names. No count changes.
 *
 * `opts.outcomeDigest` adds each file's `outcomeDigest` (borrowed helpers). Without it the output
 * is exactly what it was before the option existed: no field is added, renamed or reordered.
 */
export function parseVitestJson(text: string, rootDir: string, opts: { solo?: boolean; outcomeDigest?: boolean; namedRetry?: boolean; checkCompletion?: boolean } = {}): ParsedLaneReport {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new LaneReportParseError(`report is not JSON: ${(e as Error).message}`);
  }
  if (!doc || typeof doc !== 'object' || !Array.isArray((doc as { testResults?: unknown }).testResults)) {
    throw new LaneReportParseError('report has no testResults array');
  }
  const files = new Map<string, FileCounts>();
  /** Per path, only while parsing: the running name hash, how often each name occurs, the failed names, a file-level failure. */
  const names = new Map<string, { hash: crypto.Hash; recoveredHash?: crypto.Hash; seen: Map<string, number>; failedNames: string[]; failed: FailedTest[]; fileLevel: boolean; passed: string[]; notPassed: Array<{ name: string; status: string }> }>();
  /** Per path, only with `opts.outcomeDigest`: every test's name and outcome class. */
  const outcomes = new Map<string, Array<{ name: string; outcome: TestOutcome }>>();
  for (const tr of (doc as { testResults: unknown[] }).testResults) {
    if (!tr || typeof tr !== 'object') throw new LaneReportParseError('testResults entry is not an object');
    const r = tr as { name?: unknown; status?: unknown; message?: unknown; assertionResults?: unknown; startTime?: unknown; endTime?: unknown };
    if (typeof r.name !== 'string' || !Array.isArray(r.assertionResults)) {
      throw new LaneReportParseError('testResults entry lacks name or assertionResults');
    }
    const path = relativize(r.name, rootDir);
    const c: FileCounts = files.get(path) ?? { passed: 0, failed: 0, skipped: 0, todo: 0, message: '', assertionFailures: 0, nonAssertionFailure: false };
    let assertionFailures = 0;
    const n = names.get(path) ?? { hash: crypto.createHash('sha256'), recoveredHash: opts.namedRetry ? crypto.createHash('sha256') : undefined, seen: new Map<string, number>(), failedNames: [], failed: [], fileLevel: false, passed: [], notPassed: [] };
    names.set(path, n);
    for (const a of r.assertionResults) {
      const s = a && typeof a === 'object' ? (a as { status?: unknown }).status : undefined;
      const name = fullTestName(a);
      n.hash.update(JSON.stringify(name) + '\n');
      n.recoveredHash?.update(JSON.stringify([name, s === 'failed' ? 'passed' : s]) + '\n');
      n.seen.set(name, (n.seen.get(name) ?? 0) + 1);
      if (opts.outcomeDigest) {
        const list = outcomes.get(path) ?? [];
        list.push({ name, outcome: testOutcome(s) });
        outcomes.set(path, list);
      }
      if (opts.solo) {
        if (s === 'passed') n.passed.push(name);
        else n.notPassed.push({ name, status: typeof s === 'string' ? s.slice(0, 40) : 'unknown' });
      }
      if (s === 'passed') c.passed++;
      else if (s === 'skipped' || s === 'disabled') c.skipped++;
      else if (s === 'todo') c.todo++;
      else {
        c.failed++;
        assertionFailures++;
        n.failedNames.push(name);
        if (name.length >= 1 && name.length <= IMPORT_RELATED_RERUN.nameChars) {
          const fm0 = (a as { failureMessages?: unknown }).failureMessages;
          const whole = Array.isArray(fm0) && typeof fm0[0] === 'string' ? fm0[0] : '';
          n.failed.push({ name, ...errorLine(whole), full: boundedTail(whole, IMPORT_RELATED_RERUN.failureFullChars) });
        }
        if (s === 'failed') c.assertionFailures = (c.assertionFailures ?? 0) + 1;
        else c.nonAssertionFailure = true;
        // Keep the first failing test's title and message (bounded) so a red record says why.
        if (!c.message) {
          const t = (a as { title?: unknown }).title;
          const fm = (a as { failureMessages?: unknown }).failureMessages;
          const first = Array.isArray(fm) && typeof fm[0] === 'string' ? fm[0] : '';
          c.message = `${typeof t === 'string' ? t : 'test'}: ${first}`.slice(0, FAILURE_MESSAGE_MAX);
        }
      }
    }
    if (r.status !== 'passed' && assertionFailures === 0) {
      c.failed++;
      c.nonAssertionFailure = true;
      n.fileLevel = true;
    }
    // A file-level message is a file-level failure also when a named test failed beside it (S3).
    if (typeof r.message === 'string' && r.message) n.fileLevel = true;
    if (typeof r.message === 'string' && r.message && !c.message) c.message = r.message.slice(0, FAILURE_MESSAGE_MAX);
    if (typeof r.startTime === 'number' && typeof r.endTime === 'number' && r.endTime >= r.startTime) {
      c.ms = (c.ms ?? 0) + Math.round(r.endTime - r.startTime);
    }
    files.set(path, c);
  }
  for (const [path, c] of files) {
    const n = names.get(path)!;
    if (c.failed > 0) {
      c.failedTests = n.failed;
      c.duplicateFailedName = n.failedNames.some((x) => (n.seen.get(x) ?? 0) > 1);
    }
    if (c.failed > 0 || opts.solo) {
      c.testSetHash = n.hash.digest('hex');
      c.fileLevelFailure = n.fileLevel;
      if (n.recoveredHash) c.recoveredOutcomeHash = n.recoveredHash.digest('hex');
    }
    if (opts.solo) {
      c.passedTests = n.passed;
      c.notPassedTests = n.notPassed;
    }
    if (opts.outcomeDigest) c.outcomeDigest = outcomeDigest(outcomes.get(path) ?? []);
  }
  if (!opts.checkCompletion) return { files };
  const summary = doc as Record<string, unknown>;
  let passed = 0;
  let skipped = 0;
  let todo = 0;
  let failed = 0;
  for (const counts of files.values()) {
    passed += counts.passed;
    skipped += counts.skipped;
    todo += counts.todo;
    failed += counts.failed;
  }
  return { files, completeAndClean: failed === 0 && passed > 0 && summary.success === true
    && summary.numFailedTestSuites === 0 && summary.numPendingTestSuites === 0 && summary.numFailedTests === 0
    && summary.numPassedTests === passed && summary.numPendingTests === skipped && summary.numTodoTests === todo
    && summary.numTotalTests === passed + skipped + todo
    && (doc as { testResults: unknown[] }).testResults.length === files.size };
}

/** The counts of a file without its test names (what may stay in a lane report after a re-run). */
export function withoutNames(c: FileCounts): FileCounts {
  const { failedTests: _f, testSetHash: _h, recoveredOutcomeHash: _r, duplicateFailedName: _d, fileLevelFailure: _l, passedTests: _p, notPassedTests: _n, ...counts } = c;
  void _f; void _h; void _d; void _l; void _p; void _n;
  return counts;
}

export interface LaneRunInput {
  lane: LaneName;
  /** Parsed report, or null when the report was missing or unparseable. */
  report: ParsedLaneReport | null;
  seconds: number;
  /** vitest's exit code; a non-zero exit with no failed test (an unhandled error) fails a gating lane. */
  exitCode?: number | null;
  /** Stopped by fail-fast after another lane failed: no report, and its files are not "not run" failures. */
  stoppedEarly?: boolean;
  /**
   * Cut short after its first part (spec local-verify-likely-failing-first.md C): `report` covers
   * only the files that ran. The lane's other files are "not run: the lane was stopped", never
   * `file-not-run`, and such a lane can never be part of a pass (`lane-stopped-early`, or
   * `lane-stopped-without-failure` when nothing else failed). Only meaningful with a report.
   */
  cutShort?: boolean;
}

/** Observation only: exact file identity and stopped-lane flags, independent of assertion verdict. */
export function measureInventoryCoverage(inventory: Inventory, runs: readonly LaneRunInput[]): { expectedFiles: number; reportedFiles: number; complete: boolean } {
  const expected = new Set(inventory.files.map((f) => `${f.lane}:${f.path}`));
  const reported = new Set(runs.flatMap((r) => [...(r.report?.files.keys() ?? [])].map((file) => `${r.lane}:${file}`)));
  return { expectedFiles: expected.size, reportedFiles: reported.size,
    complete: inventory.errors.length === 0 && expected.size > 0 && expected.size === reported.size
      && [...expected].every((file) => reported.has(file)) && runs.every((r) => !r.stoppedEarly && !r.cutShort) };
}

export interface LaneTotals {
  name: LaneName;
  gating: boolean;
  files: number;
  tests: number;
  passed: number;
  failed: number;
  skipped: number;
  todo: number;
  seconds: number;
}

export interface RunEvaluation {
  outcome: 'success' | 'failure';
  reasons: string[];
  lanes: LaneTotals[];
  /** Per-file counts keyed by path, for the record's audit detail. */
  perFile: Record<string, FileCounts & { lane: LaneName }>;
}

export function evaluateRun(
  inventory: Inventory,
  laneRuns: readonly LaneRunInput[],
  lanes: readonly LaneDefinition[] = LANES,
): RunEvaluation {
  const reasons: string[] = [];
  /** Appended last, so the run's first reason is always a real failure, never a stopped lane. */
  const stopped: string[] = [];
  const stoppedLanes = new Set<LaneName>();
  const gatingOf = new Map(lanes.map((l) => [l.name, l.gating]));
  const runs = new Map<LaneName, LaneRunInput>();
  for (const r of laneRuns) {
    if (!gatingOf.has(r.lane)) {
      reasons.push(`unknown-lane:${r.lane}`);
      continue;
    }
    if (runs.has(r.lane)) reasons.push(`duplicate-lane-report:${r.lane}`);
    runs.set(r.lane, r);
  }

  for (const e of inventory.errors) reasons.push(`unlaned-test:${e.path}`);

  // Where each file appears.
  const appearances = new Map<string, LaneName[]>();
  for (const [lane, run] of runs) {
    if (!run.report) continue;
    for (const p of run.report.files.keys()) {
      const list = appearances.get(p) ?? [];
      list.push(lane);
      appearances.set(p, list);
    }
  }

  const totals: LaneTotals[] = [];
  const perFile: RunEvaluation['perFile'] = {};
  for (const def of lanes) {
    const run = runs.get(def.name);
    const t: LaneTotals = {
      name: def.name, gating: def.gating, files: 0, tests: 0, passed: 0, failed: 0, skipped: 0, todo: 0,
      seconds: run?.seconds ?? 0,
    };
    if (run?.stoppedEarly && !run.report) {
      stoppedLanes.add(def.name);
      if (def.gating) stopped.push(`lane-stopped-early:${def.name}`);
      totals.push(t);
      continue;
    }
    if (!run || !run.report) {
      if (def.gating) reasons.push(`lane-report-missing:${def.name}`);
      totals.push(t);
      continue;
    }
    if (run.cutShort) {
      // Cut short after its first part: the report is counted for the files that ran, the rest
      // of the lane's files are marked stopped below, and the run can never be a pass.
      stoppedLanes.add(def.name);
      if (def.gating) stopped.push(`lane-stopped-early:${def.name}`);
    }
    for (const [p, c] of run.report.files) {
      t.files++;
      t.passed += c.passed;
      t.failed += c.failed;
      t.skipped += c.skipped;
      t.todo += c.todo;
      t.tests += c.passed + c.failed + c.skipped + c.todo;
      perFile[p] = { ...c, lane: def.name };
    }
    if (def.gating) {
      if (t.failed > 0) reasons.push(`lane-failed:${def.name}:${t.failed}`);
      // A lane cut short after its first part is judged on what ran; "nothing passed" needs the whole lane.
      if (t.passed === 0 && !run.cutShort) reasons.push(`lane-zero-passed:${def.name}`);
      if (t.failed === 0 && run.exitCode != null && run.exitCode !== 0) {
        reasons.push(`lane-exit-nonzero:${def.name}:${run.exitCode}`);
      }
    }
    totals.push(t);
  }

  for (const f of inventory.files) {
    const where = appearances.get(f.path) ?? [];
    if (where.length === 0) {
      if (stoppedLanes.has(f.lane)) continue; // its lane was stopped after another lane failed
      reasons.push(`file-not-run:${f.path}`);
      continue;
    }
    if (where.length > 1) {
      reasons.push(`file-in-multiple-lanes:${f.path}:${where.join(',')}`);
      continue;
    }
    const lane = where[0];
    if (!gatingOf.get(lane)) continue; // advisory lane: reported, never gating
    const c = runs.get(lane)!.report!.files.get(f.path)!;
    if (c.failed > 0) reasons.push(`file-failed:${f.path}:${c.failed}`);
    else if (c.passed + c.skipped + c.todo === 0) reasons.push(`no-tests-collected:${f.path}`);
  }

  // A stopped lane only exists because another lane failed; it is never the run's only reason.
  if (stopped.length > 0 && reasons.length === 0) reasons.push('lane-stopped-without-failure');
  reasons.push(...stopped);
  return { outcome: reasons.length === 0 ? 'success' : 'failure', reasons, lanes: totals, perFile };
}

// ── Isolation re-run of failed files (the evidence-per-run "known-flaky") ──

/** One main-flaky test the coordinator offers for a file: a `main` verify saw it fail in its lane and pass alone by name. */
export interface FlakyOnMainTest {
  test: string;
  /** When that `main` verify finished. */
  at: string;
  /** The distinguishing error line on `main`, bounded with its disclosure. */
  line: string;
  lineCut?: true;
  /** The file's `testSetHash` in that `main` run. */
  setHash: string;
  /** That `main` run's log (a file name on the machine that ran it). */
  runLog: string;
}

export interface FlakyOnMainFile {
  file: string;
  tests: FlakyOnMainTest[];
  /** A name of this file was dropped by a cap or a bound: a missing test may be cut, not absent. */
  namesCut?: true;
}

/** Why an import-related failed file gets no re-run under the import-related rule. */
export type ImportRelatedRefusalReason =
  | 'noMainEvidence' | 'noMainEvidenceForTest' | 'testSetChanged' | 'duplicateTestName'
  | 'fileLevelFailure' | 'namedCountMismatch' | 'tooManyFailedTests';

export interface ImportRelatedRefusal { file: string; reason: ImportRelatedRefusalReason; test?: string; namesCut?: true }

/**
 * May an import-related failed file be re-run on main evidence (spec
 * local-verify-import-related-rerun.md "Rule proposed")? Only when the file is on main's list,
 * it had no file-level failure, its named failed tests are the whole truth (1..20 of them, equal
 * to the failed count), no failed name occurs twice in the file, EVERY failed test is on the
 * list by full name, and the file's name-sequence hash equals the hash stored with each piece of
 * evidence used. Anything missing or malformed is a refusal: nothing here can pass vacuously.
 * Pure: the same input gives the same class on the coordinator and on a peer.
 */
export function importRelatedEligibility(c: FileCounts | undefined, entry: FlakyOnMainFile | undefined):
  | { eligible: true; evidence: FlakyOnMainTest[] }
  | { eligible: false; reason: ImportRelatedRefusalReason; test?: string; namesCut?: true } {
  if (!entry || !Array.isArray(entry.tests)) return { eligible: false, reason: 'noMainEvidence' };
  const cut = entry.namesCut === true ? { namesCut: true as const } : {};
  const no = (reason: ImportRelatedRefusalReason, test?: string) => ({ eligible: false as const, reason, ...(test !== undefined ? { test } : {}), ...cut });
  if (!c || c.fileLevelFailure !== false) return no('fileLevelFailure');
  const named = c.failedTests ?? [];
  if (c.failed > IMPORT_RELATED_RERUN.recordNames) return no('tooManyFailedTests');
  if (named.length < 1 || named.length !== c.failed) return no('namedCountMismatch');
  if (c.duplicateFailedName !== false) return no('duplicateTestName');
  const usable = (t: FlakyOnMainTest | undefined): t is FlakyOnMainTest => !!t && typeof t.at === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(t.at) && !Number.isNaN(Date.parse(t.at))
    && typeof t.line === 'string' && t.line.length <= IMPORT_RELATED_RERUN.lineChars && typeof t.setHash === 'string' && typeof t.runLog === 'string' && t.runLog.length <= 200;
  const byName = new Map(entry.tests.filter((t) => t && typeof t.test === 'string').map((t) => [t.test, t]));
  const evidence: FlakyOnMainTest[] = [];
  for (const t of named) {
    const e = byName.get(t.name);
    if (!usable(e)) return no('noMainEvidenceForTest', t.name);
    evidence.push(e);
  }
  if (typeof c.testSetHash !== 'string') return no('testSetChanged', named[0].name);
  for (const e of evidence) if (e.setHash !== c.testSetHash) return no('testSetChanged', e.test);
  return { eligible: true, evidence };
}

export type IsolationRerunDecision =
  | { rerun: string[]; reason: 'eligible'; /** The re-run files that need three consecutive by-name passes (import-related, with main evidence). */ threePass: string[] }
  | { rerun: []; reason: 'no-report' | 'no-failures' | 'too-many-failures' | 'other-failure' | 'rerun-budget-spent' | 'unhandled-errors' | 'related-to-change' };

/**
 * Should a lane's failed files be re-run alone (once, or three times for the files in
 * `importRelated`)? Only when the lane's ONLY problem is
 * 1..maxFiles failed files: a missing report, an inventoried file the lane never ran, a file
 * that collected nothing, or an unhandled error (or an unknown unhandled-error count) is a
 * different failure, and more than maxFiles failed files is a real break. A failed file in
 * `ineligible` (a PR verify: the PR changed it, or it imports a file the PR changed and not
 * every one of its failed tests has been shown flaky on `main`) is a real, possibly
 * order-dependent failure: nothing re-runs. `importRelated` names the failed files that import a
 * changed file AND whose failed tests are all on main's list: they are eligible and need three
 * passes; each still counts as one file. `budgetLeft` is what is left of the per-verify cap
 * (files). The reasons and their order are what they were. Pure: the
 * orchestrator calls it and the self-action registry drives it (local-verify-flake-rerun).
 */
export function decideIsolationRerun(i: {
  report: ParsedLaneReport | null;
  /** The inventoried files assigned to this lane. */
  laneFiles: readonly string[];
  maxFiles: number;
  budgetLeft: number;
  /** The lane run's unhandled-error count; null = unknown (never re-run). Absent = not checked (tests of the count rules). */
  unhandledErrors?: number | null;
  /** Failed files that must not be treated as possibly flaky. */
  ineligible?: ReadonlySet<string>;
  /** Eligible failed files that need three passes instead of one. Absent ⇒ none. */
  importRelated?: ReadonlySet<string>;
  /**
   * Files of the SAME lane that already failed in its first part (spec
   * local-verify-likely-failing-first.md C): "more than maxFiles failed files" counts the lane's
   * failures so far, as it would have if the lane had run in one piece. Absent ⇒ 0.
   */
  priorFailed?: number;
}): IsolationRerunDecision {
  if (!i.report) return { rerun: [], reason: 'no-report' };
  const failed = [...i.report.files.entries()].filter(([, c]) => c.failed > 0).map(([f]) => f).sort();
  if (failed.length === 0) return { rerun: [], reason: 'no-failures' };
  if (i.unhandledErrors !== undefined && i.unhandledErrors !== 0) return { rerun: [], reason: 'unhandled-errors' };
  if (failed.length + (i.priorFailed ?? 0) > i.maxFiles) return { rerun: [], reason: 'too-many-failures' };
  for (const f of i.laneFiles) {
    const c = i.report.files.get(f);
    if (!c) return { rerun: [], reason: 'other-failure' }; // file-not-run
    if (c.failed === 0 && c.passed + c.skipped + c.todo === 0) return { rerun: [], reason: 'other-failure' }; // zero collected
  }
  if (i.ineligible && failed.some((f) => i.ineligible!.has(f))) return { rerun: [], reason: 'related-to-change' };
  if (failed.length > i.budgetLeft) return { rerun: [], reason: 'rerun-budget-spent' };
  return { rerun: failed, reason: 'eligible', threePass: i.importRelated ? failed.filter((f) => i.importRelated!.has(f)) : [] };
}
