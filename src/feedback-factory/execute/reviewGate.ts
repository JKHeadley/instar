/**
 * The executor's own review gate (docs/specs/feedback-triage-and-execution.md §4 step 9).
 *
 * Pure decisions over facts the trusted code reads from GitHub each tick:
 *  - who the approver is (the repository owner for a user-owned repository, read from the API —
 *    no agent-writable setting chooses it; a PIN-set login for an organization);
 *  - whether the agent itself could act as that approver (its own GitHub login, a browser
 *    profile account, an owned identity or a tagged vault entry) → `approver-not-independent`;
 *  - whether the approver approved the PR's CURRENT head SHA (any other account is ignored);
 *  - how a `safe-merge --auto --match-head-commit` exit maps to an execution state;
 *  - which changed paths CODEOWNERS assigns to someone other than the approver.
 */

export interface RepoInfo { ownerLogin: string; ownerType: 'User' | 'Organization' | string; allowAutoMerge: boolean }
export interface PrReview { login: string; state: string; commitId: string; submittedAt: string }

export function deriveApprover(repo: RepoInfo, pinSetOrgApprover: string | null): { login: string } | { error: 'approver-unset' } {
  if (repo.ownerType === 'User') return { login: repo.ownerLogin };
  return pinSetOrgApprover ? { login: pinSetOrgApprover } : { error: 'approver-unset' };
}

export interface AgentIdentityFacts {
  agentGithubLogin: string | null;
  /** Accounts in the Playwright profile registry: `{ service, identity }`. */
  profileAccounts: Array<{ service: string; identity: string; vaultRefs?: string[] }>;
  /** Entries in the owned-identities registry. */
  ownedIdentities: Array<{ service: string; identity: string }>;
  /** Vault key NAMES (never values); null when unreadable. */
  vaultNames: string[] | null;
  /** Identity registries that exist but could not be read: their absence of a match proves nothing. */
  unreadableSources?: string[];
}

/**
 * The approver is independent only when the agent cannot itself act as that login. Every
 * matching fact is reported (names only). An unreadable agent login counts as NOT independent —
 * the executor cannot prove the separation it relies on.
 */
export function approverIndependence(approver: string, facts: AgentIdentityFacts): { independent: boolean; reasons: string[] } {
  const a = approver.toLowerCase();
  const reasons: string[] = [];
  if (facts.agentGithubLogin === null) reasons.push('agent-github-login-unreadable');
  else if (facts.agentGithubLogin.toLowerCase() === a) reasons.push('agent-github-login');
  if ((facts.unreadableSources ?? []).length > 0) reasons.push('identity-registry-unreadable');
  for (const acct of facts.profileAccounts) {
    if (acct.service.toLowerCase() === 'github' && acct.identity.toLowerCase() === a) reasons.push('browser-profile-account');
  }
  for (const id of facts.ownedIdentities) {
    if (id.service.toLowerCase() === 'github' && id.identity.toLowerCase() === a) reasons.push('owned-identity');
  }
  // A vault entry is "tagged" for the approver when an account record names it for that login,
  // or (when the vault's key names are readable) when a key name carries the login itself.
  const taggedRefs = new Set(facts.profileAccounts.filter((p) => p.identity.toLowerCase() === a).flatMap((p) => p.vaultRefs ?? []));
  if (taggedRefs.size > 0 || (facts.vaultNames ?? []).some((name) => name.toLowerCase().includes(a))) reasons.push('tagged-vault-entry');
  return { independent: reasons.length === 0, reasons: [...new Set(reasons)] };
}

/** The approver's MOST RECENT review must be APPROVED and on exactly `headSha`. */
export function approvedAtHead(reviews: PrReview[], approver: string, headSha: string): { approved: boolean; latestState: string | null } {
  const mine = reviews.filter((r) => r.login.toLowerCase() === approver.toLowerCase() && r.state !== 'COMMENTED' && r.state !== 'PENDING');
  if (mine.length === 0) return { approved: false, latestState: null };
  const latest = [...mine].sort((x, y) => Date.parse(x.submittedAt) - Date.parse(y.submittedAt)).at(-1)!;
  return { approved: latest.state === 'APPROVED' && latest.commitId === headSha, latestState: latest.state };
}

/** True when the approver has ever approved exactly `sha` (used to clear a merged-elsewhere item after the fact). */
export function approvedSha(reviews: PrReview[], approver: string, sha: string): boolean {
  return reviews.some((r) => r.login.toLowerCase() === approver.toLowerCase() && r.state === 'APPROVED' && r.commitId === sha);
}

export type MergeVerdict =
  | { state: 'merged' }
  | { state: 'merge-armed' }
  | { state: 'merge-refused'; reason: string };

/**
 * safe-merge exit codes: 0 merged · 1 refused · 2 usage/error · 3 already merged · 4 closed ·
 * 5 auto-merge armed. 0 and 3 → merged; 5 → merge-armed; everything else → merge-refused with
 * the classified slug from the final `safe-merge-result:` line when present.
 */
export function mapSafeMergeExit(exitCode: number | null, stdout: string): MergeVerdict {
  if (exitCode === 0 || exitCode === 3) return { state: 'merged' };
  if (exitCode === 5) return { state: 'merge-armed' };
  const line = stdout.split('\n').reverse().find((l) => l.startsWith('safe-merge-result:'));
  let slug = exitCode === 4 ? 'closed' : exitCode === 2 ? 'error' : 'refused';
  if (line) {
    try {
      // RULE 3: EXEMPT — parses safe-merge's own documented machine-readable result line (a stable contract).
      const parsed = JSON.parse(line.slice('safe-merge-result:'.length)) as { result?: string };
      if (typeof parsed.result === 'string') slug = parsed.result.replace(/^refused:/, '').slice(0, 60);
    } catch { /* @silent-fallback-ok: an unparseable line keeps the exit-code slug */ }
  }
  return { state: 'merge-refused', reason: slug };
}

/**
 * Minimal CODEOWNERS matcher (last matching rule wins, GitHub semantics for the common forms:
 * `*`, `/dir/`, `dir/`, `*.ext`, exact paths). Returns the changed paths whose owners exist and
 * do not include `@approver`.
 */
export function codeownersOutsideApprover(codeowners: string | null, paths: string[], approver: string): string[] {
  if (!codeowners) return [];
  const rules: Array<{ re: RegExp; owners: string[] }> = [];
  for (const raw of codeowners.split('\n')) {
    const lineText = raw.replace(/#.*$/, '').trim();
    if (!lineText) continue;
    const [pattern, ...owners] = lineText.split(/\s+/);
    rules.push({ re: codeownersPattern(pattern), owners: owners.map((o) => o.replace(/^@/, '').toLowerCase()) });
  }
  const me = approver.toLowerCase();
  const out: string[] = [];
  for (const p of paths) {
    let owners: string[] | null = null;
    for (const rule of rules) if (rule.re.test(p)) owners = rule.owners;
    if (owners && owners.length > 0 && !owners.includes(me)) out.push(p);
  }
  return out;
}

function codeownersPattern(pattern: string): RegExp {
  const anchored = pattern.startsWith('/');
  let p = pattern.replace(/^\//, '');
  const dir = p.endsWith('/');
  if (dir) p = p.slice(0, -1);
  const body = p.split('/').map((seg) => seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*').replace(/\?/g, '[^/]')).join('/');
  const prefix = anchored || p.includes('/') ? '^' : '(^|.*/)';
  return new RegExp(`${prefix}${body}${dir ? '/.*' : '(/.*)?'}$`);
}
