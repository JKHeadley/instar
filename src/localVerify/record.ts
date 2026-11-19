/**
 * A preflight field is evidence about an attempt, not independent proof of full-suite green.
 * The local-verify record (spec local-verify-merge-authority.md §2 step 6, Keys).
 *
 * Records are keyed by (repo, pr, headSha, baseRefName); execution is
 * deduplicated separately by (headSha, baseSha). The commit-status
 * description puts the state label first and is cut to GitHub's 140-char limit.
 */

import type { LaneTotals } from './laneReport.js';
import { isBoundedFailedFileSet } from './failedFileDiagnosis.js';
import { isTracePath } from '../../scripts/lib/instar-dev-trace.mjs';

export type VerifyOutcome = 'success' | 'failure' | 'error';

/** Bounded early-test evidence. It never authorizes a green merge verdict. */
export interface PreflightEvidence {
  mode: 'observe' | 'enforce';
  outcome: 'pass' | 'red' | 'skip' | 'timeout' | 'error';
  reason: string;
  elapsedMs: number;
  changedFiles: number;
  selectedFiles: string[];
  selectedCases: number;
  headSha: string;
  baseSha: string;
  /** Present only when two trusted attempts failed assertions in this selected file. */
  repeatedFailedFile?: string;
}

export const PREFLIGHT_MAX_SELECTED_FILES = 5;

export interface LocalVerifyRecord {
  repo: string;
  pr: number;
  headSha: string;
  baseSha: string;
  baseRefName: string;
  /** The merge commit's tree SHA (from `git merge-tree --write-tree`); '' only on an `error` that stopped before it. */
  mergeTree: string;
  lanes: LaneTotals[];
  nodeVersion: string;
  machineId: string;
  startedAt: string;
  finishedAt: string;
  outcome: VerifyOutcome;
  /** For outcome 'error': the step whose deadline or failure ended the run. */
  errorStep?: string;
  harnessChanging: boolean;
  protectedPath: boolean;
  skipsAdded: boolean;
  testsRemoved: boolean;
  verifierVersion: string;
  policyHash: string;
  /**
   * A flagged record's independent second-pass review (spec "Harness-changing PRs"):
   * an instar-dev trace the PR changed, read from the head's tree, whose second pass
   * concurred and whose coveredFiles include every flagged path. Absent = none found.
   */
  independentReview?: { trace: string; concurred: true };
  /**
   * 'main' for a post-merge verify of `main` itself (piece 3a): pr is 0, headSha == baseSha,
   * and the record never enters the PR index or journal (it feeds main health only).
   * Absent on every PR record.
   */
  kind?: 'main';
  /**
   * Files that failed in their lane and then passed when re-run alone in the same verify:
   * once, or three times in a row for an import-related file whose failed tests `main` has
   * shown flaky (the evidence-per-run form of the spec's "known-flaky" idea, Throughput
   * budget; spec local-verify-import-related-rerun.md). Present only when at least one file
   * was re-run and passed; the lane then counted as passing. Each one is a tracked item to
   * fix (`local-verify:flaky:<file>`).
   */
  flakyRetried?: FlakyRetry[];
  /** Complete failed test-file set when a full PR run failed in 1–3 inventoried files. */
  failedFiles?: string[];
  /**
   * Present only on a record a PEER verifier produced for a coordinator's hand-off
   * (spec local-verify-capacity.md Part D): the attempt it answers, the coordinator that
   * dispatched it and that coordinator's lease epoch at dispatch. The coordinator imports
   * a peer record only when all three match its own dispatch marker.
   */
  attempt?: PeerAttemptRef;
  /** Diagnostic or early-red preflight evidence, validated before journal/peer import. */
  preflight?: PreflightEvidence;
}

export interface PeerAttemptRef {
  /** 32 lowercase hex characters (16 random bytes). */
  id: string;
  coordinatorMachineId: string;
  /** The coordinator's serving-lease epoch when it dispatched (null when the pool reports none). */
  leaseEpoch: number | null;
}

export const ATTEMPT_ID_RE = /^[0-9a-f]{32}$/;

export function isValidAttemptRef(a: unknown): a is PeerAttemptRef {
  if (!a || typeof a !== 'object') return false;
  const x = a as Record<string, unknown>;
  return typeof x.id === 'string' && ATTEMPT_ID_RE.test(x.id)
    && typeof x.coordinatorMachineId === 'string' && x.coordinatorMachineId.length > 0 && x.coordinatorMachineId.length <= 200
    && (x.leaseEpoch === null || (typeof x.leaseEpoch === 'number' && Number.isSafeInteger(x.leaseEpoch) && x.leaseEpoch >= 0))
    && Object.keys(x).every((k) => k === 'id' || k === 'coordinatorMachineId' || k === 'leaseEpoch');
}

