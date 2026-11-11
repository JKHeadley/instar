/**
 * pr-reviewer-request — the shared "who reviews this pull request, and are they
 * already on it?" logic. One implementation, used by:
 *
 *  - scripts/safe-merge.mjs (merge-refusal time: request the operator's review
 *    so the link it prints is one click), and
 *  - src/core/PrLinkReviewerCheck.ts (send time: every pull-request link the
 *    agent sends a person arrives with that person already a requested reviewer).
 *
 * Pure functions only. No network, no `gh`, no clock. Callers own I/O.
 * Spec: docs/specs/pr-link-requests-reviewer.md.
 */

/** GitHub login shape (1-39 chars, alphanumeric or single hyphens, no leading hyphen). */
export const GITHUB_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** At most this many distinct pull requests are checked per message. */
export const MAX_PR_LINKS_PER_MESSAGE = 5;

/**
 * Every distinct `github.com/{owner}/{repo}/pull/{n}` link in `text`, in the
 * order they first appear, capped at MAX_PR_LINKS_PER_MESSAGE. A link to a
 * sub-page of the PR (`/files`, `/commits`, `#discussion_r1`) counts as the PR.
 * Bare `#123` references and issue links are not pull-request links.
 */
export function extractPullRequestLinks(text) {
  if (typeof text !== 'string' || !text) return [];
  const re = /(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9_.-]{1,100})\/pull\/(\d{1,9})(?![\d])/gi;
  const seen = new Set();
  const out = [];
  for (const m of text.matchAll(re)) {
    const owner = m[1];
    const repo = m[2].replace(/\.git$/i, '');
    const number = Number(m[3]);
    if (!Number.isSafeInteger(number) || number <= 0) continue;
    const key = `${owner.toLowerCase()}/${repo.toLowerCase()}#${number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ owner, repo, number, fullName: `${owner}/${repo}` });
    if (out.length >= MAX_PR_LINKS_PER_MESSAGE) break;
  }
  return out;
}

/**
 * Who to ask: the explicit logins when given, else the repo owner. Never the
 * PR author (GitHub rejects a self-request, and an author cannot approve their
 * own PR). Invalid logins are dropped. Case-insensitive de-duplication.
 */
export function resolveReviewerLogins({ explicit, repoOwner, author } = {}) {
  const base = Array.isArray(explicit) && explicit.length > 0 ? explicit : (repoOwner ? [repoOwner] : []);
  const authorLc = typeof author === 'string' ? author.toLowerCase() : null;
  const seen = new Set();
  const out = [];
  for (const raw of base) {
    const l = typeof raw === 'string' ? raw.trim() : '';
    if (!l || !GITHUB_LOGIN_RE.test(l)) continue;
    const lc = l.toLowerCase();
    if (lc === authorLc || seen.has(lc)) continue;
    seen.add(lc);
    out.push(l);
  }
  return out;
}

/** The logins from a `requested_reviewers` array (PR object or POST response). */
export function requestedReviewerLogins(requestedReviewers) {
  return (Array.isArray(requestedReviewers) ? requestedReviewers : [])
    .map((u) => (u && typeof u.login === 'string' ? u.login : null))
    .filter(Boolean);
}

/**
 * Of `logins`, which ones a `POST .../requested_reviewers` response body shows
 * as requested now. An unparseable body is treated as success for every login
 * (GitHub answered 2xx; the request is idempotent).
 */
export function confirmedRequested(responseBody, logins) {
  let body = responseBody;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return [...logins]; }
  }
  if (!body || typeof body !== 'object') return [...logins];
  const now = new Set(requestedReviewerLogins(body.requested_reviewers).map((l) => l.toLowerCase()));
  return logins.filter((l) => now.has(l.toLowerCase()));
}

/** Map GitHub REST review objects to the `approvedAtHead` shape in local-verify-floor.mjs. */
export function toReviewLike(restReviews) {
  return (Array.isArray(restReviews) ? restReviews : []).map((r) => ({
    login: String(r?.user?.login ?? ''),
    state: String(r?.state ?? ''),
    commitId: String(r?.commit_id ?? ''),
    submittedAt: String(r?.submitted_at ?? ''),
  }));
}
