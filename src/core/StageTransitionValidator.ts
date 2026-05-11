/**
 * StageTransitionValidator — per-edge artifact preconditions for
 * `pipelineStage` transitions on project-scope child initiatives.
 *
 * Spec: docs/specs/PROJECT-SCOPE-SPEC.md Phase 1.2.
 *
 * Authority model (P1, signal-vs-authority):
 *   This module is the deterministic *authority* for stage transitions.
 *   Every check is an artifact assertion (file exists, frontmatter field
 *   equals a literal, `gh pr view` reports MERGED, git ancestor
 *   reachability). No LLM-mediated judgment lives here. The drift checker
 *   (Phase 1.4) emits a *signal* but does NOT call into this validator.
 *
 * Path safety:
 *   All filesystem references (specPath, convergence-report path) are
 *   realpath-resolved and must stay under `targetRepoPath` (or under
 *   `docs/specs/reports/` for the convergence report). Symlinks that
 *   escape are rejected.
 *
 * Reconciler-only transitions (`*-> regressed`) require
 * `ctx.bypassMode === 'reconciler'` to succeed; user-initiated requests
 * are rejected with code `REGRESSED_RECONCILER_ONLY`.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { PipelineStage } from './InitiativeTracker.js';
import { extractFrontmatter } from './SafeYaml.js';

export type StageTransitionResult =
  | { ok: true }
  | { ok: false; reason: string; code: string };

/**
 * Context passed in by the caller. Helpers are injected so unit tests can
 * mock the `gh pr view` shell-out and the `git merge-base` check without
 * touching real subprocesses.
 */
export interface ValidationContext {
  /** Absolute path to the target git repo whose artifacts we're checking. */
  targetRepoPath: string;
  /** Relative or absolute path to the spec markdown (jailed under targetRepoPath). */
  specPath?: string;
  /** Required for building → merged. */
  prNumber?: number;
  /** Required for approved → building. */
  taskFlowRecordId?: string;
  /** Required for any → skipped. */
  skippedReason?: string;
  skippedBy?: string;
  /** Required for skipped → outline. */
  unskippedAt?: string;
  /** Special-cased reconciler bypass for `*-> regressed` edges. */
  bypassMode?: 'reconciler';
  // Helpers (overridable for tests):
  readSpecFrontmatter?: (absPath: string) => Promise<unknown>;
  ghPrView?: (prNumber: number) => Promise<GhPrView>;
  gitMergeBaseIsAncestor?: (sha: string, branch: string) => boolean;
}