/** One cleared test of an import-related clear: when `main` showed it flaky, and both failure lines. */
export interface FlakyEvidence {
  test: string;
  /** When a `main` verify saw this test fail in its lane and pass alone by name. */
  mainAt: string;
  /** The distinguishing error line on `main` and in this PR run, each bounded with its disclosure. */
  mainLine: string;
  prLine: string;
  /** Set when the stored line was shortened: open the full output. */
  mainLineCut?: true;
  prLineCut?: true;
  /** The run log of that `main` verify (a file name under `state/local-verify/runs/` on the machine that ran it). */
  mainRunLog: string;
}

/**
 * One file that failed in its lane and then passed alone. Spec
 * local-verify-import-related-rerun.md "Recording": the SHARED name fields may ride on any
 * entry (PR or `main`, plain or import-related); the CLEARANCE fields only with
 * `importRelated: true` (three consecutive by-name solo passes on named main evidence).
 */
export interface FlakyRetry {
  file: string;
  lane: string;
  /** The first run's failure (first failing test + message), bounded. */
  firstMessage: string;
  /** Shared: full names of the tests that failed in the lane run, at most 20, each whole (a longer name is left out). */
  failedTests?: string[];
  /** Shared: the true number of failed tests, so a shorter list is disclosed. */
  failedTestsTotal?: number;
  /** Shared: the subset of `failedTests` reported passed by name in the solo run (in all three for a clear). */
  soloPassedByName?: string[];
  /** Shared: sha256 of the file's full test names in report (definition) order in the lane run. */
  testSetHash?: string;
  /** Clearance: the file imports a file the PR changed and was cleared on main evidence. */
  importRelated?: true;
  /** Clearance: always 3. */
  soloPasses?: 3;
  /** Clearance: the three solo runs' wall seconds. */
  soloSeconds?: number[];
  /** Clearance: one entry per cleared test, in `failedTests` order. */
  evidence?: FlakyEvidence[];
}

/** The record-side bounds of the name fields (mirrors policy.ts IMPORT_RELATED_RERUN; record.ts imports no policy). */
const NAME_FIELDS = Object.freeze({ names: 20, nameChars: 300, lineChars: 400, runLogChars: 200 });

/** Shared and clearance field rules of one `flakyRetried` entry. Pure. */
function flakyNameFieldsOk(r: Record<string, unknown>): boolean {
  const isName = (v: unknown): v is string => typeof v === 'string' && v.length >= 1 && v.length <= NAME_FIELDS.nameChars;
  const names = r.failedTests;
  if (names !== undefined && !(Array.isArray(names) && names.length <= NAME_FIELDS.names && names.every(isName))) return false;
  const list = (names as string[] | undefined) ?? [];
  if (r.failedTestsTotal !== undefined && !(typeof r.failedTestsTotal === 'number' && Number.isSafeInteger(r.failedTestsTotal) && r.failedTestsTotal >= list.length)) return false;
  if (r.soloPassedByName !== undefined) {
    const p = r.soloPassedByName;
    if (!Array.isArray(p) || p.length > list.length || !p.every((n) => typeof n === 'string' && list.includes(n))) return false;
  }
  if (r.testSetHash !== undefined && !(typeof r.testSetHash === 'string' && /^[0-9a-f]{64}$/.test(r.testSetHash))) return false;
  const clearance = r.soloPasses !== undefined || r.soloSeconds !== undefined || r.evidence !== undefined;
  if (r.importRelated === undefined) return !clearance;
  if (r.importRelated !== true) return false;
  if (r.soloPasses !== 3) return false;
  if (!Array.isArray(r.soloSeconds) || r.soloSeconds.length !== 3 || !r.soloSeconds.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0)) return false;
  if (names === undefined || list.length < 1 || r.failedTestsTotal !== list.length) return false;
  const passed = r.soloPassedByName;
  if (!Array.isArray(passed) || passed.length !== list.length || !passed.every((n, i) => n === list[i])) return false;
  if (typeof r.testSetHash !== 'string') return false;
  const ev = r.evidence;
  if (!Array.isArray(ev) || ev.length !== list.length) return false;
  const line = (v: unknown) => typeof v === 'string' && v.length <= NAME_FIELDS.lineChars;
  return ev.every((e, i) => {
    const x = e as Record<string, unknown> | null;
    return !!x && typeof x === 'object' && x.test === list[i] && isIso(x.mainAt) && line(x.mainLine) && line(x.prLine)
      && (x.mainLineCut === undefined || x.mainLineCut === true) && (x.prLineCut === undefined || x.prLineCut === true)
      && typeof x.mainRunLog === 'string' && x.mainRunLog.length <= NAME_FIELDS.runLogChars;
  });
}

