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

import { normalizePath } from './glob.js';
import { LANES, type Inventory, type LaneDefinition, type LaneName } from './inventory.js';

export interface FileCounts {
  passed: number;
  failed: number;
  skipped: number;
  todo: number;
  /** Vitest's file-level message (an import/collect error); '' when none. */
  message?: string;
}

export interface ParsedLaneReport {
  files: Map<string, FileCounts>;
}

export class LaneReportParseError extends Error {}

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
 */
export function parseVitestJson(text: string, rootDir: string): ParsedLaneReport {
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
  for (const tr of (doc as { testResults: unknown[] }).testResults) {
    if (!tr || typeof tr !== 'object') throw new LaneReportParseError('testResults entry is not an object');
    const r = tr as { name?: unknown; status?: unknown; message?: unknown; assertionResults?: unknown };
    if (typeof r.name !== 'string' || !Array.isArray(r.assertionResults)) {
      throw new LaneReportParseError('testResults entry lacks name or assertionResults');
    }
    const path = relativize(r.name, rootDir);
    const c: FileCounts = files.get(path) ?? { passed: 0, failed: 0, skipped: 0, todo: 0, message: '' };
    let assertionFailures = 0;
    for (const a of r.assertionResults) {
      const s = a && typeof a === 'object' ? (a as { status?: unknown }).status : undefined;
      if (s === 'passed') c.passed++;
      else if (s === 'skipped' || s === 'disabled') c.skipped++;
      else if (s === 'todo') c.todo++;
      else {
        c.failed++;
        assertionFailures++;
      }
    }
    if (r.status !== 'passed' && assertionFailures === 0) {
      c.failed++;
    }
    if (typeof r.message === 'string' && r.message) c.message = r.message;
    files.set(path, c);
  }
  return { files };
}

export interface LaneRunInput {
  lane: LaneName;
  /** Parsed report, or null when the report was missing or unparseable. */
  report: ParsedLaneReport | null;
  seconds: number;
  /** vitest's exit code; a non-zero exit with no failed test (an unhandled error) fails a gating lane. */
  exitCode?: number | null;
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
    if (!run || !run.report) {
      if (def.gating) reasons.push(`lane-report-missing:${def.name}`);
      totals.push(t);
      continue;
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
      if (t.passed === 0) reasons.push(`lane-zero-passed:${def.name}`);
      if (t.failed === 0 && run.exitCode != null && run.exitCode !== 0) {
        reasons.push(`lane-exit-nonzero:${def.name}:${run.exitCode}`);
      }
    }
    totals.push(t);
  }

  for (const f of inventory.files) {
    const where = appearances.get(f.path) ?? [];
    if (where.length === 0) {
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

  return { outcome: reasons.length === 0 ? 'success' : 'failure', reasons, lanes: totals, perFile };
}
