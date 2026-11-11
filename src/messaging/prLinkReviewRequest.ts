/**
 * prLinkReviewRequest — a pull request link the agent sends its operator is a
 * review request on GitHub, not just in the chat.
 *
 * WHY THIS EXISTS (Echo Bugs topic 10000002537, 2026-11-10): the agent sent the
 * operator a link to its own open PR (#3046) asking for approval at 18:03 PST,
 * and the operator was NOT a requested reviewer on it. He had been requested
 * earlier, but he reviewed, and a later push dismissed that review. GitHub never
 * puts a request back after the reviewer has reviewed, so every "please approve"
 * link after a new push pointed at a PR that did not ask him for anything.
 * `scripts/safe-merge.mjs` already requests the review on its own refusal path;
 * every other way a PR link reaches the operator (a hand-written reply, a status
 * note, a re-ask after a dismissal) did not. Operator, 2026-11-10 20:15 PST:
 * "every time you send me a link, I actually am a requested reviewer."
 *
 * WHAT IT DOES: before an outbound reply leaves (Telegram, Slack, app), every
 * github.com pull-request link in it is checked. For an OPEN PR that THIS
 * agent's GitHub identity authored, the reviewer (the configured
 * `prLinkReviewRequest.reviewer`, else the repository owner when that owner is a
 * user) is requested if not already, and the request is then read back from
 * `GET /pulls/N/requested_reviewers`. When it cannot be confirmed, one plain
 * line saying so is appended to the message, so the operator is never told
 * "please approve" with a link that silently does not ask him.
 *
 * Never blocks a reply: GitHub being down must not cost the operator a message
 * (the relay is mandatory). Skipped: closed/merged PRs, PRs someone else
 * authored, a reviewer who is the PR author (GitHub refuses those), and a
 * reviewer whose latest review already approved the current head commit.
 */

import type { NextFunction, Request, Response } from 'express';
import type { AuthenticatedGhExec } from '../core/githubRuntime.js';

export interface PrRef { owner: string; repo: string; number: number }

/** At most this many distinct PR links are checked per message. */
export const MAX_PR_LINKS = 5;
/** The whole check for one message must finish within this budget. */
export const PR_LINK_BUDGET_MS = 10_000;

const PR_URL_RE = /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})\/pull\/(\d{1,9})(?![\d])/g;
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** Distinct PR links in the order they appear, capped at {@link MAX_PR_LINKS}. */
export function extractPrLinks(text: string): PrRef[] {
  const seen = new Set<string>();
  const out: PrRef[] = [];
  for (const m of text.matchAll(PR_URL_RE)) {
    const ref = { owner: m[1], repo: m[2].replace(/\.git$/, ''), number: Number(m[3]) };
    const key = `${ref.owner}/${ref.repo}#${ref.number}`.toLowerCase();
    if (seen.has(key) || ref.number <= 0) continue;
    seen.add(key);
    out.push(ref);
    if (out.length >= MAX_PR_LINKS) break;
  }
  return out;
}

export type PrLinkOutcome =
  | 'already-requested' | 'requested' | 'failed'
  | 'skipped-not-open' | 'skipped-not-agent-pr' | 'skipped-no-reviewer'
  | 'skipped-reviewer-is-author' | 'skipped-approved-at-head';

export interface PrLinkResult { pr: PrRef; outcome: PrLinkOutcome; reviewer: string | null; reason?: string }

export interface EnsureDeps {
  gh: AuthenticatedGhExec;
  /** The agent's own GitHub login; null when it cannot be read. */
  selfLogin: () => Promise<string | null>;
  /** Configured reviewer; absent → the repository owner when the owner is a user. */
  reviewer?: string | null;
}

interface PullView {
  state?: string;
  user?: { login?: string };
  head?: { sha?: string };
  requested_reviewers?: Array<{ login?: string }>;
  base?: { repo?: { owner?: { login?: string; type?: string } } };
}

const lower = (s: string | null | undefined) => (s ?? '').toLowerCase();

// RULE 3: EXEMPT — parses structured GitHub REST JSON from `gh api`, not agent/provider state detection.
function parse<T>(stdout: string): T | null {
  try { return JSON.parse(stdout) as T; } catch { return null; } // @silent-fallback-ok: unparseable gh output reads as an unconfirmed request (the message says so)
}

