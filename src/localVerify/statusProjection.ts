/**
 * The projection of server state onto the `instar/local-verify` commit status
 * (spec docs/specs/local-verify-merge-authority.md §3 "The required status is the
 * merge authority GitHub enforces" … "Withdrawal"). Pure: no I/O, no clock.
 *
 * - Local floor, eligible PR: `success` only when the whole §3 authorization holds
 *   except the merge-time body checks ("What success requires, in full").
 * - Actions floor, or an ineligible PR: a mirror of the Actions-floor contexts,
 *   decided by the SAME evaluation function safe-merge uses (passed in), over a
 *   context list that is an INPUT (never hard-coded here), and EXCLUDING
 *   `instar/local-verify` itself (or the mirror could never bootstrap).
 * - Shared heads: a status belongs to a commit; `success` only when every open PR
 *   to `main` with that head is authorized.
 */

import type { LocalVerifyRecord } from './record.js';
import { statusDescription } from './record.js';
import type { MainHealthState } from './mainHealth.js';

/** The commit-status context the server posts. */
export const LOCAL_VERIFY_STATUS_CONTEXT = 'instar/local-verify';

const STATUS_LIMIT = 140;

export type ProjectedState = 'success' | 'pending' | 'failure';
export type FloorMode = 'local' | 'actions';

export interface Projection {
  state: ProjectedState;
  /** At most 140 characters, state label first. */
  description: string;
  /** Machine-readable reason (audit, `/local-verify/status`). */
  reason: string;
}

export interface ContextPin { context: string; workflowPath?: string; appSlug?: string }

export interface CheckRunView {
  name: string;
  /** `queued` | `in_progress` | `completed` (absent ⇒ completed when a conclusion is present). */
  status?: string | null;
  conclusion: string | null;
  appSlug: string | null;
  workflowPath: string | null;
}

/** safe-merge's `evaluateRequiredContexts` signature. */
export type EvaluateRequiredContexts = (args: {
  protectionContexts: string[];
  rulesetContexts: string[];
  floor: ContextPin[];
  extraFloor: string[];
  checkRuns: Array<{ name: string; conclusion: string; appSlug: string | null; workflowPath: string | null }>;
}) => { ok: boolean; problems: string[] };

export interface MirrorInput {
  /** The Actions-floor context list (REQUIRED_CONTEXTS_FLOOR + pinned classic contexts), an input. */
  floor: readonly ContextPin[];
  protectionContexts: readonly string[];
  rulesetContexts: readonly string[];
  /** Check runs on the head with producers; null when they could not be read. */
  checkRuns: readonly CheckRunView[] | null;
  evaluate: EvaluateRequiredContexts;
}

export interface MainHealthView {
  state: MainHealthState;
  /** The current `main` head; null when unknown. */
  mainHeadSha: string | null;
}

export interface ProjectionPr {
  number: number;
  headSha: string;
  baseRefName: string;
  /** §2 eligibility (author is the agent or operator login, not cross-repository). */
  eligible: boolean;
  floor: FloorMode;
}

export interface ProjectionInput {
  pr: ProjectionPr;
  repo: string;
  /** The index record for (repo, pr, head, baseRefName), or null. */
  record: LocalVerifyRecord | null;
  /** A verify of exactly (pr, head) is queued or running. */
  verifying: boolean;
  mainHealth: MainHealthView;
  /** Required for the mirror (actions floor or ineligible); ignored on the local floor. */
  mirror?: MirrorInput;
}

function clip(s: string): string {
  return s.length <= STATUS_LIMIT ? s : s.slice(0, STATUS_LIMIT - 1) + '…';
}

function p(state: ProjectedState, reason: string, description?: string): Projection {
  return { state, reason, description: clip(description ?? reason) };
}

/** The local-floor authorization (§3 "What success requires, in full", minus shared heads). */
export function projectLocal(input: ProjectionInput): Projection {
  const { pr, record, mainHealth } = input;
  if (pr.baseRefName !== 'main') return p('pending', 'base-not-main');
  if (!record) return p('pending', input.verifying ? 'verifying' : 'awaiting-verify');
  if (record.kind !== undefined || record.repo !== input.repo || record.pr !== pr.number
    || record.headSha !== pr.headSha || record.baseRefName !== pr.baseRefName) {
    return p('pending', input.verifying ? 'verifying' : 'record-mismatch');
  }
  if (record.outcome !== 'success') {
    if (input.verifying) return p('pending', 'verifying');
    if (record.outcome === 'failure') return p('failure', 'verify-failed', statusDescription(record));
    return p('failure', 'verify-error', statusDescription(record));
  }
  const gating = record.lanes.filter((l) => l.gating);
  if (gating.length === 0 || gating.some((l) => l.failed !== 0 || l.tests <= 0 || l.files <= 0)) {
    return p('failure', 'lane-counts', `lane-counts · ${statusDescription(record)}`);
  }
  const flagged = record.harnessChanging || record.protectedPath || record.skipsAdded || record.testsRemoved;
  // A flagged record needs the independent second-pass review the verifier found in the
  // head's tree; operator approval is not part of it (directive 2026-10-22: the operator
  // approves constitution changes only, enforced by GitHub through CODEOWNERS).
  if (flagged && record.independentReview?.concurred !== true) {
    return p('pending', 'awaiting-independent-review', `awaiting-independent-review · ${statusDescription(record)}`);
  }
  if (mainHealth.state !== 'healthy') {
    // The repair exception: a record verified against the current `main` head.
    const repair = mainHealth.mainHeadSha !== null && record.baseSha === mainHealth.mainHeadSha;
    if (!repair) return p('pending', mainHealth.state, `${mainHealth.state} · repair-only`);
  }
  return p('success', 'authorized', statusDescription(record));
}

