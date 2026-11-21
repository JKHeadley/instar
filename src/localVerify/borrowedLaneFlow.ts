/**
 * The verify child's lane flow with a borrowed helper (docs/specs/local-verify-borrowed-slices-count.md,
 * F "Where the exchange runs", "Which lanes, and how much", "The plan (counting)", "One result per
 * file", "What a pass is", "The check slice", "Spot re-runs", "A confirmed wrong pass", "More than
 * five disagreements in one verify", "Practice").
 *
 * This module IS part of the verifier's code and of its version (the spec says so): it runs inside
 * the verify child, behind one seam in the orchestrator (`runVerify` opens it only when the run
 * input carries `borrowed`, a pull-request verify, and this machine's server answers). Everything
 * the helper sends reaches the lane's report through ONE function, `admitHelperPasses`, and only
 * passes: a helper's failure is never a result, a local result always wins, and a file whose
 * helper answer is missing, late, invalid, or from another tree is run here.
 *
 * The child holds no key. It asks its own server over loopback (`POST /local-verify/borrowed-proxy`)
 * with the verify's attempt token; the server takes the commits, the helper and the ids from its
 * own record of the verify, signs, forwards, checks the helper's signatures and returns only
 * answers it verified. Each call has a 5-second limit and any failure reads as "no helper answer".
 *
 * Bounded worst case: with a silent helper every shard runs exactly the files it would have run,
 * in two processes instead of one (its own files, then whatever it took back).
 */
import crypto from 'node:crypto';
import type { FileCounts, ParsedLaneReport } from './laneReport.js';
import { filterOverlapGroups, type FileDurations } from './shardPlan.js';
import { BORROWED_CANARY, BORROWED_CANARY_FILES } from './borrowedCanary.js';
import { BORROWED_CANARY_DIR, excludedBy, isBorrowableTestFile } from './borrowedEligibility.js';
import { planSlices } from './borrowedPlan.js';
import { selectBaselineRows, usableBaseline, type FileCountsRow, type MainBaseline } from './mainFileCounts.js';

export type FlowLane = 'unit' | 'integration' | 'e2e';
export const FLOW_LANES: readonly FlowLane[] = Object.freeze(['unit', 'integration', 'e2e']);

export const LANE_FLOW = Object.freeze({
  proxyPath: '/local-verify/borrowed-proxy',
  tokenHeader: 'x-instar-attempt-token',
  /** Each proxy call's limit; past it the answer is "no helper answer". */
  callTimeoutMs: 5_000,
  /** How often the flow asks for finished slices while lanes run. */
  pollMs: 2_000,
  /** A lane's share of its own time before 5 measured verifies (spec "a quarter of its time"). */
  initialShare: 0.25,
  /** PRACTICE-PHASE DEFAULT: never more than half of a lane goes to one helper. */
  maxShare: 0.5,
  /** MORE than five disagreements in one verify is one event of unknown cause (spec F). */
  massDisagreement: 5,
  /** Slices one lane may queue on the helper (three lanes stay under the helper's queue bound of 200). */
  maxSlicesPerLane: 60,
  /** A slice names at most this many files (the helper's bound). */
  maxFilesPerSlice: 400,
  /** Helper time budget of one slice (the helper's own lane limits). */
  sliceBudgetMs: Object.freeze({ unit: 10_000, integration: 60_000, e2e: 60_000 }),
  /** A file with no recorded duration is planned as this long. */
  unknownFileMs: 1_000,
  /** The unit lane's wall-to-sum factor (1.22 measured on the Studio, 2026-11-18). */
  unitWallFactor: 1.22,
  /** Learned-list files tried again per verify, compare-only. */
  retrialMax: 5,
  /** Locally failed files reported for the failing-direction request, per lane. */
  localFailedMax: 50,
  /** File lists in the audit row are cut here. */
  auditFilesMax: 200,
});

// ── what the server hands the child ────────────────────────────────────

/** `VerifyRunInput.borrowed`: the server's port, the verify's own attempt token, and the kept baseline results. */
export interface BorrowedChildInput {
  port: number;
  token: string;
  baselines: MainBaseline[];
}

export interface PlanLaneFacts { state: string; mayCount: boolean; proven: boolean; share: number; uncovered: string[] }

