#!/usr/bin/env node
/**
 * safe-merge — merge a PR ONLY after every check (incl. the e2e job) is green.
 *
 * Why: we merge with `gh pr merge --admin` to jump the hot-branch queue, but
 * `--admin` BYPASSES branch-protection's required-checks enforcement — which is
 * how PR #381 merged while the `E2E Tests` job was red and turned main red for
 * everyone. This wrapper re-imposes the requirement that `--admin` removes.
 *
 * Hardened per docs/specs/green-pr-automerge-enforcement.md §3.1:
 *  - strict argv (unknown flags REJECTED), `--capabilities` contract probe
 *  - `--repo <owner/name>` parameter (default: the historical constant)
 *  - JSON checks parsing (no human-output regex; `pending` matched on the
 *    bucket field, never on check NAMES)
 *  - required-contexts cross-check: union of classic branch protection +
 *    rulesets + a CODE-PINNED floor with PRODUCER binding (app slug +
 *    workflow file path) — a lookalike job reporting the right name from a
 *    tampered workflow does not satisfy the floor. Any fetch/parse failure is
 *    a refusal (`refused:contexts-unverifiable`), never a silent degrade.
 *  - refuses when unsatisfied required-review protection exists
 *  - head pinning: merges with `--match-head-commit <sha>` (provided by the
 *    caller or pinned at verification time) — a push in the window refuses
 *  - honest exits: classified result line on stdout; null spawn status or
 *    signal kill is an error, never success
 *  - `--delete-branch` pass-through; `--deadline-ms` so the caller's timeout
 *    and the internal wait can never invert (B24)
 *
 * Usage:  node scripts/safe-merge.mjs <PR#> [--auto|--admin] [--squash|--merge|--rebase]
 *           [--repo <owner/name>] [--delete-branch] [--deadline-ms <n>]
 *
 *   --auto  PREFERRED. Arms GitHub native auto-merge and returns immediately —
 *           GitHub merges the instant every required check passes, enforcing
 *           branch protection itself (no --admin bypass) and never timing out.
 *           Requires "Allow auto-merge" enabled on the repo. Exit 5 = armed,
 *           exit 0 = merged immediately (checks were already green).
 *   --admin Legacy synchronous path: polls for green, re-imposes the required
 *           contexts that --admin would bypass, then merges. Use only when the
 *           repo has auto-merge disabled.
 *           [--match-head-commit <sha>] [--extra-floor <ctx,ctx>]
 *           [--attempt-token <hex>]  (caller identity only; ignored by the merge)
 *         node scripts/safe-merge.mjs --capabilities
 *
 * Exit codes: 0 merged (independently confirmed) · 1 refused · 2 usage/error
 *             3 already-merged · 4 closed-without-merge
 * The final stdout line is always `safe-merge-result: {...}` with a
 * machine-parseable classification.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkPrDescriptionEli16 } from './eli16-pr-description-check.mjs';
import { evaluateDecisionAuditPresence } from './decision-audit-presence-check.mjs';
import { checkReleaseFragment } from './check-release-fragment.mjs';
import { MERGE_FLOOR_MODES, selectMergeFloor, isMergeEligible, approvedAtHead, extractRulesetReviewPolicy, reviewPrecheckPasses } from './local-verify-floor.mjs';

export { extractRulesetReviewPolicy };

export const CONTRACT_VERSION = 2;
export const DEFAULT_REPO = 'JKHeadley/instar';
export const DEFAULT_DEADLINE_MS = 20 * 60 * 1000;

/**
 * Code-pinned required-contexts floor (spec §3.1). Each entry is
 * PRODUCER-bound: the check run satisfying it must come from the pinned app
 * slug AND the pinned workflow file path. Config/CLI extension may EXTEND
 * this list, never shrink it. Grounded against .github/workflows/ on
 * 2026-06-12: ci.yml job display names; decision-audit-gate.yml job id
 * `decision-audit`; eli16-pr-gate.yml job id `eli16`.
 * (The matrix-expanded unit shards are pinned separately in
 * CLASSIC_PROTECTION_CONTEXTS_PINNED and joined into ACTIONS_FLOOR_CONTEXTS,
 * the floor safe-merge actually enforces.)
 */
export const REQUIRED_CONTEXTS_FLOOR = [
  { context: 'Type Check', workflowPath: '.github/workflows/ci.yml', appSlug: 'github-actions' },
  { context: 'Integration Tests', workflowPath: '.github/workflows/ci.yml', appSlug: 'github-actions' },
  { context: 'E2E Tests', workflowPath: '.github/workflows/ci.yml', appSlug: 'github-actions' },
  { context: 'Build', workflowPath: '.github/workflows/ci.yml', appSlug: 'github-actions' },
  { context: 'decision-audit', workflowPath: '.github/workflows/decision-audit-gate.yml', appSlug: 'github-actions' },
  { context: 'eli16', workflowPath: '.github/workflows/eli16-pr-gate.yml', appSlug: 'github-actions' },
];

/**
 * The commit-status context that `local-verify` posts
 * (docs/specs/local-verify-merge-authority.md §3). It is a COMMIT STATUS, not
 * a check run: wherever it is required it is read through the combined-status
 * API (`GET /commits/{sha}/status`) and is green iff that entry is `success`.
 * It is never searched among check runs, and it is never part of the Actions
 * floor below (the server's mirror posts it FROM that floor, so including it
 * would make the mirror wait on itself).
 */
export const LOCAL_VERIFY_CONTEXT = 'instar/local-verify';

/**
 * The 12 contexts `main`'s CLASSIC branch protection requires, pinned in code
 * with their producer (read from `GET /repos/JKHeadley/instar/branches/main`
 * → `protection.required_status_checks`, 2026-10-21; all are ci.yml jobs —
 * the unit shards are the matrix-expanded `Unit Tests (node N, shard K/4)`).
 * Pinned because the unit shards have only ever been required through classic
 * protection: a reader that cannot see protection (or a fork merge decided by
 * the mirror) would otherwise merge without unit tests.
 */
export const CLASSIC_PROTECTION_CONTEXTS_PINNED = [
  'Type Check',
  'Integration Tests',
  'E2E Tests',
  'Build',
  ...[20, 22].flatMap(node => [1, 2, 3, 4].map(shard => `Unit Tests (node ${node}, shard ${shard}/4)`)),
].map(context => ({ context, workflowPath: '.github/workflows/ci.yml', appSlug: 'github-actions' }));

/**
 * The ONE shared Actions-floor constant: `REQUIRED_CONTEXTS_FLOOR` extended
 * with the pinned classic-protection contexts, deduplicated by context name,
 * EXCLUDING `instar/local-verify`. Used by safe-merge's own Actions floor and
 * (later) by the server-side local-verify mirror, both through
 * `evaluateRequiredContexts` — there is no second implementation.
 */
export const ACTIONS_FLOOR_CONTEXTS = Object.freeze(
  [...REQUIRED_CONTEXTS_FLOOR, ...CLASSIC_PROTECTION_CONTEXTS_PINNED]
    .filter((pin, i, all) => pin.context !== LOCAL_VERIFY_CONTEXT &&
      all.findIndex(p => p.context === pin.context) === i)
    .map(pin => Object.freeze({ ...pin })));

const ALLOWED_FLAGS = new Set([
  '--admin', '--auto', '--squash', '--merge', '--rebase', '--delete-branch', '--capabilities',
]);
const ALLOWED_VALUE_FLAGS = new Set([
  '--repo', '--deadline-ms', '--match-head-commit', '--extra-floor', '--request-review-from',
  '--attempt-token',
]);

/** Strict argv parser — unknown flags are REJECTED (spec §3.1: a stale or
 * confused caller must fail loudly, not have its intent silently ignored). */