export interface GhPrView {
  state: string;
  mergeCommit: { oid: string } | null;
  statusCheckRollup: Array<{ conclusion?: string | null; status?: string | null; state?: string | null }>;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Validate a `from → to` transition under the given context.
 *
 * `from === undefined` is treated as "creation lands directly at `to`" and
 * the validator runs the same preconditions as if the prior stage were
 * exactly one step earlier in the canonical pipeline. This keeps create
 * paths honest without requiring callers to first stage at `outline`.
 */
export async function validateStageTransition(
  from: PipelineStage | undefined,
  to: PipelineStage,
  ctx: ValidationContext
): Promise<StageTransitionResult> {
  // ── skipped (any → skipped) ───────────────────────────────────────
  if (to === 'skipped') {
    if (!ctx.skippedReason || !ctx.skippedReason.trim()) {
      return { ok: false, reason: 'skippedReason required', code: 'SKIPPED_REASON_MISSING' };
    }
    if (!ctx.skippedBy || !ctx.skippedBy.trim()) {
      return { ok: false, reason: 'skippedBy required', code: 'SKIPPED_BY_MISSING' };
    }
    return { ok: true };
  }

  // ── regressed (reconciler-only) ──────────────────────────────────
  if (to === 'regressed') {
    if (from !== 'building' && from !== 'merged') {
      return {
        ok: false,
        reason: `regressed transitions only from building or merged, got "${from}"`,
        code: 'REGRESSED_BAD_FROM',
      };
    }
    if (ctx.bypassMode !== 'reconciler') {
      return {
        ok: false,
        reason: 'regressed transitions are reconciler-only',
        code: 'REGRESSED_RECONCILER_ONLY',
      };
    }
    return { ok: true };
  }

  // ── skipped → outline (resume) ───────────────────────────────────
  if (from === 'skipped' && to === 'outline') {
    if (!ctx.unskippedAt || !ctx.unskippedAt.trim()) {
      return { ok: false, reason: 'unskippedAt required for skipped → outline', code: 'UNSKIPPED_AT_MISSING' };
    }
    return { ok: true };
  }

  // ── outline → spec-drafted ───────────────────────────────────────
  if (to === 'spec-drafted') {
    if (!ctx.specPath || !ctx.specPath.trim()) {
      return { ok: false, reason: 'specPath required', code: 'SPEC_PATH_MISSING' };
    }
    const jailed = jailPath(ctx.targetRepoPath, ctx.specPath);
    if (!jailed.ok) return { ok: false, reason: jailed.reason, code: 'SPEC_PATH_ESCAPE' };
    if (!fs.existsSync(jailed.absPath)) {
      return { ok: false, reason: `spec file does not exist: ${ctx.specPath}`, code: 'SPEC_FILE_MISSING' };
    }
    if (!jailed.absPath.toLowerCase().endsWith('.md')) {
      return { ok: false, reason: 'spec must be a markdown (.md) file', code: 'SPEC_NOT_MARKDOWN' };
    }
    const fm = await loadFrontmatter(jailed.absPath, ctx.readSpecFrontmatter);
    if (!fm.ok) return { ok: false, reason: fm.error, code: 'SPEC_FRONTMATTER_INVALID' };
    return { ok: true };
  }

  // ── spec-drafted → spec-converged ────────────────────────────────
  if (to === 'spec-converged') {
    if (!ctx.specPath) {
      return { ok: false, reason: 'specPath required for convergence', code: 'SPEC_PATH_MISSING' };
    }
    const jailed = jailPath(ctx.targetRepoPath, ctx.specPath);
    if (!jailed.ok) return { ok: false, reason: jailed.reason, code: 'SPEC_PATH_ESCAPE' };
    const fm = await loadFrontmatter(jailed.absPath, ctx.readSpecFrontmatter);
    if (!fm.ok) return { ok: false, reason: fm.error, code: 'SPEC_FRONTMATTER_INVALID' };
    const data = fm.data;
    if (data['review-convergence'] !== true) {
      return {
        ok: false,
        reason: 'spec frontmatter must have `review-convergence: true`',
        code: 'CONVERGENCE_TAG_MISSING',
      };
    }
    const slug = typeof data.slug === 'string' ? data.slug : '';
    if (!SLUG_RE.test(slug)) {
      return {
        ok: false,
        reason: `spec slug "${slug}" does not match ^[a-z0-9][a-z0-9-]{0,63}$`,
        code: 'SLUG_INVALID',
      };
    }
    const reportRel = path.join('docs/specs/reports', `${slug}-convergence.md`);
    const reportJailed = jailPathUnderSubdir(ctx.targetRepoPath, 'docs/specs/reports', reportRel);
    if (!reportJailed.ok) {
      return { ok: false, reason: reportJailed.reason, code: 'CONVERGENCE_REPORT_ESCAPE' };
    }
    if (!fs.existsSync(reportJailed.absPath)) {
      return {
        ok: false,
        reason: `convergence report missing: ${reportRel}`,
        code: 'CONVERGENCE_REPORT_MISSING',
      };
    }
    return { ok: true };
  }

  // ── spec-converged → approved ────────────────────────────────────
  if (to === 'approved') {
    if (!ctx.specPath) {
      return { ok: false, reason: 'specPath required for approval', code: 'SPEC_PATH_MISSING' };
    }
    const jailed = jailPath(ctx.targetRepoPath, ctx.specPath);
    if (!jailed.ok) return { ok: false, reason: jailed.reason, code: 'SPEC_PATH_ESCAPE' };
    const fm = await loadFrontmatter(jailed.absPath, ctx.readSpecFrontmatter);
    if (!fm.ok) return { ok: false, reason: fm.error, code: 'SPEC_FRONTMATTER_INVALID' };
    const data = fm.data;
    if (data.approved !== true) {
      return { ok: false, reason: 'spec frontmatter must have `approved: true`', code: 'APPROVED_FLAG_MISSING' };
    }
    if (typeof data['approved-by'] !== 'string' || !data['approved-by']) {
      return { ok: false, reason: '`approved-by` required in spec frontmatter', code: 'APPROVED_BY_MISSING' };
    }
    if (typeof data['approved-date'] !== 'string' || !data['approved-date']) {
      return {
        ok: false,
        reason: '`approved-date` required in spec frontmatter',
        code: 'APPROVED_DATE_MISSING',
      };
    }
    return { ok: true };
  }

  // ── approved → building ──────────────────────────────────────────
  if (to === 'building') {
    if (!ctx.taskFlowRecordId || !ctx.taskFlowRecordId.trim()) {
      return {
        ok: false,
        reason: 'taskFlowRecordId required for approved → building',
        code: 'TASKFLOW_ID_MISSING',
      };
    }
    return { ok: true };
  }

  // ── building → merged ────────────────────────────────────────────
  if (to === 'merged') {
    if (typeof ctx.prNumber !== 'number' || !Number.isInteger(ctx.prNumber) || ctx.prNumber <= 0) {
      return { ok: false, reason: 'prNumber required for building → merged', code: 'PR_NUMBER_MISSING' };
    }
    if (!ctx.ghPrView) {
      return { ok: false, reason: 'ghPrView helper not provided', code: 'GH_PR_VIEW_UNAVAILABLE' };
    }
    let view: GhPrView;
    try {
      view = await ctx.ghPrView(ctx.prNumber);
    } catch (err) {
      return {
        ok: false,
        reason: `gh pr view failed: ${err instanceof Error ? err.message : String(err)}`,
        code: 'GH_PR_VIEW_FAILED',
      };
    }
    if (view.state !== 'MERGED') {
      return { ok: false, reason: `PR state is "${view.state}", expected "MERGED"`, code: 'PR_NOT_MERGED' };
    }
    const oid = view.mergeCommit?.oid;
    if (!oid || typeof oid !== 'string' || oid.length < 7) {
      return { ok: false, reason: 'mergeCommit.oid missing', code: 'MERGE_COMMIT_MISSING' };
    }
    if (!/^[0-9a-f]{7,64}$/i.test(oid)) {
      return { ok: false, reason: 'mergeCommit.oid is not a sha', code: 'MERGE_COMMIT_INVALID' };
    }
    if (!ctx.gitMergeBaseIsAncestor) {
      return {
        ok: false,
        reason: 'gitMergeBaseIsAncestor helper not provided',
        code: 'MERGE_BASE_HELPER_UNAVAILABLE',
      };
    }
    const ancestor = ctx.gitMergeBaseIsAncestor(oid, 'origin/main');
    if (!ancestor) {
      return {
        ok: false,
        reason: `mergeCommit.oid ${oid} is not reachable from origin/main`,
        code: 'MERGE_COMMIT_UNREACHABLE',
      };
    }
    if (!ciIsGreen(view.statusCheckRollup)) {
      return { ok: false, reason: 'CI rollup is not green', code: 'CI_NOT_GREEN' };
    }
    return { ok: true };
  }

  // ── outline (creation default) ───────────────────────────────────
  if (to === 'outline') {
    // Creating a new child at outline has no preconditions other than the
    // tracker's own validation. We accept it here so the validator is a
    // single chokepoint.
    return { ok: true };
  }

  return { ok: false, reason: `unsupported target stage "${to}"`, code: 'UNSUPPORTED_TARGET' };
}

// ── Helpers ────────────────────────────────────────────────────────

interface JailResult {
  ok: true;
  absPath: string;
}

interface JailFail {
  ok: false;
  reason: string;
}

/**
 * Resolve `rel` under `root` and assert that the realpath of the resulting
 * path remains inside `root`. Rejects:
 *   - absolute paths that aren't under root
 *   - `..` traversal that escapes
 *   - symlinks whose realpath escapes
 *
 * If the target file does not yet exist, the realpath check walks up to the
 * nearest existing ancestor (because realpath() on a missing path throws).
 */
export function jailPath(root: string, rel: string): JailResult | JailFail {
  if (!root || !path.isAbsolute(root)) {
    return { ok: false, reason: `targetRepoPath must be absolute, got "${root}"` };
  }
  let absRoot: string;
  try {
    absRoot = fs.realpathSync(root);
  } catch {
    return { ok: false, reason: `targetRepoPath does not exist: ${root}` };
  }
  const joined = path.isAbsolute(rel) ? rel : path.join(absRoot, rel);
  const normalized = path.normalize(joined);
  // Resolve realpath up to the nearest existing prefix; reject if the
  // resolved prefix isn't under root.
  const real = realpathToNearestExisting(normalized);
  const withSep = absRoot.endsWith(path.sep) ? absRoot : absRoot + path.sep;
  if (real !== absRoot && !real.startsWith(withSep)) {
    return { ok: false, reason: `path "${rel}" escapes targetRepoPath` };
  }
  return { ok: true, absPath: real };
}

function jailPathUnderSubdir(root: string, subdir: string, rel: string): JailResult | JailFail {
  const outer = jailPath(root, rel);
  if (!outer.ok) return outer;
  const subRel = path.join(root, subdir);
  let subReal: string;
  try {
    subReal = fs.realpathSync(subRel);
  } catch {
    // Subdir doesn't exist yet; the file under it can't exist either.
    return { ok: false, reason: `directory "${subdir}" does not exist under targetRepoPath` };
  }
  const sep = subReal.endsWith(path.sep) ? subReal : subReal + path.sep;
  if (outer.absPath !== subReal && !outer.absPath.startsWith(sep)) {
    return { ok: false, reason: `path "${rel}" is not under ${subdir}` };
  }
  return outer;
}

function realpathToNearestExisting(p: string): string {
  let cur = p;
  // Walk up until a path exists, realpath it, then re-join the tail.
  const tail: string[] = [];
  while (cur !== path.dirname(cur)) {
    try {
      const real = fs.realpathSync(cur);
      return tail.length === 0 ? real : path.join(real, ...tail.reverse());
    } catch {
      tail.push(path.basename(cur));
      cur = path.dirname(cur);
    }
  }
  // Reached filesystem root.
  return p;
}

async function loadFrontmatter(
  absPath: string,
  injected?: (absPath: string) => Promise<unknown>
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }> {
  try {
    let raw: unknown;
    if (injected) {
      raw = await injected(absPath);
    } else {
      const text = fs.readFileSync(absPath, 'utf-8');
      const fm = extractFrontmatter(text);
      if (fm.error) return { ok: false, error: fm.error };
      raw = fm.frontmatter ?? {};
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: 'frontmatter is not a mapping' };
    }
    return { ok: true, data: raw as Record<string, unknown> };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function ciIsGreen(rollup: GhPrView['statusCheckRollup']): boolean {
  if (!Array.isArray(rollup) || rollup.length === 0) {
    // Empty rollup = no checks defined. Per spec we treat green as
    // "no failing checks" — an empty rollup is acceptable (small repos
    // without CI). This matches `gh pr merge --auto` semantics.
    return true;
  }
  for (const check of rollup) {
    const concl = (check.conclusion ?? check.state ?? '').toUpperCase();
    const status = (check.status ?? '').toUpperCase();
    if (status && status !== 'COMPLETED' && status !== 'SUCCESS' && status !== 'NEUTRAL') {
      // Still in-flight / queued — not green yet.
      return false;
    }
    if (concl && concl !== 'SUCCESS' && concl !== 'SKIPPED' && concl !== 'NEUTRAL') {
      return false;
    }
  }
  return true;
}