/** The proxy's `plan` answer. */
export interface PlanFacts {
  helper: string;
  mode: 'practice' | 'count';
  assigned: 'counting' | 'compare-only' | null;
  answered: boolean;
  lanes: Record<FlowLane, PlanLaneFacts>;
  spotOneIn: number;
  learned: Array<{ file: string; retrialDue: boolean }>;
  /** Local file-ms the helper finishes per helper-ms. */
  throughput: number;
  prepMs: number;
  /** Workers the owner's use leaves free at the verify's status request, and the helper's ceiling (null: not reported). */
  workersFree: number | null;
  workersMax: number | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const FILE_RE = /^[A-Za-z0-9._@+/-]{1,300}$/;

/** Parse the proxy's `plan` answer. Anything malformed is no helper. Pure. */
export function parsePlan(v: unknown): PlanFacts | null {
  if (!isObj(v) || v.ok !== true || typeof v.helper !== 'string' || (v.mode !== 'practice' && v.mode !== 'count')) return null;
  if (v.assigned !== null && v.assigned !== 'counting' && v.assigned !== 'compare-only') return null;
  if (!isObj(v.lanes)) return null;
  const lanes = {} as Record<FlowLane, PlanLaneFacts>;
  for (const lane of FLOW_LANES) {
    const l = (v.lanes as Record<string, unknown>)[lane];
    if (!isObj(l)) return null;
    const uncovered = Array.isArray(l.uncovered) ? l.uncovered.filter((f): f is string => typeof f === 'string' && FILE_RE.test(f)).slice(0, 20_000) : [];
    lanes[lane] = {
      state: typeof l.state === 'string' ? l.state.slice(0, 60) : 'practice',
      mayCount: l.mayCount === true, proven: l.proven === true,
      share: isFiniteNum(l.share) ? Math.min(LANE_FLOW.maxShare, Math.max(0, l.share)) : LANE_FLOW.initialShare,
      uncovered,
    };
  }
  const learned = Array.isArray(v.learned) ? v.learned.filter((e): e is { file: string; retrialDue?: unknown } => isObj(e) && typeof e.file === 'string' && FILE_RE.test(e.file)).slice(0, 20_000).map((e) => ({ file: e.file, retrialDue: e.retrialDue === true })) : [];
  return {
    helper: v.helper.slice(0, 64), mode: v.mode, assigned: v.assigned as PlanFacts['assigned'], answered: v.answered === true, lanes,
    spotOneIn: isFiniteNum(v.spotOneIn) && v.spotOneIn >= 1 ? Math.floor(v.spotOneIn) : 20,
    learned,
    throughput: isFiniteNum(v.throughput) && v.throughput > 0 ? v.throughput : 0.27,
    prepMs: isFiniteNum(v.prepMs) && v.prepMs >= 0 ? v.prepMs : 3 * 60_000,
    workersFree: isFiniteNum(v.workersFree) && v.workersFree >= 0 ? Math.floor(v.workersFree) : null,
    workersMax: isFiniteNum(v.workersMax) && v.workersMax >= 1 ? Math.floor(v.workersMax) : null,
  };
}

// ── results the server verified and passes on ──────────────────────────

export interface HelperFileResult { file: string; tests: number; passed: number; failed: number; skipped: number; todo: number; ms: number; digest: string | null; failedTests: string[] }
export interface HelperSliceTrouble { exitCode: number | null; unhandledErrors: number; collected: boolean }

/** One finished slice as the server passes it on: `valid` false when its ids, signature, file list or tree were wrong. */
export interface SliceResult {
  seq: number;
  attemptId: string;
  valid: boolean;
  state: string;
  treeHash: string | null;
  perFile: HelperFileResult[];
  slice: HelperSliceTrouble | null;
}

export interface StatusFacts { results: SliceResult[]; tree: { state: 'preparing' | 'ready' | 'failed' | 'none'; treeHash: string | null } }

function parseFileResult(v: unknown): HelperFileResult | null {
  if (!isObj(v) || typeof v.file !== 'string' || !FILE_RE.test(v.file)) return null;
  const n = (k: string) => (typeof v[k] === 'number' && Number.isSafeInteger(v[k]) && (v[k] as number) >= 0 ? v[k] as number : null);
  const tests = n('tests'); const passed = n('passed'); const failed = n('failed'); const skipped = n('skipped'); const todo = n('todo');
  if (tests === null || passed === null || failed === null || skipped === null || todo === null) return null;
  const ms = isFiniteNum(v.ms) && v.ms >= 0 ? v.ms : 0;
  const digest = typeof v.digest === 'string' && /^[0-9a-f]{64}$/.test(v.digest) ? v.digest : null;
  const failedTests = Array.isArray(v.failedTests) ? v.failedTests.filter((x): x is string => typeof x === 'string' && x.length >= 1 && x.length <= 300).slice(0, 50) : [];
  return { file: v.file, tests, passed, failed, skipped, todo, ms, digest, failedTests };
}

/** Parse the proxy's `status` answer (already signature-checked by the server). Pure. */
export function parseStatusFacts(v: unknown): StatusFacts | null {
  if (!isObj(v) || v.ok !== true || !Array.isArray(v.results)) return null;
  const results: SliceResult[] = [];
  for (const r of v.results) {
    if (!isObj(r) || typeof r.seq !== 'number' || !Number.isSafeInteger(r.seq) || typeof r.attemptId !== 'string' || !/^[0-9a-f]{32}$/.test(r.attemptId)) continue;
    const perFile = Array.isArray(r.perFile) ? r.perFile.map(parseFileResult) : [];
    const slice = isObj(r.slice) ? {
      exitCode: typeof r.slice.exitCode === 'number' ? r.slice.exitCode : null,
      unhandledErrors: typeof r.slice.unhandledErrors === 'number' && r.slice.unhandledErrors >= 0 ? r.slice.unhandledErrors : 1,
      collected: r.slice.collected === true,
    } : null;
    const valid = r.valid === true && perFile.every((p) => p !== null);
    results.push({
      seq: r.seq, attemptId: r.attemptId, valid, state: typeof r.state === 'string' ? r.state.slice(0, 40) : 'unknown',
      treeHash: typeof r.treeHash === 'string' && /^[0-9a-f]{40,64}$/.test(r.treeHash) ? r.treeHash : null,
      perFile: valid ? perFile as HelperFileResult[] : [], slice,
    });
  }
  const t = isObj(v.tree) ? v.tree : null;
  const state = t && (t.state === 'preparing' || t.state === 'ready' || t.state === 'failed') ? t.state : 'none';
  return { results, tree: { state, treeHash: t && typeof t.treeHash === 'string' ? t.treeHash : null } };
}

// ── the pure rules ─────────────────────────────────────────────────────

/**
 * Slice-level trouble discards the whole slice (spec "A failure from a helper is not a result"):
 * no slice facts, an unhandled error, an exit its failed files do not explain, or nothing collected.
 */
export function sliceTrouble(r: Pick<SliceResult, 'slice' | 'perFile'>): boolean {
  const s = r.slice;
  if (!s) return true;
  if (s.unhandledErrors > 0) return true;
  const failedFiles = r.perFile.filter((p) => p.failed > 0).length;
  if (s.exitCode !== 0 && failedFiles === 0) return true;
  if (!s.collected && r.perFile.every((p) => p.tests === 0)) return true;
  return false;
}

/**
 * WHAT A PASS IS (spec F): the file was collected, ran at least one test, failed none, and its
 * digest of every test's full name paired with its outcome equals the baseline's digest for that
 * file. A file with no usable baseline row, or a test file this change adds or edits that reports
 * any skip, is never a pass here (it is run locally). Pure.
 */
export function isCountablePass(f: HelperFileResult, row: FileCountsRow | undefined, changedByThisChange: boolean): boolean {
  if (!row) return false;
  if (f.tests < 1 || f.failed !== 0 || f.digest === null) return false;
  if (changedByThisChange && f.skipped > 0) return false;
  return f.digest === row[4];
}

/**
 * The check slice is exactly right when every fixture file came back with its known counts and
 * the slice reported its unhandled rejection (one fixture throws one on purpose). Pure.
 */
export function checkSliceRight(r: Pick<SliceResult, 'valid' | 'perFile' | 'slice'>): boolean {
  if (!r.valid || !r.slice) return false;
  if (r.slice.unhandledErrors < 1) return false;
  const byFile = new Map(r.perFile.map((p) => [p.file, p]));
  for (const f of BORROWED_CANARY_FILES) {
    const exp = BORROWED_CANARY[f];
    const got = byFile.get(f);
    if (!got || got.passed !== exp.passed || got.failed !== exp.failed || got.skipped !== exp.skipped || got.todo !== exp.todo) return false;
  }
  return byFile.size === BORROWED_CANARY_FILES.length;
}

export type FileComparison =
  | 'agreed' | 'digest-differs-both-pass' | 'helper-failed-local-passed'
  | 'confirmed-wrong-pass' | 'unconfirmed' | 'failing-agreed' | 'environment-difference' | 'flaky';

/**
 * One same-tree comparison of a helper's result with the run machine's FINAL result for a file.
 * `soloFailed`: the run machine re-ran the file alone and it failed again (a confirmed local
 * failure); a local failure with no solo run is unconfirmed; one that passed alone is flaky. Pure.
 */
export function compareFile(
  local: { failed: number; digest: string | null; failedTests: readonly string[] },
  helper: HelperFileResult,
  o: { soloFailed: boolean; passedAlone: boolean },
): FileComparison {
  const helperPassed = helper.tests >= 1 && helper.failed === 0 && helper.digest !== null;
  if (local.failed > 0) {
    if (o.passedAlone) return 'flaky';
    if (helperPassed) return o.soloFailed ? 'confirmed-wrong-pass' : 'unconfirmed';
    if (helper.tests < 1 || helper.digest === null) return 'environment-difference';
    const same = helper.failedTests.some((t) => local.failedTests.includes(t));
    return same ? 'failing-agreed' : 'environment-difference';
  }
  if (helper.failed > 0) return 'helper-failed-local-passed';
  if (!helperPassed) return 'environment-difference';
  return helper.digest === local.digest ? 'agreed' : 'digest-differs-both-pass';
}

const isDisagreement = (c: FileComparison): boolean => c === 'digest-differs-both-pass' || c === 'helper-failed-local-passed' || c === 'confirmed-wrong-pass';

/**
 * THE ONE FUNCTION through which a helper's results enter a lane's report (spec "One result per
 * file"): only accepted passes, only for files the run machine did not run itself (a local result
 * always wins). Returns the files it added. A test checks that nothing else in the verifier writes
 * a helper result into a report.
 */
export function admitHelperPasses(report: ParsedLaneReport, passes: ReadonlyMap<string, HelperFileResult>): string[] {
  const added: string[] = [];
  for (const [file, p] of passes) {
    if (report.files.has(file)) continue;
    if (p.failed !== 0 || p.tests < 1) continue;
    const c: FileCounts = { passed: p.passed, failed: 0, skipped: p.skipped, todo: p.todo, ms: p.ms };
    report.files.set(file, c);
    added.push(file);
  }
  return added.sort();
}

/**
 * The share of a lane that goes to the helper, scaled by the workers its owner's use leaves free
 * out of the helper's ceiling (spec "the share is scaled by it"); unknown counts leave it as is. Pure.
 */
export function laneShare(base: number, workersFree: number | null, workersMax: number | null = null): number {
  if (workersFree === 0) return 0;
  const scale = workersFree !== null && workersMax !== null && workersMax > 0 ? Math.min(1, workersFree / workersMax) : 1;
  return Math.min(LANE_FLOW.maxShare, Math.max(0, base * scale));
}

export interface LaneCandidate {
  lane: FlowLane;
  mode: 'count' | 'compare';
  /** Whole overlap groups the helper may take, each with its local duration. Files first in this list go first. */
  groups: Array<{ files: string[]; ms: number }>;
  /** This lane's summed file time in ms, and the factor from file time to its wall time (1 / processes; the unit lane: wall factor / workers). */
  localMs: number;
  wallPerMs: number;
  share: number;
}

/**
 * Which files go to the helper (spec "Which lanes, and how much"): repeatedly give one group to the
 * counting lane projected to finish last, while the helper can finish it before that lane's own
 * processes are projected to end (its time so far plus this group, after its preparation) and the
 * lane's share is not used up. Then the compare lanes, the same way, without shrinking their
 * projection (the run machine runs every file of a compare lane). Pure.
 */
export function allocateShare(cands: readonly LaneCandidate[], throughput: number, prepMs: number): Map<FlowLane, string[][]> {
  const out = new Map<FlowLane, string[][]>();
  let helperMs = 0;
  const tp = Math.max(1e-6, throughput);
  const state = cands.map((c) => ({ c, sentMs: 0, next: 0, taken: [] as string[][] }));
  const projected = (s: typeof state[number]) => (s.c.localMs - (s.c.mode === 'count' ? s.sentMs : 0)) * s.c.wallPerMs;
  for (const mode of ['count', 'compare'] as const) {
    for (;;) {
      const open = state.filter((s) => s.c.mode === mode && s.next < s.c.groups.length);
      if (open.length === 0) break;
      // The lane projected to finish last tries its next group; a group that does not fit is skipped.
      open.sort((a, b) => projected(b) - projected(a) || (a.c.lane < b.c.lane ? -1 : 1));
      const s = open[0];
      const g = s.c.groups[s.next++];
      const cap = s.c.share * s.c.localMs;
      const after = mode === 'count' ? (s.c.localMs - s.sentMs - g.ms) * s.c.wallPerMs : projected(s);
      if (s.sentMs + g.ms > cap || helperMs + g.ms / tp > after - prepMs) continue;
      s.taken.push(g.files);
      s.sentMs += g.ms;
      helperMs += g.ms / tp;
    }
  }
  for (const s of state) if (s.taken.length > 0) out.set(s.c.lane, s.taken);
  return out;
}

/** Divide a counting lane's helper groups among its shards in balanced portions (largest first, to the lightest shard). Pure. */
export function splitPortion(groups: readonly string[][], ownMs: readonly number[], ms: (f: string) => number): string[][] {
  const load = [...ownMs];
  const portions: string[][] = ownMs.map(() => []);
  const sized = groups.map((g) => ({ g, ms: g.reduce((n, f) => n + ms(f), 0) })).sort((a, b) => b.ms - a.ms || (a.g[0] < b.g[0] ? -1 : 1));
  for (const { g, ms: w } of sized) {
    let k = 0;
    for (let i = 1; i < load.length; i++) if (load[i] < load[k]) k = i;
    portions[k].push(...g);
    load[k] += w;
  }
  return portions.map((p) => p.sort());
}

/** One in `oneIn`, from a cryptographic source. */
export function drawSpot(oneIn: number, randomInt: (n: number) => number = (n) => crypto.randomInt(n)): boolean {
  return Math.max(1, Math.floor(oneIn)) <= 1 ? true : randomInt(Math.floor(oneIn)) === 0;
}

/** A 64-character digest of a lane's sent file list (the record's `filesDigest`). Pure. */
export function filesDigest(files: readonly string[]): string {
  return crypto.createHash('sha256').update([...files].sort().join('\n')).digest('hex');
}

// ── the run-time session ───────────────────────────────────────────────

/** One proxy call: the answer body, or null (no answer, a refusal, past the limit). */
export type ProxyCall = (body: Record<string, unknown>) => Promise<Record<string, unknown> | null>;

interface Issued { lane: FlowLane; files: string[]; use: 'check' | 'count' | 'compare'; shard: number | null; done: boolean }

/** What the flow reports per lane (the server turns it into a practice-record outcome). */
export interface LaneOutcomeWire {
  sent: number;
  finished: number;
  agreed: string[];
  digestDiffersBothPass: string[];
  helperFailedLocalPassed: string[];
  confirmedWrongPasses: string[];
  failingAgreed: string[];
  environmentDifferences: number;
  check: 'right' | 'wrong' | null;
  answers: Array<'valid' | 'invalid'>;
  /** Helper passes that counted (entered the lane report without a local run). */
  counted: string[];
  /** Files taken back (no accepted pass in time) and spot re-run files. */
  takenBack: number;
  spot: string[];
  late: number;
  discardedSlices: number;
  /** Retrial files and their agreement (for the helper's learned list). */
  retrial: string[];
  /** Real test files whose final local result failed, with what the failing-direction request needs (`confirmed`: it failed again alone). */
  localFailed: Array<{ file: string; failedTests: string[]; confirmed: boolean }>;
  /** Mass disagreement in this verify: the lane made one final local pass and used no helper result. */
  finalLocalPass: boolean;
}

export interface BorrowedFlowResult {
  helper: string;
  assigned: 'counting' | 'compare-only';
  treeHash: string;
  lanes: Partial<Record<FlowLane, LaneOutcomeWire>>;
  /** Files sent per lane (for the record's `borrowed` field and the audit row). */
  sentFiles: Partial<Record<FlowLane, string[]>>;
  disagreements: number;
}

export interface BorrowedFlowDeps {
  call: ProxyCall;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (e: Record<string, unknown>) => void;
  randomInt?: (n: number) => number;
}

export interface LanePlan {
  lane: FlowLane;
  mode: 'count' | 'compare';
  /** Count lanes: each shard's helper portion (whole overlap groups). */
  portions: string[][];
  /** Every file sent in this lane, compare slices included. */
  sent: string[];
}

/**
 * One verify's helper session: sends the slices, collects the verified results while the lanes
 * run, decides take-back per shard, and compares at the end. Never throws into the run: every
 * proxy failure is "no helper answer".
 */
export class BorrowedLaneFlow {
  private readonly issued = new Map<string, Issued>();
  private readonly results = new Map<string, SliceResult>();
  private readonly lanePlans = new Map<FlowLane, LanePlan>();
  /** Per lane and shard: the passes frozen at take-back (later answers are late). */
  private readonly frozen = new Map<string, Map<string, HelperFileResult>>();
  private readonly spotFiles = new Map<FlowLane, Set<string>>();
  private readonly takenBackCount = new Map<FlowLane, number>();
  private readonly finalPass = new Set<FlowLane>();
  private lastSeq = 0;
  private readonly unknownSeen = new Map<string, number>();
  private stopped = false;
  private poller: Promise<void> | null = null;
  private treeState: StatusFacts['tree'] = { state: 'none', treeHash: null };
  private checkId: string | null = null;
  private checkLane: FlowLane | null = null;
  private disagreementsSoFar = 0;
  private senders: Array<Promise<void>> = [];
  private durations: FileDurations = {};

