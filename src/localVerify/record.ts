/**
 * The local-verify record (spec local-verify-merge-authority.md §2 step 6, Keys).
 *
 * Records are keyed by (repo, pr, headSha, baseRefName); execution is
 * deduplicated separately by (headSha, baseSha). The commit-status
 * description puts the state label first and is cut to GitHub's 140-char limit.
 */

import type { LaneTotals } from './laneReport.js';

export type VerifyOutcome = 'success' | 'failure' | 'error';

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
   * 'main' for a post-merge verify of `main` itself (piece 3a): pr is 0, headSha == baseSha,
   * and the record never enters the PR index or journal (it feeds main health only).
   * Absent on every PR record.
   */
  kind?: 'main';
  /**
   * Files that failed in their lane and then passed when re-run alone, once, in the same
   * verify (the evidence-per-run form of the spec's "known-flaky" idea, Throughput budget).
   * Present only when at least one file was re-run and passed; the lane then counted as
   * passing. Each one is a tracked item to fix (`local-verify:flaky:<file>`).
   */
  flakyRetried?: FlakyRetry[];
}

export interface FlakyRetry {
  file: string;
  lane: string;
  /** The first run's failure (first failing test + message), bounded. */
  firstMessage: string;
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
        && typeof r.firstMessage === 'string' && r.firstMessage.length <= 2000;
    });
    if (!ok) errors.push('flakyRetried');
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
