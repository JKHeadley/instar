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
  let codeOwnerReviewRequired = false;
  for (const rule of Array.isArray(rules) ? rules : []) {
    if (rule?.type !== 'pull_request') continue;
    const p = rule?.parameters ?? {};
    if (Number(p.required_approving_review_count) > 0) reviewsRequired = true;
    if (p.require_last_push_approval === true) lastPushApprovalRequired = true;
    if (p.require_code_owner_review === true) codeOwnerReviewRequired = true;
  }
  return { reviewsRequired, lastPushApprovalRequired, codeOwnerReviewRequired };
}

/**
 * The review precheck safe-merge runs before a merge, and the watcher runs
 * before asking for a verify: passes unless a review is required (classic
 * required reviews when readable, or the ruleset's approving-review count /
 * last-push approval) and the PR's reviewDecision is not APPROVED.
 */
export function reviewPrecheckPasses({ policy, classicReviewsRequired, reviewDecision, codeOwnedTouched } = {}) {
  if (reviewDecision === 'APPROVED') return true;
  // The ruleset's require_code_owner_review applies to PRs touching a CODEOWNERS-owned
  // path only (the constitution): GitHub refuses those until the code owner approves.
  if (policy?.codeOwnerReviewRequired === true && codeOwnedTouched === true) return false;
  return !reviewRequired({ policy, classicReviewsRequired });
}

/** Whether any review is required at all (decides the "ready" time). */
export function reviewRequired({ policy, classicReviewsRequired } = {}) {
  return classicReviewsRequired === true || policy?.reviewsRequired === true || policy?.lastPushApprovalRequired === true;
}

// ---------------------------------------------------------------------------
// CODEOWNERS: the operator's approval surface (directive 2026-10-22: "I should
// ONLY have to approve constitution changes"). GitHub enforces the code-owner
// review itself; the watcher only needs to know which PRs wait for it.
// ---------------------------------------------------------------------------

function codeownersPatternRegex(pattern) {
  let p = pattern;
  const anchored = p.startsWith('/') || p.replace(/\/$/, '').includes('/');
  p = p.replace(/^\//, '');
  const dir = p.endsWith('/');
  p = p.replace(/\/$/, '');
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*' && p[i + 1] === '*') {
      i++;
      if (p[i + 1] === '/') { re += '(?:.*/)?'; i++; } else re += '.*';
    }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  // A pattern matches the path itself or anything under it (a directory pattern only what is under it).
  return new RegExp(`^${anchored ? '' : '(?:.*/)?'}${re}${dir ? '/.*' : '(?:/.*)?'}$`);
}

/**
 * Parse a CODEOWNERS file into ordered rules. null when the text is not a
 * string (unreadable ⇒ the caller treats ownership as unverifiable).
 * @returns {Array<{pattern: string, owners: string[], re: RegExp}>|null}
 */
export function parseCodeowners(text) {
  if (typeof text !== 'string') return null;
  const rules = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line) continue;
    const [pattern, ...owners] = line.split(/\s+/);
    rules.push({ pattern, owners: owners.filter((o) => o.startsWith('@') || o.includes('@')), re: codeownersPatternRegex(pattern) });
  }
  return rules;
}

/**
 * The files a code owner must review: the LAST matching rule wins (GitHub's
 * precedence) and the file is owned when that rule names an owner.
 */
export function codeOwnedFiles(files, rules) {
  return (files ?? []).filter((f) => {
    let owned = false;
    for (const r of rules ?? []) if (r.re.test(f)) owned = r.owners.length > 0;
    return owned;
  });
}