  constructor(
    readonly plan: PlanFacts,
    private readonly d: BorrowedFlowDeps,
    readonly mergeTree: string,
    private readonly baselineRows: ReadonlyMap<string, FileCountsRow>,
    private readonly changed: ReadonlySet<string>,
  ) {}

  /** Ask the server for this verify's plan. Null: no helper for this verify (the lanes run as without one). */
  static async open(call: ProxyCall): Promise<PlanFacts | null> {
    const p = parsePlan(await call({ op: 'plan' }).catch(() => null));
    if (!p || !p.answered || p.assigned === null) return null;
    return p;
  }

  private log(e: Record<string, unknown>): void { try { this.d.log({ src: 'borrowed', ...e }); } catch { /* @silent-fallback-ok: the run log never breaks a verify */ } }

  /** Files of `lane` this helper may take (D): eligible, not on its learned list, not a fixture. */
  eligible(lane: FlowLane, files: readonly string[]): string[] {
    const learned = new Set(this.plan.learned.map((e) => e.file));
    return files.filter((f) => isBorrowableTestFile(f, lane) && excludedBy(f) === null && !learned.has(f) && !f.startsWith(BORROWED_CANARY_DIR));
  }

  /** The mode of a lane in this verify: count (passes may be used), compare (practice), or none. */
  laneMode(lane: FlowLane): 'count' | 'compare' | null {
    const l = this.plan.lanes[lane];
    if (!l.proven) return null;
    if (this.plan.mode === 'count' && this.plan.assigned === 'counting' && l.mayCount) return 'count';
    return 'compare';
  }