function shortReason(stderr: string): string {
  const line = stderr.trim().split('\n').find(Boolean) ?? 'no detail';
  return line.replace(/^gh:\s*/, '').slice(0, 120);
}

async function requestedLogins(gh: AuthenticatedGhExec, ref: PrRef): Promise<string[] | null> {
  const r = await gh(['api', `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/requested_reviewers`]);
  if (r.code !== 0) return null;
  const body = parse<{ users?: Array<{ login?: string }> }>(r.stdout);
  return body ? (body.users ?? []).map(u => lower(u.login)).filter(Boolean) : null;
}

/** Make sure the reviewer is requested on one PR link, then read it back. Never throws. */
export async function ensureReviewerOnPr(ref: PrRef, deps: EnsureDeps): Promise<PrLinkResult> {
  const base = `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`;
  try {
    const viewRes = await deps.gh(['api', base]);
    if (viewRes.code !== 0) return { pr: ref, outcome: 'failed', reviewer: null, reason: `could not read the PR (${shortReason(viewRes.stderr)})` };
    const view = parse<PullView>(viewRes.stdout);
    if (!view) return { pr: ref, outcome: 'failed', reviewer: null, reason: 'could not read the PR' };
    if (view.state !== 'open') return { pr: ref, outcome: 'skipped-not-open', reviewer: null };

    const self = await deps.selfLogin();
    const author = view.user?.login ?? null;
    if (!self || lower(author) !== lower(self)) return { pr: ref, outcome: 'skipped-not-agent-pr', reviewer: null };

    const owner = view.base?.repo?.owner;
    const configured = deps.reviewer && LOGIN_RE.test(deps.reviewer) ? deps.reviewer : null;
    const reviewer = configured ?? (owner?.type === 'User' && owner.login ? owner.login : null);
    if (!reviewer) return { pr: ref, outcome: 'skipped-no-reviewer', reviewer: null };
    if (lower(reviewer) === lower(author)) return { pr: ref, outcome: 'skipped-reviewer-is-author', reviewer };

    if ((view.requested_reviewers ?? []).some(u => lower(u.login) === lower(reviewer))) {
      return { pr: ref, outcome: 'already-requested', reviewer };
    }

    // Already approved this exact head: a fresh request would only re-ping him.
    const reviewsRes = await deps.gh(['api', `${base}/reviews?per_page=100`]);
    if (reviewsRes.code === 0 && view.head?.sha) {
      const reviews = parse<Array<{ user?: { login?: string }; state?: string; commit_id?: string }>>(reviewsRes.stdout) ?? [];
      const latest = reviews.filter(r => lower(r.user?.login) === lower(reviewer) && r.state !== 'COMMENTED' && r.state !== 'PENDING').pop();
      if (latest?.state === 'APPROVED' && latest.commit_id === view.head.sha) {
        return { pr: ref, outcome: 'skipped-approved-at-head', reviewer };
      }
    }

    const post = await deps.gh(['api', '-X', 'POST', `${base}/requested_reviewers`, '-f', `reviewers[]=${reviewer}`]);
    const now = await requestedLogins(deps.gh, ref);
    if (now?.includes(lower(reviewer))) return { pr: ref, outcome: 'requested', reviewer };
    const reason = post.code !== 0 ? `GitHub refused the request (${shortReason(post.stderr)})` : 'the request did not show up on the PR';
    return { pr: ref, outcome: 'failed', reviewer, reason };
  } catch (err) {
    return { pr: ref, outcome: 'failed', reviewer: null, reason: err instanceof Error ? err.message.slice(0, 120) : 'unexpected error' };
  }
}

/** The plain line appended for each PR whose request could not be confirmed. */
export function unconfirmedNote(results: PrLinkResult[]): string {
  const failed = results.filter(r => r.outcome === 'failed');
  if (!failed.length) return '';
  return failed.map(r => {
    const who = r.reviewer ? `${r.reviewer} as a reviewer` : 'you as a reviewer';
    return `Note: I could not confirm ${who} on PR #${r.pr.number} (${r.reason ?? 'unknown reason'}), so it may not show in your review requests.`;
  }).join('\n');
}

