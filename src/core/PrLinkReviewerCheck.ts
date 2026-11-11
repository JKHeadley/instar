/**
 * PrLinkReviewerCheck — "every pull-request link I send you arrives with you
 * already a requested reviewer" (operator Justin, 2026-11-10).
 *
 * Runs at send time, inside the shared outbound evaluator, on the machine that
 * actually executes the send (a pool standby relays to the lease holder, which
 * evaluates on receipt). For each `github.com/{owner}/{repo}/pull/{n}` link in
 * the message:
 *
 *   open PR, reviewer not requested and not approved at the current head
 *     → POST requested_reviewers, confirm the login is in the response;
 *   closed or merged PR, a PR this agent cannot see (404), a repo it cannot
 *   write to, an organisation owner with no configured reviewer, or a PR whose
 *   author IS the reviewer → nothing to do, the link passes.
 *
 * A failed or unconfirmed request is a `fail` result; the route decides whether
 * that holds the message (a conversational reply whose sender can react) or
 * only records (automated sends, redrives). Every GitHub call for one message
 * shares ONE time budget, so a slow GitHub can never stall a send unboundedly.
 *
 * The reviewer logic is shared with scripts/safe-merge.mjs through
 * scripts/pr-reviewer-request.mjs; "approved at head" is local-verify-floor's.
 * Auth is the agent's explicit server identity (GITHUB_TOKEN, then vault) via
 * githubRuntime — never the machine's `gh` keychain seat.
 *
 * Spec: docs/specs/pr-link-requests-reviewer.md.
 */
import {
  extractPullRequestLinks,
  resolveReviewerLogins,
  requestedReviewerLogins,
  confirmedRequested,
  toReviewLike,
  type PullRequestLink,
} from '../../scripts/pr-reviewer-request.mjs';
import { approvedAtHead } from '../../scripts/local-verify-floor.mjs';

export type PrLinkSkipReason =
  | 'not-in-repos'
  | 'not-visible'
  | 'not-open'
  | 'no-write-access'
  | 'no-reviewer';

export type PrLinkFailReason =
  | 'no-github-token'
  | 'github-auth'
  | 'github-unreachable'
  | 'github-timeout'
  | 'request-rejected'
  | 'request-not-confirmed';

export type PrLinkOutcome =
  | { pr: string; status: 'requested' | 'already-requested' | 'approved-at-head'; reviewer: string }
  | { pr: string; status: 'skipped'; reason: PrLinkSkipReason }
  | { pr: string; status: 'failed'; reason: PrLinkFailReason; reviewer?: string; detail?: string };

export interface PrLinkCheckResult {
  ok: boolean;
  outcomes: PrLinkOutcome[];
  /** The first failure, when !ok. */
  failure?: Extract<PrLinkOutcome, { status: 'failed' }>;
}

export interface PrLinkCheckOptions {
  /**
   * Reviewer candidates for a repo ("owner/repo"), most preferred first (the
   * recipient's mapped login, the per-repo login, the default login). The first
   * that is not the PR author is asked; none left ⇒ the repo owner.
   */
  reviewerFor?: (fullName: string) => Array<string | undefined>;
  /** When set, only these "owner/repo" names are checked (case-insensitive). */
  repos?: string[];
  /** Total budget for every GitHub call of this message. */
  timeoutMs?: number;
}

export interface PrLinkReviewerCheckDeps {
  resolveToken: () => string | null;
  fetchImpl?: typeof globalThis.fetch;
  now?: () => number;
  /** How long a satisfied PR+reviewer pair is remembered (skips GitHub on a re-send). */
  satisfiedTtlMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 8_000;
const API = 'https://api.github.com';

class Deadline extends Error {
  constructor() { super('github-timeout'); }
}

export function clampTimeoutMs(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : DEFAULT_TIMEOUT_MS;
  // Capped well under the 15 s standby-to-holder relay timeout, which the holder's tone gate also spends.
  return Math.min(MAX_TIMEOUT_MS, Math.max(1_000, Math.round(n)));
}

export class PrLinkReviewerCheck {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly satisfiedTtlMs: number;
  private readonly satisfied = new Map<string, number>();

  constructor(private readonly deps: PrLinkReviewerCheckDeps) {
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    this.now = deps.now ?? (() => Date.now());
    this.satisfiedTtlMs = deps.satisfiedTtlMs ?? 60_000;
  }

  /** Cheap pre-filter: does the text contain any pull-request link at all? */
  static hasPullRequestLink(text: string): boolean {
    return extractPullRequestLinks(text).length > 0;
  }

