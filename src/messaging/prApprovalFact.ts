/**
 * prApprovalFact — "will GitHub merge this pull request with nobody's approval?"
 *
 * WHY THIS EXISTS (Echo Bugs topic 10000002791, spec
 * docs/specs/approval-asks-only-where-required.md): the send-time PR-link hook
 * (prLinkReviewRequest.ts) asked GitHub to make the operator a reviewer on every
 * agent PR it saw linked, so PR #3326 (no constitution file touched, a ruleset
 * that requires no review) showed up in the operator's review requests seven
 * seconds after it opened. The operator approves only what the repository's
 * rules reserve to him (2.0 Rule 82; in 1.x, the CODEOWNERS paths).
 *
 * WHAT IT ANSWERS, exactly and only from recorded GitHub state:
 *   - 'not-required' — every read succeeded and shows: a governed approval surface
 *     (a ruleset `pull_request` rule with require_code_owner_review), no rule
 *     requiring a general approval, no classic review requirement (GitHub's own
 *     computed reviewDecision is null), and no changed file a code owner owns;
 *   - 'required'     — some read shows an approval is required;
 *   - 'ungoverned'   — the repository names no code-owner surface, so who approves
 *     is not stated by it (callers keep their existing behaviour);
 *   - 'unknown'      — anything unread, unparseable, unrecognised or truncated.
 * Only 'not-required' may change a caller's behaviour. It is a SIGNAL: nothing
 * here blocks or sends anything, and GitHub still enforces its rules at merge.
 */

import type { AuthenticatedGhExec } from '../core/githubRuntime.js';
import { parseCodeowners, codeOwnedFiles } from '../../scripts/local-verify-floor.mjs';

export type PrApprovalRequirement = 'not-required' | 'required' | 'ungoverned' | 'unknown';

export interface PrApprovalFact {
  requirement: PrApprovalRequirement;
  /** One plain clause naming what decided it (for the log line). */
  reason: string;
}

/** The `pull_request` rule parameters whose meaning is understood here. Anything else → unknown. */
export const KNOWN_PULL_REQUEST_PARAMS: ReadonlySet<string> = new Set([
  'allowed_merge_methods',
  'dismiss_stale_reviews_on_push',
  'require_code_owner_review',
  'require_last_push_approval',
  'required_approving_review_count',
  'required_review_thread_resolution',
  'required_reviewers',
  // Adds approvals only on top of a required count (agent PRs merge with zero
  // reviews while it is true and the count is 0: #3331, 2026-11-17).
  'require_extra_approval_for_unattributed_changes',
]);

/** GitHub stops listing a PR's files at 3000; a list that long may hide an owned path. */
export const PR_FILES_CAP = 3000;

/** GitHub's CODEOWNERS lookup order; the first file found is the one it uses. */
export const CODEOWNERS_LOCATIONS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'] as const;

export interface ApprovalInputs {
  /** Parsed `GET rules/branches/{base}` array, or null when unread. */
  rules: unknown[] | null;
  /** GraphQL reviewDecision: null = no review requirement computed; undefined = unread. */
  reviewDecision: string | null | undefined;
  /** CODEOWNERS text from the first location found; null = none at any location; undefined = unread. */
  codeowners: string | null | undefined;
  /** The PR's changed paths (new and, for renames, previous), or null when unread. */
  files: string[] | null;
}

/** Pure decision over the inputs. See the module header for the contract. */
export function approvalRequirement(i: ApprovalInputs): PrApprovalFact {
  if (!Array.isArray(i.rules)) return { requirement: 'unknown', reason: 'rulesets unread' };
  const prRules = i.rules.filter((r) => (r as { type?: unknown })?.type === 'pull_request');
  let governed = false;
  for (const rule of prRules) {
    const p = ((rule as { parameters?: unknown }).parameters ?? {}) as Record<string, unknown>;
    if (typeof p !== 'object' || p === null) return { requirement: 'unknown', reason: 'ruleset parameters unreadable' };
    const unknownKey = Object.keys(p).find((k) => !KNOWN_PULL_REQUEST_PARAMS.has(k));
    if (unknownKey) return { requirement: 'unknown', reason: `ruleset parameter not understood: ${unknownKey.slice(0, 60)}` };
    if (Number(p.required_approving_review_count ?? 0) > 0) return { requirement: 'required', reason: 'ruleset requires an approving review' };
    if (p.require_last_push_approval === true) return { requirement: 'required', reason: 'ruleset requires last-push approval' };
    if (Array.isArray(p.required_reviewers) && p.required_reviewers.length > 0) return { requirement: 'required', reason: 'ruleset names required reviewers' };
    if (p.require_code_owner_review === true) governed = true;
  }
  if (i.reviewDecision === undefined) return { requirement: 'unknown', reason: 'review decision unread' };
  if (i.reviewDecision !== null) return { requirement: 'required', reason: `GitHub review decision is ${String(i.reviewDecision).slice(0, 40)}` };
  if (!governed) return { requirement: 'ungoverned', reason: 'no code-owner review rule on the base branch' };
  if (i.codeowners === undefined) return { requirement: 'unknown', reason: 'CODEOWNERS unread' };
  if (i.codeowners === null) return { requirement: 'unknown', reason: 'code-owner review required but no CODEOWNERS found' };
  const rules = parseCodeowners(i.codeowners);
  // parseCodeowners returns null only for a non-string; kept as a guard if that ever widens.
  if (!rules) return { requirement: 'unknown', reason: 'CODEOWNERS unparseable' };
  if (!Array.isArray(i.files)) return { requirement: 'unknown', reason: 'changed files unread' };
  if (i.files.length >= PR_FILES_CAP) return { requirement: 'unknown', reason: 'changed-file list at GitHub cap' };
  const owned = codeOwnedFiles(i.files, rules);
  if (owned.length > 0) return { requirement: 'required', reason: `touches ${owned.length} code-owned file(s)` };
  return { requirement: 'not-required', reason: 'no rule requires a review and no code-owned file is touched' };
}

