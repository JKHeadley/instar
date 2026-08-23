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
 *         node scripts/safe-merge.mjs --capabilities
 *
 * Exit codes: 0 merged (independently confirmed) · 1 refused · 2 usage/error
 *             3 already-merged · 4 closed-without-merge
 * The final stdout line is always `safe-merge-result: {...}` with a
 * machine-parseable classification.
 */

import { spawnSync } from 'node:child_process';

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
 * (The matrix-expanded unit shards ride branch protection's own required
 * list, which is unioned in — see evaluateRequiredContexts.)
 */
export const REQUIRED_CONTEXTS_FLOOR = [
  { context: 'Type Check', workflowPath: '.github/workflows/ci.yml', appSlug: 'github-actions' },
  { context: 'Integration Tests', workflowPath: '.github/workflows/ci.yml', appSlug: 'github-actions' },
  { context: 'E2E Tests', workflowPath: '.github/workflows/ci.yml', appSlug: 'github-actions' },
  { context: 'Build', workflowPath: '.github/workflows/ci.yml', appSlug: 'github-actions' },
  { context: 'decision-audit', workflowPath: '.github/workflows/decision-audit-gate.yml', appSlug: 'github-actions' },
  { context: 'eli16', workflowPath: '.github/workflows/eli16-pr-gate.yml', appSlug: 'github-actions' },
];

const ALLOWED_FLAGS = new Set([
  '--admin', '--auto', '--squash', '--merge', '--rebase', '--delete-branch', '--capabilities',
]);
const ALLOWED_VALUE_FLAGS = new Set([
  '--repo', '--deadline-ms', '--match-head-commit', '--extra-floor', '--request-review-from',
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
      'approval-required-refusal', 'request-review-from',
    ],
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
 */
export function evaluateRequiredContexts({ protectionContexts, rulesetContexts, floor, extraFloor, checkRuns }) {
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
    if (!successByName.has(ctx)) {
      problems.push(`required context "${ctx}" has no genuinely-successful run`);
    }
  }
  for (const pin of floor) {
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
export function extractRulesetReviewPolicy(rules) {
  let reviewsRequired = false;
  let lastPushApprovalRequired = false;
  for (const rule of Array.isArray(rules) ? rules : []) {
    if (rule?.type !== 'pull_request') continue;
    const p = rule?.parameters ?? {};
    if (Number(p.required_approving_review_count) > 0) reviewsRequired = true;
    if (p.require_last_push_approval === true) lastPushApprovalRequired = true;
  }
  return { reviewsRequired, lastPushApprovalRequired };
}

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

function fetchProtectionContexts(repo, branch) {
  const r = gh(['api', `repos/${repo}/branches/${branch}/protection`], { allowFail: true });
  if (r.status !== 0) {
    // 404 = no classic protection configured: an empty contribution to the
    // union (the floor still applies). Anything else is unverifiable.
    if (/HTTP 404/.test(r.stderr || '') || /Branch not protected/i.test(r.stderr || '')) {
      return { contexts: [], reviewsRequired: false };
    }
    throw new Error(`branch protection unverifiable: ${(r.stderr || '').slice(0, 300)}`);
  }
  const data = JSON.parse(r.stdout);
  return {
    contexts: data?.required_status_checks?.contexts ?? [],
    reviewsRequired: data?.required_pull_request_reviews != null,
  };
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

function result(obj) {
  console.log(`safe-merge-result: ${JSON.stringify(obj)}`);
}

function sleep(ms) {
  spawnSync(process.platform === 'win32' ? 'timeout' : 'sleep', [String(Math.ceil(ms / 1000))]);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

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
    view = ghJson(['pr', 'view', pr, '--repo', repo, '--json', 'state,mergedAt,headRefOid,baseRefName,reviewDecision,isDraft,author']);
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
    const protection = fetchProtectionContexts(repo, view.baseRefName || 'main');
    if (protection.reviewsRequired && view.reviewDecision !== 'APPROVED') {
      result({ result: 'refused:reviews-required', reviewDecision: view.reviewDecision ?? null });
      console.error('safe-merge: REFUSING — required-review protection exists and is unsatisfied. --admin would bypass it un-re-imposed.');
      process.exit(1);
    }
    // RULESET review policy (classic protection above is not the only source).
    // Read it BEFORE attempting the merge so a required non-pusher approval is
    // answered by REQUESTING the review + handing back the link — not by a
    // failed `gh pr merge` and a reviewer-less PR (2026-08-22, PR #1963).
    const reviewPolicy = fetchRulesetReviewPolicy(repo, view.baseRefName || 'main');
    if ((reviewPolicy.reviewsRequired || reviewPolicy.lastPushApprovalRequired) && view.reviewDecision !== 'APPROVED') {
      refuseApprovalRequired({ repo, pr, view, args, policy: reviewPolicy, via: 'ruleset-precheck' });
    }
    const rulesetContexts = fetchRulesetContexts(repo, view.baseRefName || 'main');
    const checkRuns = fetchCheckRunsWithProducers(repo, pinnedHead);
    evaluation = evaluateRequiredContexts({
      protectionContexts: protection.contexts,
      rulesetContexts,
      floor: REQUIRED_CONTEXTS_FLOOR,
      extraFloor: args.extraFloor,
      checkRuns,
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
  console.log(`safe-merge: all checks green (e2e + producer-bound floor confirmed). Merging PR #${pr} (${args.method}${args.admin ? ' --admin' : ''}, head ${pinnedHead.slice(0, 12)})...`);
  const mergeArgs = ['pr', 'merge', pr, '--repo', repo, args.method, '--match-head-commit', pinnedHead];
  if (args.admin) mergeArgs.push('--admin');
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

const isCliEntry = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isCliEntry) {
  main().catch(e => {
    console.error(`safe-merge: unexpected error: ${e?.stack || e}`);
    result({ result: 'error:unexpected', detail: String(e?.message ?? e).slice(0, 300) });
    process.exit(2);
  });
}
