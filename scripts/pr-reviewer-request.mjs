/**
 * pr-reviewer-request — "who reviews this pull request, and did GitHub take the
 * request?" helpers for scripts/safe-merge.mjs (merge-refusal time: request the
 * operator's review so the link it prints is one click).
 *
 * Send-time reviewer requests for PR links in replies live in ONE place:
 * src/messaging/prLinkReviewRequest.ts. Do not add a second send-time path here.
 *
 * Pure functions only. No network, no `gh`, no clock. Callers own I/O.
 */

/** GitHub login shape (1-39 chars, alphanumeric or single hyphens, no leading hyphen). */
export const GITHUB_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

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