// RULE 3: EXEMPT — parses structured GitHub REST/GraphQL JSON from `gh api`, not agent/provider state detection.
function parseJson(stdout: string): unknown {
  try { return JSON.parse(stdout); } catch { return undefined; } // @silent-fallback-ok: unparseable gh output is an unread input, which the decision maps to 'unknown'
}

const is404 = (stderr: string) => /HTTP 404|Not Found/i.test(stderr);

async function readRules(gh: AuthenticatedGhExec, repo: string, base: string): Promise<unknown[] | null> {
  const r = await gh(['api', `repos/${repo}/rules/branches/${encodeURIComponent(base)}`]);
  if (r.code !== 0) return is404(r.stderr) ? [] : null;
  const body = parseJson(r.stdout);
  return Array.isArray(body) ? body : null;
}

async function readReviewDecision(gh: AuthenticatedGhExec, owner: string, name: string, number: number): Promise<string | null | undefined> {
  const query = 'query($o:String!,$n:String!,$p:Int!){repository(owner:$o,name:$n){pullRequest(number:$p){reviewDecision}}}';
  const r = await gh(['api', 'graphql', '-f', `query=${query}`, '-f', `o=${owner}`, '-f', `n=${name}`, '-F', `p=${number}`]);
  if (r.code !== 0) return undefined;
  const body = parseJson(r.stdout) as { data?: { repository?: { pullRequest?: { reviewDecision?: unknown } | null } } } | undefined;
  const pr = body?.data?.repository?.pullRequest;
  if (!pr || !('reviewDecision' in pr)) return undefined;
  const d = pr.reviewDecision;
  return d === null ? null : typeof d === 'string' ? d : undefined;
}

/** Read from the BASE branch on purpose: a PR that edits CODEOWNERS cannot change its own answer (and that edit is itself an owned touch). */
async function readCodeowners(gh: AuthenticatedGhExec, repo: string, base: string): Promise<string | null | undefined> {
  for (const loc of CODEOWNERS_LOCATIONS) {
    const r = await gh(['api', `repos/${repo}/contents/${loc}?ref=${encodeURIComponent(base)}`, '-H', 'Accept: application/vnd.github.raw']);
    if (r.code === 0) return r.stdout;
    if (!is404(r.stderr)) return undefined;
  }
  return null;
}

async function readFiles(gh: AuthenticatedGhExec, repo: string, number: number): Promise<string[] | null> {
  // A rename lists the new path as filename and the old one as previous_filename;
  // moving a code-owned file away touches it too, so both are checked.
  const r = await gh(['api', `repos/${repo}/pulls/${number}/files?per_page=100`, '--paginate', '--jq', '.[] | .filename, (.previous_filename // empty)']);
  if (r.code !== 0) return null;
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

/**
 * Read the fact for one PR. `base` comes from the PR view the caller already
 * holds (never re-read). Repo-level and PR-level reads run in parallel. Never throws.
 */
export async function readPrApprovalFact(
  ref: { owner: string; repo: string; number: number },
  base: string | null | undefined,
  gh: AuthenticatedGhExec,
): Promise<PrApprovalFact> {
  if (!base) return { requirement: 'unknown', reason: 'base branch unknown' };
  const repo = `${ref.owner}/${ref.repo}`;
  try {
    const [rules, reviewDecision, codeowners, files] = await Promise.all([
      readRules(gh, repo, base),
      readReviewDecision(gh, ref.owner, ref.repo, ref.number),
      readCodeowners(gh, repo, base),
      readFiles(gh, repo, ref.number),
    ]);
    return approvalRequirement({ rules, reviewDecision, codeowners, files });
  } catch (err) {
    return { requirement: 'unknown', reason: `read failed: ${err instanceof Error ? err.message.slice(0, 80) : 'unexpected error'}` };
  }
}