  async check(text: string, options: PrLinkCheckOptions = {}): Promise<PrLinkCheckResult> {
    const links = extractPullRequestLinks(text);
    if (links.length === 0) return { ok: true, outcomes: [] };
    const allow = options.repos?.length ? new Set(options.repos.map((r) => r.toLowerCase())) : null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Deadline()), clampTimeoutMs(options.timeoutMs));
    const outcomes: PrLinkOutcome[] = [];
    try {
      for (const link of links) {
        const pr = `${link.fullName}#${link.number}`;
        if (allow && !allow.has(link.fullName.toLowerCase())) {
          outcomes.push({ pr, status: 'skipped', reason: 'not-in-repos' });
          continue;
        }
        const outcome = await this.checkOne(link, pr, options, controller.signal);
        outcomes.push(outcome);
        if (outcome.status === 'failed') return { ok: false, outcomes, failure: outcome };
      }
      return { ok: true, outcomes };
    } finally {
      clearTimeout(timer);
    }
  }

  private async checkOne(
    link: PullRequestLink,
    pr: string,
    options: PrLinkCheckOptions,
    signal: AbortSignal,
  ): Promise<PrLinkOutcome> {
    const token = this.deps.resolveToken();
    if (!token) return { pr, status: 'failed', reason: 'no-github-token' };
    const base = `${API}/repos/${encodeURIComponent(link.owner)}/${encodeURIComponent(link.repo)}/pulls/${link.number}`;

    const view = await this.call('GET', base, token, signal);
    if (view.kind === 'error') return { pr, status: 'failed', ...view.fail };
    if (view.status === 404) return { pr, status: 'skipped', reason: 'not-visible' };
    if (view.status === 401 || view.status === 403) return { pr, status: 'failed', reason: 'github-auth', detail: `HTTP ${view.status}` };
    if (view.status < 200 || view.status >= 300) return { pr, status: 'failed', reason: 'github-unreachable', detail: `HTTP ${view.status}` };
    const p = view.body as {
      state?: string; merged?: boolean;
      user?: { login?: string };
      head?: { sha?: string };
      requested_reviewers?: unknown;
      base?: { repo?: { owner?: { login?: string; type?: string }; permissions?: Record<string, boolean> } };
    } | null;
    // A 2xx with no readable body is not evidence the PR is closed.
    if (!p || typeof p !== 'object' || typeof p.state !== 'string') return { pr, status: 'failed', reason: 'github-unreachable', detail: 'unreadable pull request' };
    if (p.state !== 'open' || p.merged === true) return { pr, status: 'skipped', reason: 'not-open' };

    const perms = p.base?.repo?.permissions;
    if (perms && !perms.admin && !perms.maintain && !perms.push && !perms.triage) {
      return { pr, status: 'skipped', reason: 'no-write-access' };
    }

    const owner = p.base?.repo?.owner;
    const author = p.user?.login ?? null;
    const configured = (options.reviewerFor?.(link.fullName) ?? []).filter((l): l is string => typeof l === 'string' && l.length > 0);
    // A candidate who is the author falls through to the next one, then to the repo owner.
    const [reviewer] = [
      ...resolveReviewerLogins({ explicit: configured, author }),
      // An organisation cannot be a reviewer; with no configured login there is nobody to ask.
      ...resolveReviewerLogins({ repoOwner: owner?.type === 'User' ? owner.login ?? null : null, author }),
    ];
    if (!reviewer) return { pr, status: 'skipped', reason: 'no-reviewer' };

    const headSha = p.head?.sha ?? '';
    const cacheKey = `${pr.toLowerCase()}|${reviewer.toLowerCase()}|${headSha}`;
    const seenAt = this.satisfied.get(cacheKey);
    if (seenAt !== undefined && this.now() - seenAt < this.satisfiedTtlMs) {
      return { pr, status: 'already-requested', reviewer };
    }

    const lc = reviewer.toLowerCase();
    if (requestedReviewerLogins(p.requested_reviewers).some((l) => l.toLowerCase() === lc)) {
      this.remember(cacheKey);
      return { pr, status: 'already-requested', reviewer };
    }

    // Approved at the current head? (A failed reviews read just means we ask again: the request is idempotent.)
    const reviews = await this.call('GET', `${base}/reviews?per_page=100`, token, signal);
    if (reviews.kind === 'error' && reviews.fail.reason === 'github-timeout') return { pr, status: 'failed', reviewer, ...reviews.fail };
    if (reviews.kind === 'ok' && reviews.status >= 200 && reviews.status < 300 && headSha) {
      if (approvedAtHead(toReviewLike(reviews.body), reviewer, headSha).approved) {
        this.remember(cacheKey);
        return { pr, status: 'approved-at-head', reviewer };
      }
    }

    const post = await this.call('POST', `${base}/requested_reviewers`, token, signal, { reviewers: [reviewer] });
    if (post.kind === 'error') return { pr, status: 'failed', reviewer, ...post.fail };
    // 404 on the write after a readable PR = this token cannot write here: like no-write-access, nothing to ask with.
    if (post.status === 404) return { pr, status: 'skipped', reason: 'no-write-access' };
    if (post.status === 401 || post.status === 403) return { pr, status: 'failed', reason: 'github-auth', reviewer, detail: `HTTP ${post.status}` };
    if (post.status === 422) return { pr, status: 'failed', reason: 'request-rejected', reviewer, detail: githubMessage(post.body, post.status) };
    if (post.status < 200 || post.status >= 300) return { pr, status: 'failed', reason: 'github-unreachable', reviewer, detail: `HTTP ${post.status}` };
    if (confirmedRequested(post.body, [reviewer]).length === 0) {
      return { pr, status: 'failed', reason: 'request-not-confirmed', reviewer };
    }
    this.remember(cacheKey);
    return { pr, status: 'requested', reviewer };
  }

  private remember(key: string): void {
    const now = this.now();
    this.satisfied.set(key, now);
    if (this.satisfied.size > 500) {
      for (const [k, t] of this.satisfied) if (now - t >= this.satisfiedTtlMs) this.satisfied.delete(k);
    }
  }

  private async call(
    method: 'GET' | 'POST',
    url: string,
    token: string,
    signal: AbortSignal,
    body?: unknown,
  ): Promise<{ kind: 'ok'; status: number; body: unknown } | { kind: 'error'; fail: { reason: PrLinkFailReason; detail?: string } }> {
    if (signal.aborted) return { kind: 'error', fail: { reason: 'github-timeout' } };
    try {
      const res = await this.fetchImpl(url, {
        method,
        signal,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'instar-agent',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      let parsed: unknown = null;
      try { parsed = await res.json(); } catch { /* @silent-fallback-ok — a non-JSON body is judged by status alone */ }
      // The deadline can fire while the body is being read: that is a timeout, never a readable answer.
      if (signal.aborted) return { kind: 'error', fail: { reason: 'github-timeout' } };
      return { kind: 'ok', status: res.status, body: parsed };
    } catch (err) {
      if (signal.aborted) return { kind: 'error', fail: { reason: 'github-timeout' } };
      // Never surface raw error text that could carry request details; the class name is enough.
      return { kind: 'error', fail: { reason: 'github-unreachable', detail: err instanceof Error ? err.name : 'error' } };
    }
  }
}

function githubMessage(body: unknown, status: number): string {
  const m = body && typeof body === 'object' && typeof (body as { message?: unknown }).message === 'string'
    ? (body as { message: string }).message
    : '';
  return (m ? `HTTP ${status}: ${m}` : `HTTP ${status}`).slice(0, 200);
}

/** Failures that recur on every retry until someone changes a setting, a token or access. */
export function isPermanentPrLinkFailure(reason: PrLinkFailReason): boolean {
  return reason === 'no-github-token' || reason === 'github-auth' || reason === 'request-rejected';
}

/** The plain-English hold reason the sending session reads. */
export function prLinkHoldMessage(failure: Extract<PrLinkOutcome, { status: 'failed' }>): string {
  const who = failure.reviewer ? `${failure.reviewer}` : 'the reviewer';
  const why: Record<PrLinkFailReason, string> = {
    'no-github-token': 'this agent has no GitHub token to ask with',
    'github-auth': 'GitHub refused this agent\'s token for review requests on this repo',
    'github-unreachable': 'GitHub could not be reached',
    'github-timeout': 'GitHub did not answer in time',
    'request-rejected': 'GitHub rejected the review request',
    'request-not-confirmed': 'GitHub accepted the request but did not list them as a reviewer',
  };
  return (
    `Not sent yet: this message links pull request ${failure.pr}, and I could not make ${who} a requested reviewer on it ` +
    `(${why[failure.reason]}${failure.detail ? `, ${failure.detail}` : ''}). ` +
    'Every pull-request link sent to a person must arrive with them already asked to review. ' +
    (isPermanentPrLinkFailure(failure.reason)
      ? 'Retrying will not help until the token, the reviewer setting or their access to the repo is fixed; send the message without the link for now.'
      : 'Retry in a minute, or send the message without the link.')
  );
}