/** At most this many flaky entries on a record (the re-run cap is smaller). */
export const FLAKY_RETRIED_MAX = 10;

/** The `pr` value a `main` verify carries (records keyed by PR never use it). */
export const MAIN_VERIFY_PR = 0;

export const SHA40 = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
// git check-ref-format essentials: no spaces, control chars, ~^:?*[\, no "..", no leading "-" or "/".
const REF = /^(?!-)(?!\/)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[^\s~^:?*[\\\x00-\x1f\x7f]+(?<!\/)(?<!\.lock)(?<!\.)$/;
const STATUS_LIMIT = 140;

export function isValidPr(pr: unknown): pr is number {
  return typeof pr === 'number' && Number.isSafeInteger(pr) && pr > 0;
}

export function isValidSha(s: unknown): s is string {
  return typeof s === 'string' && SHA40.test(s);
}

function isIso(s: unknown): s is string {
  return typeof s === 'string' && !Number.isNaN(Date.parse(s)) && /^\d{4}-\d{2}-\d{2}T/.test(s);
}

export function validateRecord(r: unknown): { ok: true; record: LocalVerifyRecord } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!r || typeof r !== 'object') return { ok: false, errors: ['not-an-object'] };
  const x = r as Record<string, unknown>;
  if (typeof x.repo !== 'string' || !REPO.test(x.repo)) errors.push('repo');
  if (x.kind !== undefined && x.kind !== 'main') errors.push('kind');
  if (x.kind === 'main') {
    if (x.pr !== MAIN_VERIFY_PR) errors.push('pr');
    if (x.headSha !== x.baseSha) errors.push('main-head-ne-base');
  } else if (!isValidPr(x.pr)) errors.push('pr');
  if (!isValidSha(x.headSha)) errors.push('headSha');
  if (!isValidSha(x.baseSha)) errors.push('baseSha');
  // An `error` run may stop before the merge tree exists (a fetch failure, a conflict).
  if (!isValidSha(x.mergeTree) && !(x.outcome === 'error' && x.mergeTree === '')) errors.push('mergeTree');
  if (typeof x.baseRefName !== 'string' || !REF.test(x.baseRefName)) errors.push('baseRefName');
  if (!Array.isArray(x.lanes) || !x.lanes.every((l) => {
    if (!l || typeof l !== 'object') return false;
    const t = l as Record<string, unknown>;
    return typeof t.name === 'string' && typeof t.gating === 'boolean'
      && ['files', 'tests', 'failed', 'seconds'].every((k) => typeof t[k] === 'number' && Number.isFinite(t[k] as number) && (t[k] as number) >= 0);
  })) errors.push('lanes');
  for (const k of ['nodeVersion', 'machineId', 'verifierVersion', 'policyHash'] as const) {
    if (typeof x[k] !== 'string' || (x[k] as string).length === 0) errors.push(k);
  }
  if (!isIso(x.startedAt)) errors.push('startedAt');
  if (!isIso(x.finishedAt)) errors.push('finishedAt');
  if (isIso(x.startedAt) && isIso(x.finishedAt) && Date.parse(x.finishedAt) < Date.parse(x.startedAt)) errors.push('finishedAt<startedAt');
  if (x.outcome !== 'success' && x.outcome !== 'failure' && x.outcome !== 'error') errors.push('outcome');
  if (x.errorStep !== undefined && typeof x.errorStep !== 'string') errors.push('errorStep');
  for (const k of ['harnessChanging', 'protectedPath', 'skipsAdded', 'testsRemoved'] as const) {
    if (typeof x[k] !== 'boolean') errors.push(k);
  }
  if (x.flakyRetried !== undefined) {
    const ok = Array.isArray(x.flakyRetried) && x.flakyRetried.length <= FLAKY_RETRIED_MAX && x.flakyRetried.every((f) => {
      const r = f as Record<string, unknown>;
      return !!r && typeof r.file === 'string' && r.file.length > 0 && r.file.length <= 300 && typeof r.lane === 'string'
        && typeof r.firstMessage === 'string' && r.firstMessage.length <= 2000 && flakyNameFieldsOk(r);
    });
    if (!ok) errors.push('flakyRetried');
  }
  if (x.failedFiles !== undefined) {
    if (!isBoundedFailedFileSet(x.failedFiles) || x.outcome !== 'failure' || x.kind === 'main') errors.push('failedFiles');
  }
  if (x.independentReview !== undefined) {
    const ir = x.independentReview as Record<string, unknown> | null;
    if (!ir || typeof ir !== 'object' || ir.concurred !== true || !isTracePath(ir.trace)) errors.push('independentReview');
  }
  // A `main` verify a peer ran for the coordinator carries its attempt like any peer record.
  if (x.attempt !== undefined && !isValidAttemptRef(x.attempt)) errors.push('attempt');
  if (x.preflight !== undefined) {
    const p = x.preflight as Record<string, unknown> | null;
    const isCount = (n: unknown, max: number) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= max;
    const selected = p && Array.isArray(p.selectedFiles) && p.selectedFiles.length <= PREFLIGHT_MAX_SELECTED_FILES
      && p.selectedFiles.every((f) => typeof f === 'string' && f.length > 0 && f.length <= 300 && !f.startsWith('/') && !f.includes('..') && !f.includes('\\'));
    const valid = p && x.kind !== 'main'
      && (p.mode === 'observe' || p.mode === 'enforce')
      && ['pass', 'red', 'skip', 'timeout', 'error'].includes(String(p.outcome))
      && typeof p.reason === 'string' && p.reason.length <= 200
      && isCount(p.elapsedMs, 90_000)
      && isCount(p.changedFiles, p.outcome === 'skip' ? 10_000 : 40)
      && selected && isCount(p.selectedCases, p.outcome === 'skip' ? 10_000 : 200)
      && p.headSha === x.headSha && p.baseSha === x.baseSha
      && (p.repeatedFailedFile === undefined || (typeof p.repeatedFailedFile === 'string' && (p.selectedFiles as string[]).includes(p.repeatedFailedFile)))
      && (p.outcome !== 'red' || (p.repeatedFailedFile !== undefined && (p.selectedCases as number) > 0))
      && (p.mode !== 'enforce' || p.outcome !== 'red' || (p.reason === 'preflight-red' && x.outcome === 'failure' && Array.isArray(x.lanes) && x.lanes.length === 0))
      && (p.mode !== 'observe' || !(x.outcome === 'failure' && Array.isArray(x.lanes) && x.lanes.length === 0 && p.outcome === 'red'))
      && Object.keys(p).every((k) => ['mode', 'outcome', 'reason', 'elapsedMs', 'changedFiles', 'selectedFiles', 'selectedCases', 'headSha', 'baseSha', 'repeatedFailedFile'].includes(k));
    if (!valid) errors.push('preflight');
  }
  return errors.length ? { ok: false, errors } : { ok: true, record: x as unknown as LocalVerifyRecord };
}

