/**
 * local-verify-floor — the ONE floor-selection function and the shared
 * approval/eligibility helpers used by safe-merge (scripts/safe-merge.mjs) and
 * the green-PR watcher (src/monitoring/GreenPrAutoMerger.ts), per
 * docs/specs/local-verify-merge-authority.md §3:
 *
 *   floor = (effective config floor == 'local' && repo == configured repo
 *            && PR eligible per §2) ? 'local' : 'actions'
 *
 * Pure: no I/O. `INSTAR_MERGE_FLOOR=actions` is a manual override for a human
 * running safe-merge while the server is down; it can only force `actions`,
 * never `local` (any other value is ignored).
 */

export const MERGE_FLOOR_MODES = Object.freeze(['actions', 'local']);

/**
 * §2 eligibility: the author is the agent's own login or the operator's, and
 * the head is not from a fork. Mirrors LocalVerifyService.checkEligibility.
 */
export function isMergeEligible(view, logins) {
  const login = String(view?.author?.login ?? '');
  const expected = String(logins?.expectedGhLogin ?? '');
  const operator = String(logins?.operatorGhLogin ?? '');
  const trusted = login !== '' && ((expected !== '' && login === expected) || (operator !== '' && login === operator));
  return trusted && view?.isCrossRepository === false;
}

/**
 * The floor for one merge. `effectiveFloor` is the server's effective floor
 * (or the watcher's live config); anything but exactly 'local' is 'actions'.
 */
export function selectMergeFloor({ effectiveFloor, configRepo, repo, eligible, override } = {}) {
  if (override === 'actions') return 'actions';
  if (effectiveFloor !== 'local') return 'actions';
  if (!configRepo || !repo || String(configRepo).toLowerCase() !== String(repo).toLowerCase()) return 'actions';
  if (eligible !== true) return 'actions';
  return 'local';
}

/**
 * The approver's MOST RECENT non-COMMENTED, non-PENDING review must be
 * APPROVED and on exactly `headSha`. (Re-exported by
 * src/feedback-factory/execute/reviewGate.ts — one implementation.)
 */
export function approvedAtHead(reviews, approver, headSha) {
  const a = String(approver ?? '').toLowerCase();
  // A review whose submittedAt does not parse is skipped, so the ordering below can never be NaN.
  const mine = (reviews ?? []).filter((r) => String(r.login ?? '').toLowerCase() === a && r.state !== 'COMMENTED' && r.state !== 'PENDING' && Number.isFinite(Date.parse(r.submittedAt)));
  if (mine.length === 0) return { approved: false, latestState: null };
  const latest = [...mine].sort((x, y) => Date.parse(x.submittedAt) - Date.parse(y.submittedAt)).at(-1);
  return { approved: latest.state === 'APPROVED' && latest.commitId === headSha, latestState: latest.state };
}

/** The ruleset review policy from `GET /repos/{o}/{r}/rules/branches/<b>`. */
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
 * The review precheck safe-merge runs before a merge, and the watcher runs
 * before asking for a verify: passes unless a review is required (classic
 * required reviews when readable, or the ruleset's approving-review count /
 * last-push approval) and the PR's reviewDecision is not APPROVED.
 */
export function reviewPrecheckPasses({ policy, classicReviewsRequired, reviewDecision } = {}) {
  return !reviewRequired({ policy, classicReviewsRequired }) || reviewDecision === 'APPROVED';
}

/** Whether any review is required at all (decides the "ready" time). */
export function reviewRequired({ policy, classicReviewsRequired } = {}) {
  return classicReviewsRequired === true || policy?.reviewsRequired === true || policy?.lastPushApprovalRequired === true;
}