export function parseArgs(argv) {
  const out = {
    pr: null, repo: DEFAULT_REPO, method: '--merge', admin: false, auto: false,
    deleteBranch: false, deadlineMs: DEFAULT_DEADLINE_MS,
    matchHeadCommit: null, extraFloor: [], capabilities: false,
    // Logins to request review from when the base branch requires a non-pusher
    // approval (2026-08-22). Empty ⇒ default to the repo owner at act time.
    requestReviewFrom: [],
    // The MergeRunner's per-attempt token, carried on argv so a surviving
    // orphan's identity can be confirmed with `ps -o args=` on macOS as well
    // as Linux. Identity only — it changes nothing about the merge.
    attemptToken: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (/^\d+$/.test(a)) {
      if (out.pr !== null) throw new UsageError(`duplicate PR number: ${a}`);
      out.pr = a;
      continue;
    }
    if (ALLOWED_VALUE_FLAGS.has(a)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${a} requires a value`);
      if (a === '--repo') {
        if (!/^[\w.-]+\/[\w.-]+$/.test(v)) throw new UsageError(`--repo must be owner/name, got: ${v}`);
        out.repo = v;
      } else if (a === '--deadline-ms') {
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) throw new UsageError(`--deadline-ms must be a positive number, got: ${v}`);
        out.deadlineMs = n;
      } else if (a === '--match-head-commit') {
        if (!/^[0-9a-f]{7,40}$/i.test(v)) throw new UsageError(`--match-head-commit must be a commit SHA, got: ${v}`);
        out.matchHeadCommit = v;
      } else if (a === '--extra-floor') {
        out.extraFloor = v.split(',').map(s => s.trim()).filter(Boolean);
      } else if (a === '--request-review-from') {
        const logins = v.split(',').map(s => s.trim()).filter(Boolean);
        for (const l of logins) {
          if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(l)) throw new UsageError(`--request-review-from must be GitHub logins, got: ${l}`);
        }
        out.requestReviewFrom = logins;
      } else if (a === '--attempt-token') {
        if (!/^[0-9a-f]{8,64}$/i.test(v)) throw new UsageError(`--attempt-token must be hex, got: ${v}`);
        out.attemptToken = v;
      }
      continue;
    }
    if (ALLOWED_FLAGS.has(a)) {
      if (a === '--admin') out.admin = true;
      else if (a === '--auto') out.auto = true;
      else if (a === '--delete-branch') out.deleteBranch = true;
      else if (a === '--capabilities') out.capabilities = true;
      else out.method = a; // --squash | --merge | --rebase
      continue;
    }
    throw new UsageError(`unknown flag: ${a} (strict argv — see --capabilities for the contract)`);
  }
  if (!out.capabilities && out.pr === null) throw new UsageError('a PR number is required');
  // --auto (native GitHub auto-merge: GitHub enforces every required check
  // before merging) and --admin (bypass-then-re-impose) are contradictory
  // strategies — refuse the incoherent combo rather than silently pick one.
  if (out.auto && out.admin) throw new UsageError('--auto and --admin are mutually exclusive: --auto relies on GitHub native required-check enforcement, --admin bypasses it');
  return out;
}

export class UsageError extends Error {}

export function capabilities() {
  return {
    contract: CONTRACT_VERSION,
    features: [
      'strict-argv', 'repo-param', 'json-checks', 'head-pinning',
      'required-contexts-cross-check', 'producer-binding', 'floor',
      'reviews-required-refusal', 'classified-exits', 'delete-branch', 'deadline-ms',
      'native-auto-merge', 'auto-arm-unavailable-detection',
      'approval-required-refusal', 'request-review-from', 'local-floor', 'attempt-token',
    ],
    floorModes: [...MERGE_FLOOR_MODES],
    exitCodes: { merged: 0, refused: 1, usageOrError: 2, alreadyMerged: 3, closed: 4, autoMergeArmed: 5 },
  };
}

/** Classify `gh pr checks --json` rows. `pending` is matched ONLY on the
 * bucket field — a check NAMED "block-pending-migrations" never loops the
 * wait (the round-1 foundation bug). */
export function classifyChecks(rows) {
  const pending = [];
  const failed = [];
  let sawE2e = false;
  let e2ePassed = false;
  for (const row of rows) {
    const name = String(row.name ?? '');
    const bucket = String(row.bucket ?? '').toLowerCase();
    if (!name) continue;
    if (bucket === 'pending') { pending.push(name); continue; }
    const ok = bucket === 'pass' || bucket === 'skipping';
    if (/e2e/i.test(name)) {
      sawE2e = true;
      if (bucket === 'pass') e2ePassed = true;
    }
    if (!ok) failed.push(`${name}: ${bucket}`);
  }
  return { pending, failed, sawE2e, e2ePassed, settled: pending.length === 0 };
}

/**
 * Required-contexts cross-check (spec §3.1).
 *
 * The verification set is the UNION of:
 *   - classic branch protection `required_status_checks.contexts`
 *   - branch-ruleset required_status_checks entries
 *   - the code-pinned floor (+ any caller extension)
 * The floor stays enforced even when protection's own list omits it — a
 * confused protection edit (or config write) cannot delete the guarantee.
 *
 * Every context in the set must have a genuinely-successful check run on the
 * verified head (skipped/neutral on a REQUIRED context = refusal). Floor
 * entries additionally require a PRODUCER match: the satisfying run's app
 * slug and workflow file path must equal the pins — name-matching alone is
 * explicitly insufficient.
 *
 * @param {object} args
 * @param {string[]} args.protectionContexts  contexts from classic protection
 * @param {string[]} args.rulesetContexts     contexts from branch rulesets
 * @param {Array<{context: string, workflowPath?: string, appSlug?: string}>} args.floor
 * @param {string[]} args.extraFloor          name-only extension (config/CLI)
 * @param {Array<{name: string, conclusion: string, appSlug: string|null, workflowPath: string|null}>} args.checkRuns
 * @param {Array<{context: string, state: string}>} [args.commitStatuses]
 *   entries of the combined-status API for the head. Consulted ONLY for
 *   `instar/local-verify`, which is a commit status and is never looked for
 *   among check runs (green iff its entry is `success`).
 */
export function evaluateRequiredContexts({ protectionContexts, rulesetContexts, floor, extraFloor, checkRuns, commitStatuses = [] }) {
  const problems = [];
  const successByName = new Map();
  for (const run of checkRuns) {
    if (String(run.conclusion ?? '').toLowerCase() === 'success') {
      const list = successByName.get(run.name) ?? [];
      list.push(run);
      successByName.set(run.name, list);
    }
  }
  const union = new Set([
    ...protectionContexts,
    ...rulesetContexts,
    ...floor.map(f => f.context),
    ...extraFloor,
  ]);
  for (const ctx of union) {
    if (ctx === LOCAL_VERIFY_CONTEXT) {
      const entry = (commitStatuses ?? []).find(st => st?.context === LOCAL_VERIFY_CONTEXT);
      const state = String(entry?.state ?? '').toLowerCase();
      if (state !== 'success') {
        problems.push(`required status "${ctx}" is ${entry ? `"${state || 'unknown'}"` : 'absent'} on the head (want "success")`);
      }
      continue;
    }
    if (!successByName.has(ctx)) {
      problems.push(`required context "${ctx}" has no genuinely-successful run`);
    }
  }
  for (const pin of floor) {
    if (pin.context === LOCAL_VERIFY_CONTEXT) continue; // a commit status, decided above
    const runs = successByName.get(pin.context) ?? [];
    if (runs.length === 0) continue; // already reported above
    const producerOk = runs.some(r =>
      (!pin.appSlug || r.appSlug === pin.appSlug) &&
      (!pin.workflowPath || r.workflowPath === pin.workflowPath));
    if (!producerOk) {
      problems.push(
        `floor context "${pin.context}" succeeded but from the WRONG producer ` +
        `(want app=${pin.appSlug} workflow=${pin.workflowPath}; ` +
        `got ${runs.map(r => `app=${r.appSlug} workflow=${r.workflowPath}`).join(' | ')})`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/** Classify the merge outcome from gh's stderr/exit (spec §3.1 honest exits). */
export function classifyMergeFailure(stderrText, status, signal) {
  const text = String(stderrText ?? '');
  if (/already merged/i.test(text)) return 'already-merged';
  if (/(pull request .* is closed|state.*closed|not open)/i.test(text)) return 'closed';
  if (signal) return `error:signal-${signal}`;
  if (status === null) return 'error:null-status';
  return 'error:merge-command-failed';
}

/**
 * Ruleset review policy on the base branch (2026-08-22).
 *
 * `fetchProtectionContexts` reads CLASSIC branch protection only. A repo RULESET
 * can ALSO demand reviews — `pull_request` rule with `required_approving_review_count`
 * and/or `require_last_push_approval` ("approval of the most recent reviewable push
 * by someone other than the pusher"). This wrapper never read that, so on
 * 2026-08-22 it declared PR #1963 green-and-mergeable, ran `gh pr merge`, and
 * GitHub refused with "New changes require approval from someone other than the
 * last pusher" — leaving the operator staring at a PR with NO reviewer requested
 * and a "waiting for someone to request your review" dead end instead of an
 * Approve button. Reading the ruleset BEFORE merging is what lets us request the
 * review up front and hand the operator a link that ends in one click.
 *
 * Pure: takes the parsed `/repos/{repo}/rules/branches/{branch}` array.
 */

/**
 * GitHub's refusal text when a non-pusher approval is required (ruleset
 * `require_last_push_approval`, or classic last-push-approval). Matched on the
 * MERGE failure path as belt-and-braces for a ruleset that changes between the
 * pre-check and the merge, or one the pre-check could not read.
 */
export function isNonPusherApprovalRequired(stderrText) {
  const text = String(stderrText ?? '');
  return /approval from someone other than the last pusher/i.test(text)
    || /(Repository rule violations|review).*(approv|last pusher)/i.test(text);
}

/** The one link the operator needs: the PR's Files tab, where "Review changes → Approve" lives. */
export function reviewUrlFor(repo, pr) {
  return `https://github.com/${repo}/pull/${pr}/files`;
}

/**
 * The auto-merge-disabled discriminator (mergerunner-auto-arm-handoff §
 * "auto-merge-unavailable — terminal-non-ladder"). `classifyMergeFailure`
 * collapses BOTH "auto-merge is OFF on the repo" (a PERMANENT condition) and a
 * generic transient gh failure into `error:merge-command-failed`. The
 * orchestrator must be able to tell those apart so it does not burn three
 * pointless ladder attempts on a repo setting that will never flip on its own.
 * On the --auto refusal path ONLY, we match gh's stderr against the
 * auto-merge-disabled signature; on a match the result slug becomes the DISTINCT
 * `refused:auto-arm-unavailable` (the orchestrator keys terminal-non-ladder on
 * exactly this slug). A generic gh error keeps `refused:auto-arm-error:*`.
 */
export function isAutoMergeUnavailable(stderrText) {
  const text = String(stderrText ?? '');
  return /auto.?merge.*(not\s*(allowed|enabled))|allow\s*auto-?merge/i.test(text);
}

// ---------------------------------------------------------------------------
// The `local` floor (docs/specs/local-verify-merge-authority.md §3)
// ---------------------------------------------------------------------------

/** The merge-time body checks safe-merge runs itself under the `local` floor. */
export const LOCAL_FLOOR_BODY_CHECKS = Object.freeze(['eli16', 'decision-audit', 'release-fragment']);
const SHA40_RE = /^[0-9a-f]{40}$/;
const MAIN_HEALTH_STATES = new Set(['healthy', 'main-suspect', 'main-red']);

/** Refusal for anything the local floor cannot measure. Never an Actions fallback. */
export const UNMEASURABLE = 'refused:verify-record-unmeasurable';

/**
 * The §3 predicate, pure. Every input was read by the caller from the server
 * index (never a file on disk) or re-read from GitHub just now.
 *
 * @param {object} a
 * @param {string} a.repo                      the repo being merged
 * @param {number} a.pr
 * @param {{headRefOid: string, baseRefName: string}} a.livePr  fresh GitHub re-read
 * @param {object|null} a.record               the server index record (null = absent)
 * @param {{state: string, mainHead: string|null}|null} a.mainHealth
 * @param {Array<{name: string, ok: boolean, detail?: string}>} a.bodyChecks
 * @param {boolean} a.operatorApprovedHead
 * @param {{matches: boolean, reason?: string}|null} a.approverAcceptance  (needed only on the approval path)
 * @returns {{ok: true} | {ok: false, result: string, problems: string[]}}
 */
export function evaluateLocalPredicate(a) {
  const refuse = (result, ...problems) => ({ ok: false, result, problems });
  const r = a.record;
  if (!r || typeof r !== 'object') return refuse(UNMEASURABLE, 'no local-verify record in the server index for this (pr, head, base)');
  const mismatch = [];
  if (r.repo !== a.repo) mismatch.push(`repo ${r.repo} ≠ ${a.repo}`);
  if (r.pr !== Number(a.pr)) mismatch.push(`pr ${r.pr} ≠ ${a.pr}`);
  if (!SHA40_RE.test(String(a.livePr?.headRefOid ?? '')) || r.headSha !== a.livePr.headRefOid) mismatch.push(`head ${r.headSha} ≠ live ${a.livePr?.headRefOid}`);
  if (r.baseRefName !== a.livePr?.baseRefName) mismatch.push(`base ${r.baseRefName} ≠ live ${a.livePr?.baseRefName}`);
  if (mismatch.length) return refuse('refused:verify-record-mismatch', ...mismatch);
  if (r.outcome !== 'success') return refuse('refused:verify-failed', `record outcome is ${r.outcome}`);
  const gating = Array.isArray(r.lanes) ? r.lanes.filter(l => l && l.gating === true) : [];
  if (gating.length === 0) return refuse('refused:verify-lanes', 'the record has no gating lane');
  const badLanes = gating.filter(l => !(l.failed === 0 && l.tests > 0 && l.files > 0));
  if (badLanes.length) {
    return refuse('refused:verify-lanes', ...badLanes.map(l => `lane ${l.name}: failed=${l.failed} tests=${l.tests} files=${l.files}`));
  }
  const mh = a.mainHealth;
  if (!mh || !MAIN_HEALTH_STATES.has(mh.state)) return refuse(UNMEASURABLE, 'main health unreadable');
  if (mh.state !== 'healthy') {
    if (!SHA40_RE.test(String(mh.mainHead ?? '')) || r.baseSha !== mh.mainHead) {
      return refuse('refused:main-red', `main is ${mh.state}; only a record verified against the current main head (${mh.mainHead ?? 'unknown'}) is admitted, this one was verified against ${r.baseSha}`);
    }
  }
  const failedChecks = (a.bodyChecks ?? []).filter(c => !c.ok);
  if (!Array.isArray(a.bodyChecks) || a.bodyChecks.length === 0) return refuse(UNMEASURABLE, 'merge-time body checks did not run');
  if (failedChecks.length) return refuse('refused:body-checks', ...failedChecks.map(c => `${c.name}: ${c.detail ?? 'failed'}`));
  const FLAG_KEYS = ['harnessChanging', 'protectedPath', 'skipsAdded', 'testsRemoved'];
  // A flag that is not a boolean is unmeasurable, never "unflagged".
  const notBool = FLAG_KEYS.filter(k => typeof r[k] !== 'boolean');
  if (notBool.length) return refuse(UNMEASURABLE, `record flag(s) not boolean: ${notBool.join(', ')}`);
  const flags = FLAG_KEYS.filter(k => r[k] === true);
  if (flags.length) {
    if (a.operatorApprovedHead !== true) {
      return refuse('refused:needs-operator-approval', `the record is ${flags.join('+')}; the operator must approve exactly head ${r.headSha} on GitHub`);
    }
    if (a.approverAcceptance?.matches !== true) {
      return refuse('refused:approver-dependent', `approver dependence is not covered by a matching acceptance (${a.approverAcceptance?.reason ?? 'unknown'})`);
    }
  }
  return { ok: true };
}

/**
 * The outcome of `POST /local-verify` for the verify-pending detail: the
 * service's own status (queued / already-queued / in-flight / recorded) or
 * refusal code (untrusted-head / queue-full / …). null when the answer is
 * unreadable (a transport-level failure the caller treats as unmeasurable).
 */
export function verifyRequestOutcome(post) {
  const b = post?.body;
  if (!post || !b || typeof b !== 'object') return null;
  if (b.ok === true && typeof b.status === 'string') return b.status;
  if (b.ok === false && typeof b.code === 'string') return b.code;
  return null;
}

/**
 * Decision 16: reuse the feedback executor's approver-independence check and
 * its PIN acceptance, read from `GET /feedback-factory/execute/status`. The
 * acceptance counts only when the executor's approver IS the operator login
 * and the agent is either independent of it or the operator accepted exactly
 * the current sticky reason set. `null` body ⇒ the executor is not constructed.
 */
export function approverAcceptanceFromExecutorStatus(body, operatorGhLogin) {
  if (!body || typeof body !== 'object') return { matches: false, reason: 'executor-not-constructed' };
  const av = body.availability;
  if (!av || typeof av !== 'object') return { matches: false, reason: 'executor-availability-unread' };
  const op = String(operatorGhLogin ?? '').toLowerCase();
  if (!op || String(av.approver ?? '').toLowerCase() !== op) return { matches: false, reason: `approver-not-operator (${av.approver ?? 'none'})` };
  const ind = av.independence;
  if (!ind || typeof ind !== 'object') return { matches: false, reason: 'independence-unread' };
  if (ind.independent === true) return { matches: true, reason: 'independent' };
  if (ind.accepted === true) return { matches: true, reason: 'accepted' };
  return { matches: false, reason: `not-accepted (${(ind.reasons ?? []).join(',') || 'unknown'})` };
}

const FILE_STATUS_TO_NAME_STATUS = { added: 'A', removed: 'D', modified: 'M', renamed: 'R', copied: 'C', changed: 'M', unchanged: 'M' };

/**
 * The merge-time body checks, run from THIS (trusted) copy of the checkers over
 * GitHub-read inputs: eli16 (PR body), decision-audit (changed files + the
 * records at the head), release-fragment (changed files).
 */
export function runLocalBodyChecks({ title, body, authorLogin, authorType, files, decisionRecords }) {
  const out = [];
  const e = checkPrDescriptionEli16({ body, title, authorType });
  out.push({ name: 'eli16', ok: e.ok, detail: e.ok ? undefined : e.reason });
  const changes = (files ?? []).map(f => ({ status: FILE_STATUS_TO_NAME_STATUS[f.status] ?? 'M', file: f.filename }));
  const d = evaluateDecisionAuditPresence({ changes, records: decisionRecords ?? [], title, authorType });
  out.push({ name: 'decision-audit', ok: d.ok, detail: d.ok ? undefined : `uncovered: ${(d.uncoveredFiles ?? d.inScopeFiles ?? []).slice(0, 5).join(', ')}` });
  const rf = checkReleaseFragment({ files: (files ?? []).map(f => ({ path: f.filename, status: f.status })), authorLogin, authorType, title });
  out.push({ name: 'release-fragment', ok: rf.ok, detail: rf.ok ? undefined : rf.reason });
  return out;
}

/** Decision-record files (added or modified at the head) the decision-audit check reads. */
export function decisionRecordPaths(files) {
  return (files ?? []).filter(f => f.status !== 'removed' && /^\.instar\/instar-dev-decisions\/.+\.json$/.test(f.filename)).map(f => f.filename);
}

/**
 * Read the agent's server endpoint and floor config from its config file only
 * (never the environment, so a session cannot point safe-merge at a stand-in
 * server). A vault-backed token (`{"secret": true}`) is resolved lazily by the
 * caller, only when the local floor actually needs the server.
 */
export function parseAgentServerConfig(text) {
  const cfg = JSON.parse(text);
  const gp = cfg?.monitoring?.greenPrAutoMerge ?? {};
  const lv = cfg?.monitoring?.localVerify ?? {};
  const raw = cfg?.authToken;
  const port = Number(cfg?.port);
  return {
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : null,
    tokenSource: typeof raw === 'string' && raw ? 'inline' : (raw && typeof raw === 'object' && raw.secret === true ? 'vault' : null),
    inlineToken: typeof raw === 'string' && raw ? raw : null,
    floor: gp.floor === 'local' ? 'local' : 'actions',
    repo: typeof gp.repo === 'string' && gp.repo ? gp.repo : DEFAULT_REPO,
    expectedGhLogin: typeof gp.expectedGhLogin === 'string' ? gp.expectedGhLogin : '',
    operatorGhLogin: typeof lv.operatorGhLogin === 'string' && lv.operatorGhLogin.trim() ? lv.operatorGhLogin.trim() : 'JKHeadley',
  };
}

/**
 * Floor selection for one safe-merge run (synchronous path only; `--auto`
 * keeps today's behaviour). Returns `{floor:'actions'}`, `{floor:'local',
 * status}` (the server's /local-verify/status body), or a refusal. Never
 * returns 'actions' because something was unreadable once the config floor is
 * `local` for an eligible PR of the configured repo.
 *
 * @param {object} a
 * @param {string} a.repo
 * @param {object} a.view        the `gh pr view` read (author, isCrossRepository)
 * @param {ReturnType<typeof parseAgentServerConfig>|null} a.agent  null = no config file
 * @param {string|undefined} a.override  INSTAR_MERGE_FLOOR
 * @param {(p: string) => Promise<{status: number, body: any}>} a.serverGet
 */
export async function selectSafeMergeFloor({ repo, view, agent, override, serverGet }) {
  if (override === 'actions') return { floor: 'actions', reason: 'override' };
  if (!agent) return { floor: 'actions', reason: 'no-agent-config' };
  const eligible = isMergeEligible(view, agent);
  const configured = selectMergeFloor({ effectiveFloor: agent.floor, configRepo: agent.repo, repo, eligible });
  if (configured !== 'local') return { floor: 'actions', reason: agent.floor !== 'local' ? 'config-actions' : (eligible ? 'other-repo' : 'ineligible') };
  let st;
  try { st = await serverGet('/local-verify/status'); } catch (e) {
    return { floor: 'local', refusal: { result: UNMEASURABLE, problems: [`server unreachable: ${String(e?.message ?? e).slice(0, 200)}`] } };
  }
  if (!st || st.status !== 200 || !st.body || typeof st.body !== 'object') {
    return { floor: 'local', refusal: { result: UNMEASURABLE, problems: [`GET /local-verify/status answered ${st?.status ?? 'nothing'}`] } };
  }
  const effective = st.body?.floor?.effective;
  if (effective === 'actions') return { floor: 'actions', reason: `server-effective-actions:${st.body?.floor?.reason ?? ''}` };
  if (effective !== 'local') return { floor: 'local', refusal: { result: UNMEASURABLE, problems: ['server floor unreadable'] } };
  return { floor: 'local', status: st.body };
}

/**
 * The §3 predicate's inputs, gathered fresh (server index + GitHub), then
 * judged by `evaluateLocalPredicate`. Any read failure is unmeasurable.
 *
 * @param {object} a
 * @param {string} a.repo
 * @param {number|string} a.pr
 * @param {string} a.pinnedHead           the head safe-merge pinned (must still be the head)
 * @param {object} a.status               /local-verify/status body
 * @param {ReturnType<typeof parseAgentServerConfig>} a.agent
 * @param {(p: string) => Promise<{status: number, body: any}>} a.serverGet
 * @param {(args: string[]) => any} a.ghJson
 * @param {(args: string[]) => string|null} a.ghText  raw text, null on failure
 * @param {(p: string, body: object) => Promise<{status: number, body: any}>} [a.serverPost]  enqueues a verify when there is no record
 */
export async function checkLocalFloor({ repo, pr, pinnedHead, status, agent, serverGet, serverPost, ghJson: readJson, ghText }) {
  const refuse = (result, ...problems) => ({ ok: false, result, problems });
  let live;
  try { live = readJson(['pr', 'view', String(pr), '--repo', repo, '--json', 'headRefOid,baseRefName,state,title,body,author']); } catch (e) {
    return refuse(UNMEASURABLE, `PR re-read failed: ${String(e?.message ?? e).slice(0, 200)}`);
  }
  if (!SHA40_RE.test(String(live?.headRefOid ?? '')) || typeof live?.baseRefName !== 'string') return refuse(UNMEASURABLE, 'PR re-read returned no valid head/base');
  if (live.headRefOid !== pinnedHead) return refuse('refused:head-moved', `head moved to ${live.headRefOid}`);
  const q = `?pr=${encodeURIComponent(String(pr))}&head=${live.headRefOid}&base=${encodeURIComponent(live.baseRefName)}`;
  let rec;
  try { rec = await serverGet(`/local-verify/record${q}`); } catch (e) {
    return refuse(UNMEASURABLE, `record read failed: ${String(e?.message ?? e).slice(0, 200)}`);
  }
  if (!rec || (rec.status !== 200 && rec.status !== 404)) return refuse(UNMEASURABLE, `GET /local-verify/record answered ${rec?.status ?? 'nothing'}`);
  const record = rec.status === 200 ? (rec.body?.record ?? null) : null;
  if (!record) {
    // No record: ask the server to verify this PR (§2 "Other eligible PRs are
    // verified on request") and answer verify-pending with the POST's outcome.
    // Only a POST that cannot be made or read stays unmeasurable.
    if (typeof serverPost !== 'function') return refuse(UNMEASURABLE, 'no local-verify record in the server index for this (pr, head, base)');
    let post;
    try { post = await serverPost('/local-verify', { pr: Number(pr) }); } catch (e) {
      return refuse(UNMEASURABLE, `no record, and the verify request failed: ${String(e?.message ?? e).slice(0, 200)}`);
    }
    const outcome = verifyRequestOutcome(post);
    if (!outcome) return refuse(UNMEASURABLE, `no record, and the verify request answered ${post?.status ?? 'nothing'}`);
    return refuse('refused:verify-pending', `no local-verify record yet for head ${live.headRefOid}; verify request: ${outcome}`);
  }
  let files;
  try {
    const pages = readJson(['api', `repos/${repo}/pulls/${pr}/files?per_page=100`, '--paginate', '--slurp']);
    files = (Array.isArray(pages) ? pages : [pages]).flat().map(f => ({ filename: String(f?.filename ?? ''), status: String(f?.status ?? '') }));
  } catch (e) {
    return refuse(UNMEASURABLE, `changed-file read failed: ${String(e?.message ?? e).slice(0, 200)}`);
  }
  const decisionRecords = decisionRecordPaths(files).map(p => {
    const t = ghText(['api', `repos/${repo}/contents/${p}?ref=${live.headRefOid}`, '-H', 'Accept: application/vnd.github.raw']);
    try { return JSON.parse(t ?? ''); } catch { return {}; } // same as the CI check: an unreadable record covers nothing
  });
  const authorType = live.author?.is_bot === true ? 'Bot' : 'User';
  const bodyChecks = runLocalBodyChecks({ title: live.title, body: live.body, authorLogin: live.author?.login ?? '', authorType, files, decisionRecords });
  const flagged = ['harnessChanging', 'protectedPath', 'skipsAdded', 'testsRemoved'].some(k => record[k] === true);
  let operatorApproved = false;
  let acceptance = null;
  if (flagged) {
    try {
      const pages = readJson(['api', `repos/${repo}/pulls/${pr}/reviews?per_page=100`, '--paginate', '--slurp']);
      const reviews = (Array.isArray(pages) ? pages : [pages]).flat().map(r => ({
        login: String(r?.user?.login ?? ''), state: String(r?.state ?? ''), commitId: String(r?.commit_id ?? ''), submittedAt: String(r?.submitted_at ?? ''),
      }));
      operatorApproved = approvedAtHead(reviews, agent.operatorGhLogin, live.headRefOid).approved;
    } catch (e) {
      return refuse(UNMEASURABLE, `review read failed: ${String(e?.message ?? e).slice(0, 200)}`);
    }
    if (operatorApproved) {
      let ex;
      try { ex = await serverGet('/feedback-factory/execute/status'); } catch { ex = null; }
      acceptance = ex && ex.status === 200
        ? approverAcceptanceFromExecutorStatus(ex.body, agent.operatorGhLogin)
        : { matches: false, reason: ex && ex.status === 503 ? 'executor-not-constructed' : 'executor-status-unreadable' };
    }
  }
  return evaluateLocalPredicate({
    repo, pr: Number(pr), livePr: { headRefOid: live.headRefOid, baseRefName: live.baseRefName }, record,
    mainHealth: status?.mainHealth ?? null, bodyChecks, operatorApprovedHead: operatorApproved, approverAcceptance: acceptance,
  });
}

// ---------------------------------------------------------------------------
// gh invocation layer (sync is fine — this is a standalone CLI, not server code)
// ---------------------------------------------------------------------------

function gh(args, { allowFail = false } = {}) {
  const r = spawnSync('gh', args, { encoding: 'utf-8' });
  if (r.error) throw new Error(`gh spawn failed: ${r.error.message}`);
  if (r.status !== 0 && !allowFail) {
    throw new Error(`gh ${args.slice(0, 3).join(' ')} exited ${r.status}: ${(r.stderr || '').slice(0, 400)}`);
  }
  return r;
}

function ghJson(args) {
  const r = gh(args);
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(`gh ${args.slice(0, 3).join(' ')} returned unparseable JSON`);
  }
}

function fetchChecksRows(pr, repo) {
  // gh pr checks exits non-zero when checks are failing/pending; capture either way.
  const r = gh(['pr', 'checks', pr, '--repo', repo, '--json', 'name,state,bucket'], { allowFail: true });
  try {
    const rows = JSON.parse(r.stdout);
    if (!Array.isArray(rows)) throw new Error('not an array');
    return rows;
  } catch {
    throw new Error(`gh pr checks returned unparseable JSON: ${(r.stdout || '').slice(0, 200)}`);
  }
}

/**
 * Pure read of branch-protection data. `branchData` is `GET /branches/<b>`
 * (readable by a non-admin); `protectionData` is `GET /branches/<b>/protection`
 * when it was readable (an admin token), else null. Required contexts come
 * from `protection.required_status_checks` (`contexts` and/or
 * `checks[].context`), unioned with the admin view when present.
 * `reviewsRequired` is the classic required-reviews setting and is true only
 * when the admin view was readable and shows it; otherwise review
 * requirements come from the ruleset policy (`fetchRulesetReviewPolicy`).
 */
export function extractBranchProtection(branchData, protectionData) {
  const contexts = new Set();
  const addChecks = rsc => {
    for (const c of rsc?.contexts ?? []) if (typeof c === 'string' && c) contexts.add(c);
    for (const c of rsc?.checks ?? []) if (typeof c?.context === 'string' && c.context) contexts.add(c.context);
  };
  addChecks(branchData?.protection?.required_status_checks);
  if (protectionData) addChecks(protectionData.required_status_checks);
  return {
    contexts: [...contexts],
    reviewsRequired: protectionData ? protectionData.required_pull_request_reviews != null : false,
  };
}

/**
 * Classic branch protection, read the way a NON-admin can see it. A 404 from
 * `/protection` is what a non-admin always gets, so it no longer means "no
 * protection" (that misread hid `main`'s 12 required Actions contexts); the
 * contexts come from `GET /branches/<b>`, whose failure is unverifiable.
 * `run` is injectable for tests.
 */
export function fetchProtectionContexts(repo, branch, run = gh) {
  const b = run(['api', `repos/${repo}/branches/${branch}`], { allowFail: true });
  if (b.status !== 0) {
    throw new Error(`branch protection unverifiable: ${(b.stderr || '').slice(0, 300)}`);
  }
  let branchData;
  try { branchData = JSON.parse(b.stdout); } catch {
    throw new Error('branch protection unverifiable: GET /branches returned unparseable JSON');
  }
  let protectionData = null;
  const p = run(['api', `repos/${repo}/branches/${branch}/protection`], { allowFail: true });
  if (p.status === 0) {
    try { protectionData = JSON.parse(p.stdout); } catch {
      throw new Error('branch protection unverifiable: GET /protection returned unparseable JSON');
    }
  } else if (!/HTTP 40[34]/.test(p.stderr || '') && !/Branch not protected/i.test(p.stderr || '')) {
    // 404/403 = not readable by this login (or genuinely unprotected): the
    // classic review flag is then false and /branches is authoritative for
    // contexts. Anything else is unverifiable.
    throw new Error(`branch protection unverifiable: ${(p.stderr || '').slice(0, 300)}`);
  }
  return extractBranchProtection(branchData, protectionData);
}

/** Combined-status entries for the head (where `instar/local-verify` lives). */
function fetchCommitStatuses(repo, headSha) {
  const resp = ghJson(['api', `repos/${repo}/commits/${headSha}/status?per_page=100`]);
  return (resp?.statuses ?? []).map(st => ({ context: st?.context ?? '', state: st?.state ?? '' }));
}

function fetchRulesetContexts(repo, branch) {
  const r = gh(['api', `repos/${repo}/rules/branches/${branch}`], { allowFail: true });
  if (r.status !== 0) {
    if (/HTTP 404/.test(r.stderr || '')) return [];
    throw new Error(`branch rulesets unverifiable: ${(r.stderr || '').slice(0, 300)}`);
  }
  const rules = JSON.parse(r.stdout);
  const contexts = [];
  for (const rule of Array.isArray(rules) ? rules : []) {
    if (rule?.type === 'required_status_checks') {
      for (const c of rule?.parameters?.required_status_checks ?? []) {
        if (c?.context) contexts.push(c.context);
      }
    }
  }
  return contexts;
}

function fetchRulesetReviewPolicy(repo, branch) {
  const r = gh(['api', `repos/${repo}/rules/branches/${branch}`], { allowFail: true });
  if (r.status !== 0) {
    if (/HTTP 404/.test(r.stderr || '')) return { reviewsRequired: false, lastPushApprovalRequired: false };
    throw new Error(`branch rulesets unverifiable: ${(r.stderr || '').slice(0, 300)}`);
  }
  return extractRulesetReviewPolicy(JSON.parse(r.stdout));
}

/** Who to ask for the approval: --request-review-from, else the repo owner. Never the PR author (GitHub rejects it). */
function resolveReviewers(repo, args, view) {
  let logins = Array.isArray(args.requestReviewFrom) && args.requestReviewFrom.length > 0 ? [...args.requestReviewFrom] : [];
  if (logins.length === 0) {
    try {
      const owner = ghJson(['repo', 'view', repo, '--json', 'owner'])?.owner?.login;
      if (owner) logins = [owner];
    } catch { /* fall through — no default reviewer resolvable */ }
  }
  const author = view?.author?.login;
  return logins.filter(l => l && l !== author);
}

/** Request review from `logins` on the PR. Idempotent at GitHub (re-requesting is a no-op). Never throws. */
function requestReviewers(repo, pr, logins) {
  if (!logins.length) return { requested: [], error: 'no-reviewer-resolvable' };
  const args = ['api', '-X', 'POST', `repos/${repo}/pulls/${pr}/requested_reviewers`];
  for (const l of logins) args.push('-f', `reviewers[]=${l}`);
  const r = gh(args, { allowFail: true });
  if (r.status !== 0) return { requested: [], error: (r.stderr || '').slice(0, 200) };
  try {
    const body = JSON.parse(r.stdout);
    const now = (body?.requested_reviewers ?? []).map(u => u?.login).filter(Boolean);
    return { requested: logins.filter(l => now.includes(l)), error: null };
  } catch {
    return { requested: logins, error: null };
  }
}

/**
 * Refuse-with-a-link: the base branch needs a human approval that `--admin`
 * cannot (and must not) bypass. Request the review so the operator's next
 * step is ONE click, emit the distinct `refused:approval-required` slug with
 * the direct Files-tab URL, and exit 1. This is the 2026-08-22 process fix:
 * the operator should never have to ask the agent to request a review.
 */
function refuseApprovalRequired({ repo, pr, view, args, policy, via }) {
  const reviewers = resolveReviewers(repo, args, view);
  const rq = requestReviewers(repo, pr, reviewers);
  const reviewUrl = reviewUrlFor(repo, pr);
  result({
    result: 'refused:approval-required',
    pr: Number(pr),
    reviewUrl,
    reviewersRequested: rq.requested,
    ...(rq.error ? { requestError: rq.error } : {}),
    reviewDecision: view?.reviewDecision ?? null,
    policy,
    via,
  });
  console.error(`safe-merge: REFUSING — the base branch requires an approval from someone other than the pusher (${via}). ` +
    (rq.requested.length ? `Review requested from ${rq.requested.join(', ')}. ` : `Could not request a reviewer (${rq.error}). `) +
    `Approve here: ${reviewUrl}`);
  process.exit(1);
}

function fetchCheckRunsWithProducers(repo, headSha) {
  const runsResp = ghJson(['api', `repos/${repo}/commits/${headSha}/check-runs?per_page=100`, '--paginate', '--slurp']);
  const pages = Array.isArray(runsResp) ? runsResp : [runsResp];
  const checkRunsRaw = pages.flatMap(p => p?.check_runs ?? []);
  const wfResp = ghJson(['api', `repos/${repo}/actions/runs?head_sha=${headSha}&per_page=100`, '--paginate', '--slurp']);
  const wfPages = Array.isArray(wfResp) ? wfResp : [wfResp];
  const workflowRuns = wfPages.flatMap(p => p?.workflow_runs ?? []);
  const pathBySuite = new Map();
  for (const wr of workflowRuns) {
    if (wr?.check_suite_id != null && wr?.path) pathBySuite.set(wr.check_suite_id, wr.path);
  }
  return checkRunsRaw.map(cr => ({
    name: cr?.name ?? '',
    conclusion: cr?.conclusion ?? '',
    appSlug: cr?.app?.slug ?? null,
    workflowPath: pathBySuite.get(cr?.check_suite?.id) ?? null,
  }));
}

/** Raw text of a gh call; null on failure. */
function ghText(args) {
  const r = gh(args, { allowFail: true });
  return r.status === 0 ? r.stdout : null;
}

/**
 * The agent home that owns THIS copy of safe-merge: the parent of the git
 * common dir (a worktree under `<home>/.worktrees/` resolves to `<home>`).
 * Derived from the script's own location, never from the environment.
 */
export function resolveAgentHome(scriptDir, run = spawnSync) {
  // Every GIT_* variable is dropped: an inherited GIT_DIR or GIT_COMMON_DIR would
  // make git answer for another repository, and so point this at another agent's
  // config file, server and token (second-pass finding).
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  const r = run('git', ['-C', scriptDir, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf-8', env });
  const common = r?.status === 0 ? String(r.stdout ?? '').trim() : '';
  if (common && path.basename(common) === '.git') return path.dirname(common);
  return path.dirname(scriptDir);
}

/** null when the agent has no config file (plain install); throws when it is unreadable. */
function loadAgentConfig(home) {
  const file = path.join(home, '.instar', 'config.json');
  if (!fs.existsSync(file)) return null;
  return parseAgentServerConfig(fs.readFileSync(file, 'utf-8'));
}

/** The vault-backed token, through the agent's own secret-get script (value on stdout only). */
function resolveVaultToken(home) {
  const script = path.join(home, '.instar', 'scripts', 'secret-get.mjs');
  if (!fs.existsSync(script)) return null;
  const r = spawnSync(process.execPath, [script, 'authToken'], { cwd: home, encoding: 'utf-8', timeout: 15_000 });
  return r.status === 0 && r.stdout ? r.stdout : null;
}

/**
 * GET against the agent's own server (loopback, port + token from the config
 * file). Resolves `{status, body}`; rejects on a transport failure.
 */
export function makeServerPost({ port, token, timeoutMs = 15_000, fetchImpl = fetch }) {
  return async (p, body) => {
    if (!port || !token) throw new Error('agent server port/token not configured');
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`http://127.0.0.1:${port}${p}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      let out = null;
      try { out = await res.json(); } catch { out = null; }
      return { status: res.status, body: out };
    } finally {
      clearTimeout(t);
    }
  };
}

export function makeServerGet({ port, token, timeoutMs = 15_000, fetchImpl = fetch }) {
  return async (p) => {
    if (!port || !token) throw new Error('agent server port/token not configured');
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`http://127.0.0.1:${port}${p}`, { headers: { Authorization: `Bearer ${token}` }, signal: ctl.signal });
      let body = null;
      try { body = await res.json(); } catch { body = null; }
      return { status: res.status, body };
    } finally {
      clearTimeout(t);
    }
  };
}

function result(obj) {
  console.log(`safe-merge-result: ${JSON.stringify(obj)}`);
}

function sleep(ms) {
  spawnSync(process.platform === 'win32' ? 'timeout' : 'sleep', [String(Math.ceil(ms / 1000))]);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

/**
 * The review prechecks both floors run (classic required reviews, when the
 * admin view is readable; the ruleset review policy with the request-and-link
 * refusal). Exits on refusal; returns the protection read for the caller.
 * Throws on an unverifiable read (the caller maps it to contexts-unverifiable).
 */
function reviewPrecheck({ repo, pr, view, args }) {
  const protection = fetchProtectionContexts(repo, view.baseRefName || 'main');
  if (!reviewPrecheckPasses({ classicReviewsRequired: protection.reviewsRequired, reviewDecision: view.reviewDecision })) {
    result({ result: 'refused:reviews-required', reviewDecision: view.reviewDecision ?? null });
    console.error('safe-merge: REFUSING — required-review protection exists and is unsatisfied. --admin would bypass it un-re-imposed.');
    process.exit(1);
  }
  // RULESET review policy (classic protection above is not the only source).
  // Read it BEFORE attempting the merge so a required non-pusher approval is
  // answered by REQUESTING the review + handing back the link — not by a
  // failed `gh pr merge` and a reviewer-less PR (2026-08-22, PR #1963).
  const reviewPolicy = fetchRulesetReviewPolicy(repo, view.baseRefName || 'main');
  if (!reviewPrecheckPasses({ policy: reviewPolicy, reviewDecision: view.reviewDecision })) {
    refuseApprovalRequired({ repo, pr, view, args, policy: reviewPolicy, via: 'ruleset-precheck' });
  }
  return protection;
}

/** The head-pinned merge plus the independent confirmation (B10). Always exits. */
function mergeAndConfirm({ repo, pr, view, args, pinnedHead, admin }) {
  console.log(`safe-merge: merging PR #${pr} (${args.method}${admin ? ' --admin' : ''}, head ${pinnedHead.slice(0, 12)})...`);
  const mergeArgs = ['pr', 'merge', pr, '--repo', repo, args.method, '--match-head-commit', pinnedHead];
  if (admin) mergeArgs.push('--admin');
  if (args.deleteBranch) mergeArgs.push('--delete-branch');
  const m = spawnSync('gh', mergeArgs, { encoding: 'utf-8' });
  process.stdout.write(m.stdout ?? '');
  process.stderr.write(m.stderr ?? '');

  if (m.status !== 0 || m.signal) {
    // Belt-and-braces: a ruleset that changed between the pre-check and the
    // merge (or one the pre-check could not read) still gets the request-and-link
    // treatment, never a bare merge-command-failed.
    if (isNonPusherApprovalRequired(m.stderr)) {
      refuseApprovalRequired({ repo, pr, view, args, policy: null, via: 'merge-refusal' });
    }
    const cls = classifyMergeFailure(m.stderr, m.status, m.signal);
    result({ result: cls === 'already-merged' || cls === 'closed' ? cls : `refused-or-${cls}`, raw: cls });
    if (cls === 'already-merged') process.exit(3);
    if (cls === 'closed') process.exit(4);
    console.error(`safe-merge: merge command did not succeed (${cls}).`);
    process.exit(2);
  }

  // --- Independent confirmation (B10: never trust the exit code alone) ------
  try {
    const after = ghJson(['pr', 'view', pr, '--repo', repo, '--json', 'state,mergedAt']);
    if (after.state === 'MERGED' || after.mergedAt) {
      result({ result: 'merged', pr: Number(pr), head: pinnedHead });
      process.exit(0);
    }
    result({ result: 'error:merge-unconfirmed', state: after.state });
    console.error('safe-merge: gh reported success but the PR is not MERGED on re-read. NOT claiming success.');
    process.exit(2);
  } catch (e) {
    result({ result: 'error:confirm-unreadable', detail: String(e.message).slice(0, 300) });
    console.error('safe-merge: could not independently confirm the merge. NOT claiming success.');
    process.exit(2);
  }
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`safe-merge: ${e.message}`);
      console.error('usage: node scripts/safe-merge.mjs <PR#> [--auto|--admin] [--squash|--merge|--rebase] [--repo <owner/name>] [--delete-branch] [--deadline-ms <n>] [--match-head-commit <sha>] [--extra-floor <ctx,ctx>]');
      result({ result: 'error:usage', detail: e.message });
      process.exit(2);
    }
    throw e;
  }

  if (args.capabilities) {
    console.log(JSON.stringify(capabilities()));
    process.exit(0);
  }

  const { pr, repo } = args;
  const deadline = Date.now() + args.deadlineMs;

  // --- PR state + head pin -------------------------------------------------
  let view;
  try {
    view = ghJson(['pr', 'view', pr, '--repo', repo, '--json', 'state,mergedAt,headRefOid,baseRefName,reviewDecision,isDraft,author,isCrossRepository']);
  } catch (e) {
    result({ result: 'error:pr-unreadable', detail: String(e.message).slice(0, 300) });
    process.exit(2);
  }
  if (view.state === 'MERGED' || view.mergedAt) {
    result({ result: 'already-merged', pr: Number(pr) });
    process.exit(3);
  }
  if (view.state === 'CLOSED') {
    result({ result: 'closed', pr: Number(pr) });
    process.exit(4);
  }
  if (view.isDraft) {
    result({ result: 'refused:draft', pr: Number(pr) });
    process.exit(1);
  }
  const pinnedHead = args.matchHeadCommit ?? view.headRefOid;
  if (args.matchHeadCommit && view.headRefOid && args.matchHeadCommit !== view.headRefOid) {
    result({ result: 'refused:head-moved', pr: Number(pr), expected: args.matchHeadCommit, actual: view.headRefOid });
    console.error('safe-merge: REFUSING — the PR head moved past the verified commit.');
    process.exit(1);
  }

  // --- Native auto-merge path (--auto): arm-and-return, no polling ----------
  // GitHub's native auto-merge merges the PR the instant every REQUIRED check
  // passes and the branch is mergeable — and it NEVER bypasses a check (unlike
  // --admin). So the required-context re-imposition this script does manually
  // for the --admin path is enforced by GitHub itself here. We only run the
  // cheap pre-flight above (open, not draft, head not moved), arm auto-merge,
  // confirm it's armed, and exit. No deadline, so it can't time out the way a
  // foreground/background poller does (the failure mode that wedged hot-branch
  // merges: the watcher is killed before slow CI finishes).
  if (args.auto) {
    const autoArgs = ['pr', 'merge', pr, '--repo', repo, args.method, '--auto'];
    if (args.matchHeadCommit) autoArgs.push('--match-head-commit', pinnedHead);
    if (args.deleteBranch) autoArgs.push('--delete-branch');
    console.log(`safe-merge: arming native auto-merge for PR #${pr} (${args.method}, head ${pinnedHead.slice(0, 12)}) — GitHub will merge when all required checks pass...`);
    const a = spawnSync('gh', autoArgs, { encoding: 'utf-8' });
    process.stdout.write(a.stdout ?? '');
    process.stderr.write(a.stderr ?? '');
    if (a.status !== 0 || a.signal) {
      const cls = classifyMergeFailure(a.stderr, a.status, a.signal);
      if (cls === 'already-merged') { result({ result: 'already-merged', pr: Number(pr) }); process.exit(3); }
      if (cls === 'closed') { result({ result: 'closed', pr: Number(pr) }); process.exit(4); }
      // Distinguish "auto-merge is disabled on the repo" (a PERMANENT condition →
      // terminal-non-ladder for the orchestrator) from a generic transient gh
      // failure. The discriminator is a REAL stderr-signature match, not the
      // human-only console.error hint below.
      if (isAutoMergeUnavailable(a.stderr)) {
        result({ result: 'refused:auto-arm-unavailable', raw: cls });
        console.error('safe-merge: could not arm auto-merge — "Allow auto-merge" appears DISABLED on the repo settings. Enable it, or run with --admin.');
        process.exit(1);
      }
      result({ result: `refused:auto-arm-${cls}`, raw: cls });
      console.error(`safe-merge: could not arm auto-merge (${cls}). Is "Allow auto-merge" enabled on the repo settings?`);
      process.exit(1);
    }
    // Independent confirmation (B10: never trust the exit code alone). If the
    // checks were ALREADY green, GitHub merges immediately and we report merged.
    try {
      const after = ghJson(['pr', 'view', pr, '--repo', repo, '--json', 'state,mergedAt,autoMergeRequest']);
      if (after.state === 'MERGED' || after.mergedAt) {
        result({ result: 'merged', pr: Number(pr), head: pinnedHead });
        process.exit(0);
      }
      if (after.autoMergeRequest) {
        result({ result: 'auto-merge-armed', pr: Number(pr), head: pinnedHead });
        console.log('safe-merge: auto-merge armed. GitHub will merge when required checks pass — no further action needed.');
        process.exit(5);
      }
      result({ result: 'error:auto-arm-unconfirmed', state: after.state });
      console.error('safe-merge: gh reported success but auto-merge is not armed on re-read. NOT claiming success.');
      process.exit(2);
    } catch (e) {
      result({ result: 'error:auto-confirm-unreadable', detail: String(e.message).slice(0, 300) });
      console.error('safe-merge: could not independently confirm auto-merge was armed. NOT claiming success.');
      process.exit(2);
    }
  }

  // --- Floor selection (local-verify-merge-authority §3) --------------------
  // `--auto` (above) keeps today's behaviour. On the synchronous path, the
  // `local` floor replaces the three Actions waits and the contexts floor with
  // the §3 predicate; it never falls back to the Actions floor on its own.
  {
    const home = resolveAgentHome(path.dirname(fileURLToPath(import.meta.url)));
    let agent = null;
    let configError = null;
    try { agent = loadAgentConfig(home); } catch (e) { configError = e; }
    const override = process.env.INSTAR_MERGE_FLOOR === 'actions' ? 'actions' : undefined;
    let token = agent?.inlineToken ?? null;
    let tokenTried = false;
    const serverGet = async (p) => {
      if (!token && !tokenTried && agent?.tokenSource === 'vault') { tokenTried = true; token = resolveVaultToken(home); }
      return makeServerGet({ port: agent?.port ?? null, token })(p);
    };
    const serverPost = async (p, body) => {
      if (!token && !tokenTried && agent?.tokenSource === 'vault') { tokenTried = true; token = resolveVaultToken(home); }
      return makeServerPost({ port: agent?.port ?? null, token })(p, body);
    };
    const sel = configError && !override
      ? { floor: 'local', refusal: { result: UNMEASURABLE, problems: [`agent config unreadable: ${String(configError.message).slice(0, 200)}`] } }
      : await selectSafeMergeFloor({ repo, view, agent, override, serverGet });
    if (sel.floor === 'local') {
      const refuseLocal = (r) => {
        result({ result: r.result, pr: Number(pr), floor: 'local', problems: (r.problems ?? []).slice(0, 20) });
        console.error(`safe-merge: REFUSING (local floor) — ${r.result}:\n  ${(r.problems ?? []).join('\n  ')}`);
        process.exit(1);
      };
      if (sel.refusal) refuseLocal(sel.refusal);
      try {
        reviewPrecheck({ repo, pr, view, args });
      } catch (e) {
        result({ result: 'refused:contexts-unverifiable', detail: String(e.message).slice(0, 300) });
        console.error(`safe-merge: REFUSING — review precheck failed: ${e.message}`);
        process.exit(1);
      }
      const verdict = await checkLocalFloor({ repo, pr, pinnedHead, status: sel.status, agent, serverGet, serverPost, ghJson, ghText });
      if (!verdict.ok) refuseLocal(verdict);
      console.log('safe-merge: local-verify record admitted (local floor).');
      mergeAndConfirm({ repo, pr, view, args, pinnedHead, admin: false });
    }
  }

  // --- Wait for checks to settle (bucket-based, never name-based) ----------
  console.log(`safe-merge: waiting for PR #${pr} checks to finish (deadline ${Math.round(args.deadlineMs / 1000)}s)...`);
  let checksState;
  for (;;) {
    let rows;
    try {
      rows = fetchChecksRows(pr, repo);
    } catch (e) {
      result({ result: 'refused:contexts-unverifiable', detail: String(e.message).slice(0, 300) });
      console.error(`safe-merge: REFUSING — ${e.message}`);
      process.exit(1);
    }
    checksState = classifyChecks(rows);
    if (checksState.settled) break;
    if (Date.now() > deadline) {
      result({ result: 'refused:checks-timeout', pending: checksState.pending.slice(0, 10) });
      console.error('safe-merge: timed out waiting for checks. NOT merging.');
      process.exit(1);
    }
    sleep(15_000);
  }

  if (checksState.failed.length > 0) {
    result({ result: 'refused:red-checks', failed: checksState.failed.slice(0, 20) });
    console.error(`safe-merge: REFUSING — ${checksState.failed.length} check(s) not green:\n  ${checksState.failed.join('\n  ')}`);
    process.exit(1);
  }
  if (!checksState.sawE2e || !checksState.e2ePassed) {
    result({ result: 'refused:e2e-missing-or-red' });
    console.error('safe-merge: REFUSING — the e2e check is missing or did not pass. The e2e job is the one --admin bypasses; do not merge without it.');
    process.exit(1);
  }

  // --- Required-contexts cross-check with producer-bound floor --------------
  let evaluation;
  try {
    const protection = reviewPrecheck({ repo, pr, view, args });
    const rulesetContexts = fetchRulesetContexts(repo, view.baseRefName || 'main');
    const checkRuns = fetchCheckRunsWithProducers(repo, pinnedHead);
    // instar/local-verify is a commit status: read it from the combined-status
    // API only when something requires it (never among check runs).
    const needsStatuses = [...protection.contexts, ...rulesetContexts, ...args.extraFloor]
      .includes(LOCAL_VERIFY_CONTEXT);
    const commitStatuses = needsStatuses ? fetchCommitStatuses(repo, pinnedHead) : [];
    evaluation = evaluateRequiredContexts({
      protectionContexts: protection.contexts,
      rulesetContexts,
      floor: ACTIONS_FLOOR_CONTEXTS,
      extraFloor: args.extraFloor,
      checkRuns,
      commitStatuses,
    });
  } catch (e) {
    result({ result: 'refused:contexts-unverifiable', detail: String(e.message).slice(0, 300) });
    console.error(`safe-merge: REFUSING — required-contexts verification failed: ${e.message}`);
    process.exit(1);
  }
  if (!evaluation.ok) {
    result({ result: 'refused:contexts', problems: evaluation.problems.slice(0, 20) });
    console.error(`safe-merge: REFUSING — required-contexts cross-check failed:\n  ${evaluation.problems.join('\n  ')}`);
    process.exit(1);
  }

  // --- Merge (head-pinned) ---------------------------------------------------
  console.log('safe-merge: all checks green (e2e + producer-bound floor confirmed).');
  mergeAndConfirm({ repo, pr, view, args, pinnedHead, admin: args.admin });
}

const isCliEntry = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isCliEntry) {
  main().catch(e => {
    console.error(`safe-merge: unexpected error: ${e?.stack || e}`);
    result({ result: 'error:unexpected', detail: String(e?.message ?? e).slice(0, 300) });
    process.exit(2);
  });
}