  /** May a file count on this verify (a baseline row of the same content, compared on before, not uncovered)? */
  countable(lane: FlowLane, file: string): boolean {
    return this.baselineRows.has(file) && !this.plan.lanes[lane].uncovered.includes(file);
  }

  /**
   * Plan every lane at once (before any lane starts). `lanes`: each lane's files, durations, its
   * own processes and whether its plan is balanced. Returns each lane's plan; a lane missing from
   * the result gets no helper share.
   */
  planLanes(lanes: ReadonlyArray<{ lane: FlowLane; files: readonly string[]; procs: number; balanced: boolean; firstPart: boolean; wallPerMs: number }>, durations: FileDurations): Map<FlowLane, LanePlan> {
    this.durations = durations;
    const ms = (f: string) => (Number.isFinite(durations[f]) && durations[f] > 0 ? durations[f] : LANE_FLOW.unknownFileMs);
    const cands: LaneCandidate[] = [];
    for (const l of lanes) {
      let mode = this.laneMode(l.lane);
      if (!mode) continue;
      // A lane with no duration-balanced plan, or with a first part, gets no counting share.
      if (mode === 'count' && (l.firstPart || (l.procs > 1 && !l.balanced))) mode = 'compare';
      const ok = new Set(this.eligible(l.lane, l.files));
      const cap = LANE_FLOW.sliceBudgetMs[l.lane] * Math.max(1e-6, this.plan.throughput) * 3;
      const uncovered = new Set(this.plan.lanes[l.lane].uncovered);
      // Whole groups only: no local file filter can then match a file held out.
      const groups = filterOverlapGroups([...l.files])
        .filter((g) => g.every((f) => ok.has(f)) && (mode === 'compare' || g.every((f) => this.countable(l.lane, f))))
        .map((g) => ({ files: g, ms: g.reduce((n, f) => n + ms(f), 0) }))
        .filter((g) => g.ms <= cap);
      // Compare lanes: files never compared on go first (coverage), then the longest.
      groups.sort((a, b) => (mode === 'compare' ? Number(b.files.some((f) => uncovered.has(f))) - Number(a.files.some((f) => uncovered.has(f))) : 0) || b.ms - a.ms || (a.files[0] < b.files[0] ? -1 : 1));
      const localMs = l.files.reduce((n, f) => n + ms(f), 0);
      cands.push({ lane: l.lane, mode, groups, localMs, wallPerMs: l.wallPerMs, share: laneShare(this.plan.lanes[l.lane].share, this.plan.workersFree, this.plan.workersMax) });
    }
    const alloc = allocateShare(cands, this.plan.throughput, this.plan.prepMs);
    for (const c of cands) {
      const groups = alloc.get(c.lane);
      if (!groups || groups.length === 0) continue;
      const sent = groups.flat().sort();
      this.lanePlans.set(c.lane, { lane: c.lane, mode: c.mode, portions: [], sent });
    }
    this.log({ event: 'borrowed-plan', helper: this.plan.helper, assigned: this.plan.assigned, lanes: [...this.lanePlans.values()].map((p) => ({ lane: p.lane, mode: p.mode, files: p.sent.length })) });
    return new Map(this.lanePlans);
  }