export interface ApplyResult { text: string; results: PrLinkResult[]; timedOut: boolean }

/** Check every PR link in `text`; return the text to send (with a note when a request is unconfirmed). */
export async function applyPrLinkReviewRequests(text: string, deps: EnsureDeps & { budgetMs?: number; maxLength: number }): Promise<ApplyResult> {
  const refs = extractPrLinks(text);
  if (!refs.length) return { text, results: [], timedOut: false };
  const budget = deps.budgetMs ?? PR_LINK_BUDGET_MS;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), budget); });
  const done: Array<PrLinkResult | undefined> = refs.map(() => undefined);
  const work = Promise.all(refs.map((ref, i) => ensureReviewerOnPr(ref, deps).then(r => { done[i] = r; })));
  const raced = await Promise.race([work.then(() => 'done' as const), timeout]);
  if (timer) clearTimeout(timer);
  const timedOut = raced === 'timeout';
  const results: PrLinkResult[] = refs.map((pr, i) => done[i]
    ?? { pr, outcome: 'failed' as const, reviewer: deps.reviewer ?? null, reason: 'GitHub did not answer in time' });
  const note = unconfirmedNote(results);
  if (!note) return { text, results, timedOut };
  const withNote = `${text}\n\n${note}`;
  return { text: withNote.length <= deps.maxLength ? withNote : text, results, timedOut };
}

/** Process-wide cache of the agent's GitHub login (only a successful read is cached). */
export function createSelfLoginReader(gh: AuthenticatedGhExec): () => Promise<string | null> {
  let cached: string | null = null;
  return async () => {
    if (cached) return cached;
    const r = await gh(['api', 'user', '--jq', '.login']);
    const login = r.code === 0 ? r.stdout.trim() : '';
    if (LOGIN_RE.test(login)) cached = login;
    return cached;
  };
}

export interface PrLinkMiddlewareDeps {
  enabled: () => boolean;
  reviewer: () => string | null;
  gh: () => AuthenticatedGhExec | null;
  selfLogin: () => Promise<string | null>;
  log?: (line: string) => void;
}

/** Outbound reply routes this runs in front of, with the longest text each accepts. */
export const PR_LINK_REPLY_ROUTES: Array<{ path: string; maxLength: number }> = [
  { path: '/telegram/reply/:topicId', maxLength: 4096 },
  { path: '/slack/reply/:channelId', maxLength: 16_000 },
  { path: '/slack/session-reply', maxLength: 16_000 },
  { path: '/app/session-reply', maxLength: 16_000 },
];

/**
 * Express middleware: rewrites `req.body.text` (only by appending a note) before
 * the reply route and its send-policy binding see it. Never refuses a request.
 */
export function prLinkReviewMiddleware(deps: PrLinkMiddlewareDeps, maxLength: number) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const text = req.body?.text;
      if (req.method !== 'POST' || typeof text !== 'string' || !/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d/.test(text)) { next(); return; }
      // Fixed system templates and proxy messages are never PR approval asks.
      if (req.get('X-Instar-System') === 'true' || req.body?.metadata?.isProxy === true) { next(); return; }
      if (!deps.enabled()) { next(); return; }
      const gh = deps.gh();
      if (!gh) {
        deps.log?.('[pr-link-review] gh unavailable; PR links sent without a reviewer check');
        next(); return;
      }
      const out = await applyPrLinkReviewRequests(text, { gh, selfLogin: deps.selfLogin, reviewer: deps.reviewer(), maxLength });
      for (const r of out.results) {
        deps.log?.(`[pr-link-review] ${r.pr.owner}/${r.pr.repo}#${r.pr.number}: ${r.outcome}${r.reviewer ? ` (${r.reviewer})` : ''}${r.reason ? ` — ${r.reason}` : ''}`);
      }
      if (out.text !== text) req.body.text = out.text;
    } catch (err) {
      // @silent-fallback-ok: logged; a reviewer check must never cost the operator the message itself
      deps.log?.(`[pr-link-review] check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    next();
  };
}