const FAILED_CONCLUSIONS = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale', 'skipped', 'neutral']);

/** The Actions-floor mirror. `instar/local-verify` is excluded from every list. */
export function projectMirror(m: MirrorInput): Projection {
  if (m.checkRuns === null) return p('pending', 'checks-unreadable');
  const notSelf = (c: string) => c !== LOCAL_VERIFY_STATUS_CONTEXT;
  const floor = m.floor.filter((f) => notSelf(f.context));
  const protectionContexts = m.protectionContexts.filter(notSelf);
  const rulesetContexts = m.rulesetContexts.filter(notSelf);
  const runs = m.checkRuns.filter((r) => notSelf(r.name));
  const verdict = m.evaluate({
    protectionContexts: [...protectionContexts],
    rulesetContexts: [...rulesetContexts],
    floor: floor.map((f) => ({ ...f })),
    extraFloor: [],
    checkRuns: runs.map((r) => ({ name: r.name, conclusion: r.conclusion ?? '', appSlug: r.appSlug, workflowPath: r.workflowPath })),
  });
  if (verdict.ok) return p('success', 'actions-floor-green', 'actions-floor green');
  // Not green: running (or not started yet) ⇒ pending; a completed non-success with
  // nothing still running ⇒ failure. A success from the wrong producer is a failure.
  const required = new Set([...protectionContexts, ...rulesetContexts, ...floor.map((f) => f.context)]);
  let running = false;
  const failed: string[] = [];
  for (const ctx of required) {
    const mine = runs.filter((r) => r.name === ctx);
    if (mine.some((r) => (r.conclusion ?? '').toLowerCase() === 'success')) continue;
    if (mine.length === 0 || mine.some((r) => (r.status ?? (r.conclusion ? 'completed' : 'in_progress')) !== 'completed')) { running = true; continue; }
    if (mine.some((r) => FAILED_CONCLUSIONS.has((r.conclusion ?? '').toLowerCase()))) failed.push(ctx);
    else running = true;
  }
  if (failed.length > 0) return p('failure', 'actions-floor-failed', `actions-floor failed: ${failed.join(', ')}`);
  if (running) return p('pending', 'actions-floor-running', 'actions-floor running');
  return p('failure', 'actions-floor-producer', `actions-floor wrong producer: ${verdict.problems.length} problem(s)`);
}

/** One PR's projection on its floor. */
export function projectPr(input: ProjectionInput): Projection {
  if (input.pr.floor === 'local' && input.pr.eligible) return projectLocal(input);
  if (!input.mirror) return p('pending', 'mirror-unavailable');
  return projectMirror(input.mirror);
}

/**
 * A head's projection across every open PR to `main` that has it: `success` only
 * if all are authorized; otherwise `failure` if any projects failure, else `pending`.
 */
export function projectHead(inputs: readonly ProjectionInput[]): Projection & { prs: Array<{ pr: number; state: ProjectedState; reason: string }> } {
  const toMain = inputs.filter((i) => i.pr.baseRefName === 'main');
  if (toMain.length === 0) return { ...p('pending', 'no-pr-to-main'), prs: [] };
  const each = toMain.map((i) => ({ i, proj: projectPr(i) }));
  const prs = each.map(({ i, proj }) => ({ pr: i.pr.number, state: proj.state, reason: proj.reason }));
  if (each.every((e) => e.proj.state === 'success')) {
    return { ...each[0].proj, prs };
  }
  const shared = each.length > 1;
  const failing = each.find((e) => e.proj.state === 'failure');
  if (failing) {
    return { ...(shared ? { ...failing.proj, description: clip(`#${failing.i.pr.number} ${failing.proj.description}`) } : failing.proj), prs };
  }
  const pend = each.find((e) => e.proj.state === 'pending')!;
  const shareNote = shared && each.some((e) => e.proj.state === 'success');
  return {
    ...pend.proj,
    reason: shareNote ? `shared-head:${pend.proj.reason}` : pend.proj.reason,
    description: shareNote ? clip(`shared head: #${pend.i.pr.number} ${pend.proj.description}`) : pend.proj.description,
    prs,
  };
}