  /** The plan of a lane (null: no helper share in this lane). */
  lanePlan(lane: FlowLane): LanePlan | null { return this.lanePlans.get(lane) ?? null; }

  /** A counting lane whose own shard plan could not be balanced keeps its slices compare-only. */
  demote(lane: FlowLane): void { const p = this.lanePlans.get(lane); if (p) { p.mode = 'compare'; p.portions = []; } }

  /** A counting lane's portions per shard, set once its shard plan is known (largest groups to the lightest shard). */
  setPortions(lane: FlowLane, ownMs: readonly number[], durations: FileDurations): string[][] {
    const p = this.lanePlans.get(lane);
    if (!p || p.mode !== 'count') return ownMs.map(() => []);
    const ms = (f: string) => (Number.isFinite(durations[f]) && durations[f] > 0 ? durations[f] : LANE_FLOW.unknownFileMs);
    p.portions = splitPortion(filterOverlapGroups(p.sent), ownMs, ms);
    return p.portions;
  }

  /** Start polling and sending: the check slice first, then each lane's slices (count before compare). */
  start(deadlineInMs: number): void {
    const plans = [...this.lanePlans.values()];
    // No lane got a share: nothing to ask the helper for, and no polling.
    if (plans.length === 0) return;
    this.poller = this.poll();
    this.senders.push(this.sendAll(plans, deadlineInMs).catch((e) => this.log({ event: 'borrowed-flow-error', step: 'send', detail: String(e instanceof Error ? e.message : e).slice(0, 200) })));
  }