/** Record key: (repo, pr, headSha, baseRefName). Throws on invalid parts. */
export function recordKey(repo: string, pr: number, headSha: string, baseRefName: string): string {
  if (!REPO.test(repo)) throw new Error(`invalid repo: ${repo}`);
  if (!isValidPr(pr)) throw new Error(`invalid pr: ${pr}`);
  if (!isValidSha(headSha)) throw new Error(`invalid headSha: ${headSha}`);
  if (!REF.test(baseRefName)) throw new Error(`invalid baseRefName: ${baseRefName}`);
  return JSON.stringify([repo, pr, headSha, baseRefName]);
}

/** Execution dedup key: the merge-tree inputs. */
export function executionKey(headSha: string, baseSha: string): string {
  if (!isValidSha(headSha) || !isValidSha(baseSha)) throw new Error('invalid sha');
  return `${headSha}:${baseSha}`;
}

/** The state label that leads the status description. */
export function stateLabel(r: Pick<LocalVerifyRecord, 'outcome' | 'errorStep' | 'harnessChanging' | 'protectedPath' | 'skipsAdded' | 'testsRemoved'>): string {
  if (r.outcome === 'error') return r.errorStep ? `error:${r.errorStep}` : 'error';
  if (r.outcome === 'failure') return 'failed';
  const flags: string[] = [];
  if (r.harnessChanging) flags.push('harness-changing');
  if (r.protectedPath) flags.push('protected-path');
  if (r.skipsAdded) flags.push('skips-added');
  if (r.testsRemoved) flags.push('tests-removed');
  return flags.length ? flags.join('+') : 'verified';
}

function wall(startedAt: string, finishedAt: string): string {
  const s = Math.max(0, Math.round((Date.parse(finishedAt) - Date.parse(startedAt)) / 1000));
  if (!Number.isFinite(s)) return '?';
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h${m % 60}m` : m > 0 ? `${m}m${s % 60}s` : `${s}s`;
}

/** Status description: label, wall time, per-lane counts; at most 140 characters. */
export function statusDescription(r: LocalVerifyRecord): string {
  const lanes = r.lanes.map((l) => `${l.name} ${l.tests}t/${l.failed}f`).join(' ');
  const full = `${stateLabel(r)} · ${wall(r.startedAt, r.finishedAt)} · ${lanes}`.trim();
  if (full.length <= STATUS_LIMIT) return full;
  return full.slice(0, STATUS_LIMIT - 1) + '…';
}