  private async sendAll(plans: LanePlan[], deadlineInMs: number): Promise<void> {
    // Slices need a prepared tree: wait for it (the server asked for it when the verify started).
    while (!this.stopped && this.treeState.state !== 'ready') {
      if (this.treeState.state === 'failed') { this.log({ event: 'borrowed-tree-failed' }); return; }
      await this.d.sleep(LANE_FLOW.pollMs);
    }
    if (this.stopped) return;
    const deadline = () => Math.max(1_000, Math.min(60 * 60_000, deadlineInMs));
    // The check slice, always first.
    this.checkLane = plans[0].lane;
    this.checkId = await this.sendSlice(plans[0].lane, 'check', [...BORROWED_CANARY_FILES], LANE_FLOW.sliceBudgetMs[plans[0].lane], deadline(), null);
    // Retrials: learned files due, compare-only, in their own slice.
    const due = this.plan.learned.filter((e) => e.retrialDue).map((e) => e.file).slice(0, LANE_FLOW.retrialMax);
    for (const lane of FLOW_LANES) {
      const files = due.filter((f) => isBorrowableTestFile(f, lane));
      if (files.length > 0 && this.lanePlans.has(lane)) await this.sendSlice(lane, 'compare', files, LANE_FLOW.sliceBudgetMs[lane], deadline(), null, true);
    }
    const ordered = [...plans].sort((a, b) => (a.mode === b.mode ? 0 : a.mode === 'count' ? -1 : 1));
    lanes: for (const p of ordered) {
      const parts: Array<{ files: string[]; shard: number | null }> = p.mode === 'count'
        ? p.portions.flatMap((files, k) => files.length > 0 ? [{ files, shard: k }] : [])
        : [{ files: p.sent, shard: null }];
      let n = 0;
      for (const part of parts) {
        const tp = Math.max(1e-6, this.plan.throughput);
        const dur = (f: string) => (Number.isFinite(this.durations[f]) && this.durations[f] > 0 ? this.durations[f] : LANE_FLOW.unknownFileMs);
        const slices = planSlices({ files: part.files.map((f) => ({ file: f, ms: dur(f) })), budgetMs: LANE_FLOW.sliceBudgetMs[p.lane], throughput: tp, sendLocalMs: Number.POSITIVE_INFINITY }).slices;
        for (const s of slices) {
          for (let i = 0; i < s.length; i += LANE_FLOW.maxFilesPerSlice) {
            if (this.stopped) return;
            // This lane's slice cap: the rest of its files run here; the next lane still gets its share.
            if (n >= LANE_FLOW.maxSlicesPerLane) continue lanes;
            await this.sendSlice(p.lane, p.mode === 'count' ? 'count' : 'compare', s.slice(i, i + LANE_FLOW.maxFilesPerSlice), LANE_FLOW.sliceBudgetMs[p.lane], deadline(), part.shard);
            n++;
          }
        }
      }
    }
  }

  private async sendSlice(lane: FlowLane, use: 'check' | 'count' | 'compare', files: string[], budgetMs: number, deadlineInMs: number, shard: number | null, retrial = false): Promise<string | null> {
    if (this.stopped) return null;
    const r = await this.d.call({ op: 'slice', lane, files, use, budgetMs, deadlineInMs, ...(retrial ? { retrial: true } : {}) }).catch(() => null);
    const id = r && r.ok === true && typeof r.attemptId === 'string' && /^[0-9a-f]{32}$/.test(r.attemptId) ? r.attemptId : null;
    if (!id) { this.log({ event: 'borrowed-slice-not-sent', lane, use, files: files.length, reason: typeof r?.reason === 'string' ? r.reason.slice(0, 60) : 'no-helper-answer' }); return null; }
    this.issued.set(id, { lane, files: [...files], use, shard, done: false });
    return id;
  }

  private async poll(): Promise<void> {
    while (!this.stopped) {
      await this.pollOnce();
      if (this.stopped) break;
      await this.d.sleep(LANE_FLOW.pollMs);
    }
  }

  /** Ask once for finished slices after the last seen sequence number. */
  async pollOnce(): Promise<void> {
    const st = parseStatusFacts(await this.d.call({ op: 'status', since: this.lastSeq }).catch(() => null));
    if (!st) return;
    this.treeState = st.tree;
    // The read position moves only past results this flow knows: a result can arrive before its
    // slice's id is recorded here (the send's answer still on its way), and is read again next time.
    // A result still unknown after 3 polls is not this flow's and is passed.
    let advance = true;
    for (const r of [...st.results].sort((a, b) => a.seq - b.seq)) {
      const iss = this.issued.get(r.attemptId);
      if (!iss) {
        const n = (this.unknownSeen.get(r.attemptId) ?? 0) + 1;
        this.unknownSeen.set(r.attemptId, n);
        if (n < 3) advance = false;
        if (advance && r.seq > this.lastSeq) this.lastSeq = r.seq;
        continue;
      }
      if (advance && r.seq > this.lastSeq) this.lastSeq = r.seq;
      // Interim states are not results.
      if (r.state === 'queued' || r.state === 'preparing') continue;
      if (!this.results.has(r.attemptId)) this.results.set(r.attemptId, r);
      iss.done = true;
    }
  }

  /** The check slice's verdict at this moment: right, wrong, or not (yet) answered. */
  check(): 'right' | 'wrong' | null {
    if (!this.checkId) return null;
    const r = this.results.get(this.checkId);
    if (!r) return null;
    if (!r.valid || r.treeHash !== this.mergeTree) return 'wrong';
    return checkSliceRight(r) ? 'right' : 'wrong';
  }

  /** Every usable helper file result of a lane: valid answer, this tree, no slice trouble, not the check slice. */
  private usable(lane: FlowLane, use?: 'count' | 'compare'): Map<string, HelperFileResult> {
    const out = new Map<string, HelperFileResult>();
    for (const [id, r] of this.results) {
      const iss = this.issued.get(id)!;
      if (iss.lane !== lane || iss.use === 'check' || (use && iss.use !== use)) continue;
      if (!r.valid || r.treeHash !== this.mergeTree || sliceTrouble(r)) continue;
      if (r.state !== 'done' && r.state !== 'handed-back' && r.state !== 'cancelled') continue;
      for (const p of r.perFile) if (iss.files.includes(p.file)) out.set(p.file, p);
    }
    return out;
  }

  /**
   * TAKE-BACK for one shard of a counting lane, when its own files are done: every group of its
   * portion without an accepted pass, plus the spot re-runs drawn among the passed groups. The
   * passes are frozen now; answers arriving later are late. The check slice not yet answered (or
   * wrong), or a mass disagreement so far, takes back the whole portion. Cancels what it takes back.
   */
  async takeBack(lane: FlowLane, shard: number): Promise<{ files: string[]; spot: string[] }> {
    const p = this.lanePlans.get(lane);
    const portion = p && p.mode === 'count' ? p.portions[shard] ?? [] : [];
    if (portion.length === 0) return { files: [], spot: [] };
    await this.pollOnce().catch(() => undefined);
    const passes = this.usable(lane, 'count');
    const accepted = new Map<string, HelperFileResult>();
    const back: string[] = [];
    const spot: string[] = [];
    const checkOk = this.check() === 'right';
    const mass = this.disagreementsSoFar > LANE_FLOW.massDisagreement;
    for (const g of filterOverlapGroups(portion)) {
      const all = !mass && checkOk && g.every((f) => { const r = passes.get(f); return !!r && isCountablePass(r, this.baselineRows.get(f), this.changed.has(f)); });
      if (!all) { back.push(...g); continue; }
      // Each passed file is drawn on its own; a drawn file takes its whole overlap group with it.
      if (g.some(() => drawSpot(this.plan.spotOneIn, this.d.randomInt))) { spot.push(...g); continue; }
      for (const f of g) accepted.set(f, passes.get(f)!);
    }
    this.frozen.set(`${lane}#${shard}`, accepted);
    const s = this.spotFiles.get(lane) ?? new Set<string>();
    for (const f of spot) s.add(f);
    this.spotFiles.set(lane, s);
    this.takenBackCount.set(lane, (this.takenBackCount.get(lane) ?? 0) + back.length);
    // Cancel this shard's slices that have not finished.
    const open = [...this.issued.entries()].filter(([, i]) => i.lane === lane && i.shard === shard && !i.done).map(([id]) => id);
    if (open.length > 0) await this.cancel(open);
    this.log({ event: 'borrowed-take-back', lane, shard, portion: portion.length, accepted: accepted.size, takenBack: back.length, spot: spot.length, check: this.check(), mass });
    return { files: [...back, ...spot].sort(), spot: spot.sort() };
  }

  /** Every pass accepted at take-back for a lane (all shards). */
  acceptedPasses(lane: FlowLane): Map<string, HelperFileResult> {
    const out = new Map<string, HelperFileResult>();
    for (const [k, m] of this.frozen) if (k.startsWith(`${lane}#`)) for (const [f, r] of m) out.set(f, r);
    return out;
  }

  /** Disagreements seen so far in this verify (spot re-runs and compare slices), for the mass rule. */
  noteDisagreements(n: number): void { this.disagreementsSoFar += n; }
  massDisagreement(): boolean { return this.disagreementsSoFar > LANE_FLOW.massDisagreement; }
  markFinalLocalPass(lane: FlowLane): void { this.finalPass.add(lane); }

  /**
   * Compare a lane's helper results with its final local results (spec "Practice", "Spot re-runs",
   * "A confirmed wrong pass"). `local`: the files the run machine ran itself, with digest and
   * failed names. Returns the comparisons; disagreements count toward the mass rule.
   */
  compareLane(lane: FlowLane, local: ReadonlyMap<string, { failed: number; digest: string | null; failedTests: readonly string[] }>, solo: { failed: ReadonlySet<string>; passed: ReadonlySet<string> }): Map<string, FileComparison> {
    const out = new Map<string, FileComparison>();
    for (const [file, h] of this.usable(lane)) {
      const l = local.get(file);
      if (!l) continue;
      out.set(file, compareFile(l, h, { soloFailed: solo.failed.has(file), passedAlone: solo.passed.has(file) }));
    }
    return out;
  }

  /** Cancel slices by id (bounded batches). */
  async cancel(ids: readonly string[]): Promise<void> {
    for (let i = 0; i < ids.length; i += 400) {
      await this.d.call({ op: 'cancel', attemptIds: ids.slice(i, i + 400) }).catch(() => null);
      for (const id of ids.slice(i, i + 400)) { const x = this.issued.get(id); if (x) x.done = true; }
    }
  }

  /** A lane ended: its outstanding slices are cancelled (practice never waits for a helper). */
  async laneEnded(lane: FlowLane): Promise<void> {
    await this.pollOnce().catch(() => undefined);
    const open = [...this.issued.entries()].filter(([, i]) => i.lane === lane && !i.done && i.use !== 'check').map(([id]) => id);
    if (open.length > 0) await this.cancel(open);
  }

  /** Stop sending and polling (the verify's lanes are over). Never awaits past a bounded wait. */
  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.race([Promise.allSettled([this.poller, ...this.senders]), this.d.sleep(LANE_FLOW.callTimeoutMs + 1_000)]);
  }

  /**
   * The flow's result for the server: per lane what was sent and finished, every comparison, the
   * check slice, each answer's validity, and the locally failed files for the failing-direction
   * request. `comparisons` and `localFailed` come from the orchestrator after the lane's final result.
   */
  result(per: Partial<Record<FlowLane, { comparisons: ReadonlyMap<string, FileComparison>; counted: readonly string[]; localFailed: Array<{ file: string; failedTests: string[]; confirmed: boolean }> }>>): BorrowedFlowResult {
    const lanes: Partial<Record<FlowLane, LaneOutcomeWire>> = {};
    const sentFiles: Partial<Record<FlowLane, string[]>> = {};
    let disagreements = 0;
    for (const lane of FLOW_LANES) {
      const p = this.lanePlans.get(lane);
      const ids = [...this.issued.entries()].filter(([, i]) => i.lane === lane);
      if (!p && ids.length === 0) continue;
      const sent = [...new Set(ids.filter(([, i]) => i.use !== 'check').flatMap(([, i]) => i.files))].sort();
      const finished = new Set<string>();
      const answers: Array<'valid' | 'invalid'> = [];
      let discarded = 0;
      for (const [id, i] of ids) {
        const r = this.results.get(id);
        if (!r) continue;
        const ok = r.valid && (r.treeHash === null || r.treeHash === this.mergeTree);
        answers.push(ok ? 'valid' : 'invalid');
        if (!ok || i.use === 'check') continue;
        if (r.state === 'done' || r.state === 'handed-back') {
          if (sliceTrouble(r)) { discarded++; continue; }
          for (const f of r.perFile) finished.add(f.file);
        }
      }
      const c = per[lane]?.comparisons ?? new Map<string, FileComparison>();
      const pick = (k: FileComparison) => [...c.entries()].filter(([, v]) => v === k).map(([f]) => f).sort();
      const o: LaneOutcomeWire = {
        sent: sent.length, finished: finished.size,
        agreed: pick('agreed'), digestDiffersBothPass: pick('digest-differs-both-pass'), helperFailedLocalPassed: pick('helper-failed-local-passed'),
        confirmedWrongPasses: pick('confirmed-wrong-pass'), failingAgreed: pick('failing-agreed'),
        environmentDifferences: pick('environment-difference').length,
        check: this.checkLane === lane ? this.check() : null,
        answers,
        counted: [...(per[lane]?.counted ?? [])].sort(),
        takenBack: this.takenBackCount.get(lane) ?? 0,
        spot: [...(this.spotFiles.get(lane) ?? [])].sort(),
        late: this.lateCount(lane),
        discardedSlices: discarded,
        retrial: this.plan.learned.filter((e) => e.retrialDue && sent.includes(e.file)).map((e) => e.file),
        localFailed: (per[lane]?.localFailed ?? []).slice(0, LANE_FLOW.localFailedMax),
        finalLocalPass: this.finalPass.has(lane),
      };
      disagreements += [...c.values()].filter(isDisagreement).length;
      lanes[lane] = o;
      sentFiles[lane] = sent;
    }
    return { helper: this.plan.helper, assigned: this.plan.assigned ?? 'compare-only', treeHash: this.mergeTree, lanes, sentFiles, disagreements };
  }

  /** Count-slice files whose usable answer arrived after their shard's take-back froze. */
  private lateCount(lane: FlowLane): number {
    const p = this.lanePlans.get(lane);
    if (!p || p.mode !== 'count') return 0;
    const usable = this.usable(lane, 'count');
    let n = 0;
    p.portions.forEach((portion, k) => {
      const fr = this.frozen.get(`${lane}#${k}`);
      if (!fr) return;
      for (const f of portion) if (usable.has(f) && !fr.has(f) && !(this.spotFiles.get(lane)?.has(f))) n++;
    });
    return n;
  }
}

/** One git command in the verifier's bare clone: its exit status and output. */
export type GitRun = (args: string[]) => Promise<{ status: number | null; stdout: string }>;

/** `git ls-tree -r` output → path → blob id. */
function blobs(lsTree: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of lsTree.split('\n')) {
    const m = /^\d+ blob ([0-9a-f]{40,64})\t(.+)$/.exec(line);
    if (m) out.set(m[2], m[1]);
  }
  return out;
}

/**
 * The baseline rows this verify may use (spec "Build decisions"), against the verifier's own clone:
 * the newest kept baseline whose commit is `baseSha` or an ancestor of it, and only the rows of
 * files whose content in the merge tree equals their content at that commit. Any git failure means
 * no baseline, and then nothing counts on this verify.
 */
export async function selectVerifyBaseline(
  baselines: readonly MainBaseline[], baseSha: string, mergeCommit: string, git: GitRun,
): Promise<{ commit: string | null; rows: Map<string, FileCountsRow> }> {
  const ancestry = new Map<string, boolean | null>();
  for (const b of baselines) {
    if (b.commit === baseSha) { ancestry.set(b.commit, true); continue; }
    if (!/^[0-9a-f]{40}$/.test(b.commit)) { ancestry.set(b.commit, null); continue; }
    const r = await git(['merge-base', '--is-ancestor', b.commit, baseSha]).catch(() => ({ status: null, stdout: '' }));
    ancestry.set(b.commit, r.status === 0 ? true : r.status === 1 ? false : null);
  }
  const base = usableBaseline(baselines, baseSha, (c) => ancestry.get(c) ?? null);
  if (!base) return { commit: null, rows: new Map() };
  const at = await git(['ls-tree', '-r', base.commit]).catch(() => ({ status: null, stdout: '' }));
  const merged = await git(['ls-tree', '-r', mergeCommit]).catch(() => ({ status: null, stdout: '' }));
  if (at.status !== 0 || merged.status !== 0) return { commit: base.commit, rows: new Map() };
  const a = blobs(at.stdout);
  const m = blobs(merged.stdout);
  return { commit: base.commit, rows: selectBaselineRows(base, Object.keys(base.files), (f) => a.get(f) ?? null, (f) => m.get(f) ?? null) };
}

/** Whether this change edits the fixture files of the check slice: then the verify sends no slices. Pure. */
export function editsCheckFixtures(changed: ReadonlySet<string> | null): boolean {
  if (!changed) return true;
  for (const f of changed) if (f.startsWith(BORROWED_CANARY_DIR)) return true;
  return false;
}

/** The production proxy call: loopback only, the verify's attempt token, a 5-second limit, any failure null. */
export function loopbackProxy(port: number, token: string, fetchImpl: typeof fetch = fetch): ProxyCall {
  return async (body) => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), LANE_FLOW.callTimeoutMs);
    t.unref?.();
    try {
      const r = await fetchImpl(`http://127.0.0.1:${port}${LANE_FLOW.proxyPath}`, {
        method: 'POST', signal: ac.signal,
        headers: { 'Content-Type': 'application/json', [LANE_FLOW.tokenHeader]: token },
        body: JSON.stringify(body),
      });
      if (r.status !== 200) return null;
      const j = await r.json() as unknown;
      return isObj(j) ? j : null;
    } catch { return null; } // @silent-fallback-ok: no helper answer; the files run locally
    finally { clearTimeout(t); }
  };
}
