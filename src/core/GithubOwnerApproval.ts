/**
 * Approve a code-owner pull request on the owner's Face ID tap (docs/specs/github-approval-from-the-app.md).
 *
 * The owner's phone proves the decision (mobilePermissionsRoutes.ts); this service does the rest:
 *   - availability(): is everything the approval needs present on THIS machine (no network)?
 *   - precheck():     is this PR one the merge watcher says waits for the owner, still open, and at
 *                     exactly the head the owner saw (snapshot, request and live GitHub agree)?
 *   - start():        record the approval through the owner's signed-in GitHub browser profile
 *                     (scripts/github-owner-approve.mjs), then ask GitHub what was recorded.
 *
 * GitHub's reviews read is the only judge of success: the script's own report counts for nothing.
 * Secrets go to the script on stdin only; nothing here logs, returns or passes a secret on argv/env.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { maybeRotateJsonl } from '../utils/jsonl-rotation.js';
import { SafeFsExecutor } from './SafeFsExecutor.js';
import { withSyncOp } from './InFlightSyncOpMarker.js';

const SHA = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const LOGIN = /^[A-Za-z0-9-]{1,39}$/;
/** The approver script's deadline; the verification read below decides the answer whatever happens. */
export const APPROVER_DEADLINE_MS = 120_000;
/** How long availability is cached (it reads files and loads a module; no network). */
export const AVAILABILITY_CACHE_MS = 60_000;
/** The GitHub reads before a run share this deadline (inside the route's 25-second wait). */
export const PRECHECK_DEADLINE_MS = 10_000;
/** How long a finished run stays readable by the phone. */
export const RUN_KEEP_MS = 3_600_000;
/** Verification re-reads when the first read after the script fails (the review may have landed). */
const VERIFY_ATTEMPTS = 3;
const VERIFY_GAP_MS = 5_000;

export type ApprovalOutcome =
  | 'approved' | 'already-approved' | 'approved-at-other-head' | 'approval-not-recorded' | 'verification-pending';

export interface ApprovalResult { status: number; body: Record<string, unknown> }

export interface ApprovalRun {
  id: string;
  pr: number;
  /** The owner's review ids before the script ran (only a NEW review counts). */
  baseline?: number[];
  /** The approver's process group, while it may be running (killed before a restart reconciles). */
  pgid?: number;
  headSha: string;
  state: 'running' | 'approved' | 'failed';
  outcome?: string;
  reviewId?: number;
  commitId?: string;
  verifiedAt?: string;
  startedAt: number;
  finishedAt?: number;
  result?: ApprovalResult;
}

export interface OwnerProfile {
  userDataDir: string;
  /** The owner's GitHub login: the sign-in name, and whose reviews count. */
  identity: string;
  passwordRef: string;
  totpRef: string;
}

export interface ReviewRow { id: number; state: string; commit_id: string | null; submitted_at: string | null; user: { login: string } | null }
export interface PrRead { state: string; merged: boolean; headSha: string; title: string; baseSha: string }

export interface GithubOwnerApprovalDeps {
  /** `github.ownerApproval` from the live config. */
  config: () => { enabled?: unknown; profileId?: unknown; playwrightCoreDir?: unknown } | undefined;
  /** The merge watcher's configured repository (`owner/name`), or null. */
  repo: () => string | null;
  /** The Playwright Profile Registry's profiles. */
  profiles: () => Array<{ id?: unknown; userDataDir?: unknown; accounts?: unknown }>;
  /** Does this vault name hold a non-empty value? (names only; never returns the value) */
  hasSecret: (name: string) => boolean;
  /** Read one secret value (only ever written to the script's stdin). */
  readSecret: (name: string) => string | null;
  /** The repository checkout's `.github/CODEOWNERS` text, or null (availability only: is the owner a code owner at all). */
  codeowners: () => string | null;
  /** `.github/CODEOWNERS` at a commit of the repository on GitHub (the PR's base), or null when absent. */
  readCodeownersAt: (repo: string, sha: string) => Promise<string | null>;
  /** Does playwright-core load from this directory? */
  playwrightLoads: (dir: string) => boolean;
  readPr: (repo: string, pr: number) => Promise<PrRead>;
  readReviews: (repo: string, pr: number) => Promise<ReviewRow[]>;
  /** The PR's changed file paths (every page). */
  readFiles: (repo: string, pr: number) => Promise<string[]>;
  /** Run the approver with this stdin; resolves with its outcome word and the TOTP step it used. */
  runApprover: (input: Record<string, unknown>, deadlineMs: number, onSpawn?: (pgid: number) => void) => Promise<{ outcome: string; step?: number }>;
  /** Kill an approver process group left by an earlier server (SIGKILL; a gone group is fine). */
  killGroup?: (pgid: number) => void;
  /** The watcher's own ownership read (the one `applyHold` uses): is this the agent's own PR? */
  isAgentPr: (pr: number) => Promise<boolean>;
  /** The watcher's HOLD (so nothing merges an approval on an unseen head). */
  applyHold: (pr: number, reason: string) => Promise<{ ok: boolean }>;
  /** The per-profile lock every process on the machine respects: true when taken. */
  lock: (userDataDir: string) => boolean;
  unlock: (userDataDir: string) => void;
  audit: (row: Record<string, unknown>) => void;
  /** Durable attempts (latest per PR), written before the script runs so a restart can reconcile. */
  runsStore?: { load: () => ApprovalRun[]; save: (runs: ApprovalRun[]) => void };
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  ghPath?: string;
}

const ROLE = (refs: string[], word: string): string | null => {
  const hits = refs.filter((r) => r.toLowerCase().includes(word));
  return hits.length === 1 ? hits[0] : null;
};

/** The single GitHub operator profile (by id when configured), or why there is none. */
export function selectOwnerProfile(profiles: GithubOwnerApprovalDeps['profiles'] extends () => infer R ? R : never, profileId: string | null): OwnerProfile | string {
  type Acc = { service?: unknown; identity?: unknown; owner?: unknown; vaultRefs?: unknown; vaultBindings?: unknown };
  const candidates: Array<{ dir: string; acc: Acc }> = [];
  for (const p of profiles) {
    if (!p || typeof p !== 'object') continue;
    if (profileId !== null && p.id !== profileId) continue;
    const accounts = Array.isArray(p.accounts) ? (p.accounts as Acc[]) : [];
    for (const a of accounts) {
      if (a && typeof a.service === 'string' && a.service.toLowerCase() === 'github' && a.owner === 'operator' && typeof p.userDataDir === 'string') candidates.push({ dir: p.userDataDir, acc: a });
    }
  }
  if (candidates.length === 0) return 'no GitHub sign-in for the owner on this machine';
  if (candidates.length > 1) return 'more than one GitHub sign-in for the owner is registered; name one in github.ownerApproval.profileId';
  const { dir, acc } = candidates[0];
  if (typeof acc.identity !== 'string' || !LOGIN.test(acc.identity)) return 'the owner\'s GitHub sign-in has no GitHub login recorded';
  const refs = Array.isArray(acc.vaultRefs) ? acc.vaultRefs.filter((r): r is string => typeof r === 'string') : [];
  const b = (acc.vaultBindings && typeof acc.vaultBindings === 'object' ? acc.vaultBindings : {}) as { password?: unknown; totp?: unknown };
  // The typed role bindings first; else the one reference whose name says its role.
  const passwordRef = typeof b.password === 'string' && b.password ? b.password : ROLE(refs, 'password');
  const totpRef = typeof b.totp === 'string' && b.totp ? b.totp : ROLE(refs, 'totp');
  if (!passwordRef || !totpRef) return 'the owner\'s GitHub sign-in needs one saved password and one two-factor secret';
  return { userDataDir: dir, identity: acc.identity, passwordRef, totpRef };
}

/** One CODEOWNERS rule: its pattern and owners, in file order. */
export interface CodeownersRule { pattern: string; owners: string[] }

/** Parse CODEOWNERS; null when a pattern uses syntax this reader does not handle (`**`, `?`, `[`, `!`, `\\`). */
export function parseCodeowners(text: string): CodeownersRule[] | null {
  const rules: CodeownersRule[] = [];
  for (const line of text.split('\n')) {
    const l = line.replace(/#.*$/, '').trim();
    if (!l) continue;
    const [pattern, ...owners] = l.split(/\s+/);
    if (/\*\*|[?[\]!\\]/.test(pattern)) return null;
    rules.push({ pattern, owners: owners.map((o) => o.toLowerCase()) });
  }
  return rules;
}

/** Is `login` listed as an owner of anything in this CODEOWNERS text? */
export function isCodeOwner(codeowners: string, login: string): boolean {
  const rules = parseCodeowners(codeowners);
  const want = `@${login.toLowerCase()}`;
  return !!rules && rules.some((r) => r.owners.includes(want));
}

/**
 * Does a CODEOWNERS pattern cover this repository path? Literal paths, `dir/` prefixes and `*`
 * within one segment; anchored at the root when the pattern starts with `/` or holds a `/`, a bare
 * name matches at any depth. (The patterns this repository uses are literal paths.)
 */
export function patternCovers(pattern: string, file: string): boolean {
  let p = pattern.trim();
  if (!p) return false;
  const anchored = p.startsWith('/') || p.slice(0, -1).includes('/');
  p = p.replace(/^\//, '');
  const dir = p.endsWith('/');
  if (dir) p = p.slice(0, -1);
  if (p === '*' && !anchored) return true;
  const body = p.split('/').map((seg) => seg.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('/');
  const lastHasStar = p.split('/').pop()!.includes('*');
  const re = new RegExp(`${anchored ? '^' : '(^|/)'}${body}${dir ? '/' : lastHasStar ? '$' : '(/|$)'}`);
  return re.test(file);
}

/**
 * The changed files whose owner is `login`. GitHub's rule: the LAST matching pattern decides a file's
 * owners. Null when the CODEOWNERS text uses syntax this reader does not handle (never guessed).
 */
export function ownerFilesOf(files: string[], codeowners: string, login: string): string[] | null {
  const rules = parseCodeowners(codeowners);
  if (!rules) return null;
  const want = `@${login.toLowerCase()}`;
  return files.filter((f) => {
    let last: CodeownersRule | null = null;
    for (const r of rules) if (patternCovers(r.pattern, f)) last = r;
    return !!last && last.owners.includes(want);
  });
}

/** The owner's latest decisive review (APPROVED / CHANGES_REQUESTED / DISMISSED), by submitted time then id. */
export function ownerLatest(reviews: ReviewRow[], identity: string): ReviewRow | null {
  const me = identity.toLowerCase();
  const mine = reviews.filter((r) => r && r.user && typeof r.user.login === 'string' && r.user.login.toLowerCase() === me
    && (r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED' || r.state === 'DISMISSED'));
  mine.sort((a, b) => (Date.parse(a.submitted_at ?? '') || 0) - (Date.parse(b.submitted_at ?? '') || 0) || a.id - b.id);
  return mine.length ? mine[mine.length - 1] : null;
}

export class GithubOwnerApproval {
  private cached: { at: number; value: { available: boolean; reason: string | null; profile?: OwnerProfile; repo?: string; coreDir?: string } } | null = null;
  private readonly runs = new Map<number, ApprovalRun>();
  /** Every attempt kept (an hour), by id, so a later attempt never hides an earlier one's answer. */
  private readonly byId = new Map<string, ApprovalRun>();
  /** Attempt ids a worker in THIS process is running (anything else 'running' was interrupted). */
  private readonly active = new Set<string>();
  /** The last TOTP step used, so two runs never send the same code (floored at start: a restart may follow a run). */
  private lastStep: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: GithubOwnerApprovalDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.lastStep = Math.floor(this.now() / 30_000);
    try { for (const r of deps.runsStore?.load() ?? []) if (r && typeof r.pr === 'number' && typeof r.id === 'string') { this.byId.set(r.id, r); const cur = this.runs.get(r.pr); if (!cur || cur.startedAt <= r.startedAt) this.runs.set(r.pr, r); } } catch { /* @silent-fallback-ok — an unreadable store starts empty; a re-tap answers from GitHub */ }
  }

  private persist(): void {
    try { this.deps.runsStore?.save([...this.byId.values()].map(({ result, ...r }) => ({ ...r, ...(result ? { result } : {}) }))); } catch { /* @silent-fallback-ok — the in-memory run still answers; a restart then reads 'none' and a re-tap answers from GitHub */ }
  }

  /** Everything the approval needs, on this machine, without a network call. Cached briefly. */
  availability(fresh = false): { available: boolean; reason: string | null } {
    const v = this.resolve(fresh);
    return { available: v.available, reason: v.reason };
  }

  private resolve(fresh = false): { available: boolean; reason: string | null; profile?: OwnerProfile; repo?: string; coreDir?: string } {
    if (!fresh && this.cached && this.now() - this.cached.at < AVAILABILITY_CACHE_MS) return this.cached.value;
    const value = this.compute();
    this.cached = { at: this.now(), value };
    return value;
  }

  private compute(): { available: boolean; reason: string | null; profile?: OwnerProfile; repo?: string; coreDir?: string } {
    const no = (reason: string) => ({ available: false, reason });
    try {
      const cfg = this.deps.config() ?? {};
      if (cfg.enabled !== true) return no('approving from the app is switched off on this agent');
      const repo = this.deps.repo();
      if (!repo || !REPO.test(repo)) return no('the merge watcher does not name a repository here');
      const profileId = typeof cfg.profileId === 'string' && cfg.profileId ? cfg.profileId : null;
      const picked = selectOwnerProfile(this.deps.profiles(), profileId);
      if (typeof picked === 'string') return no(picked);
      if (!fs.existsSync(picked.userDataDir)) return no('no GitHub sign-in for the owner on this machine');
      for (const ref of [picked.passwordRef, picked.totpRef]) {
        if (!this.deps.hasSecret(ref)) return no('a saved GitHub sign-in detail for the owner is missing from the vault');
      }
      const co = this.deps.codeowners();
      if (!co || !isCodeOwner(co, picked.identity)) return no('the owner\'s GitHub account is not a code owner of this repository');
      const coreDir = typeof cfg.playwrightCoreDir === 'string' ? cfg.playwrightCoreDir : '';
      if (!coreDir || !this.deps.playwrightLoads(coreDir)) return no('the browser tool the approval uses is not installed here');
      return { available: true, reason: null, profile: picked, repo, coreDir };
    } catch {
      // @silent-fallback-ok — not silent: the reason is shown on every row and every refusal
      return no('the agent could not check whether it can approve here');
    }
  }

  /** The latest run for a PR (kept an hour). */
  run(pr: number): ApprovalRun | null {
    this.prune();
    return this.runs.get(pr) ?? null;
  }

  /** What the phone reads after a 202: the attempt's state plus its finished answer, in full (by attempt id when given). */
  async runView(pr: number, attemptId?: string): Promise<Record<string, unknown>> {
    this.prune();
    let r = attemptId ? (this.byId.get(attemptId) ?? null) : this.run(pr);
    if (r && r.pr !== pr) r = null;
    if (r && r.state === 'running' && !this.active.has(r.id)) { await this.reconcile(r); }
    if (!r) return { state: 'none', pr, detail: 'Nothing is known about an approval of this pull request here. Tap Approve again; if GitHub already shows your approval, nothing more happens.' };
    return { ...(r.result ? r.result.body : {}), state: r.state, attemptId: r.id, pr: r.pr, headSha: r.headSha, ...(r.outcome ? { outcome: r.outcome } : {}) };
  }

  /**
   * Can an approval of `pr` at `headSha` start? Answers null when yes, else the refusal. Judged live
   * (not from the merge watcher's snapshot, which only the lease holder refreshes): the PR is open,
   * at exactly `headSha`, and changes a path CODEOWNERS assigns to the owner.
   */
  async precheck(pr: unknown, headSha: unknown): Promise<ApprovalResult | null> {
    if (typeof pr !== 'number' || !Number.isInteger(pr) || pr <= 0) return { status: 400, body: { error: 'bad-pr' } };
    if (typeof headSha !== 'string' || !SHA.test(headSha)) return { status: 400, body: { error: 'bad-head-sha', detail: 'The version you are approving was not sent.' } };
    const v = this.resolve();
    if (!v.available) return { status: 503, body: { error: 'github-approval-unavailable', reason: v.reason, detail: v.reason } };
    let live: PrRead;
    let files: string[];
    try { [live, files] = await Promise.all([this.deps.readPr(v.repo!, pr), this.deps.readFiles(v.repo!, pr)]); } catch {
      // @silent-fallback-ok — not silent: answered as 502 github-unreachable
      return { status: 502, body: { error: 'github-unreachable', detail: 'GitHub did not answer. Try again in a moment.' } };
    }
    if (live.state !== 'open' || live.merged) return { status: 409, body: { error: 'pr-not-open', detail: 'This pull request is no longer open.' } };
    if (live.headSha !== headSha) {
      return { status: 409, body: { error: 'head-changed', currentHead: live.headSha, prTitle: live.title, detail: 'The pull request changed since you looked. Review the new version first.' } };
    }
    let own: boolean;
    try { own = await this.deps.isAgentPr(pr); } catch {
      // @silent-fallback-ok — not silent: answered as 502 github-unreachable
      return { status: 502, body: { error: 'github-unreachable', detail: 'GitHub did not answer. Try again in a moment.' } };
    }
    if (!own) return { status: 409, body: { error: 'not-agent-pr', detail: 'Only pull requests the agent opened can be approved from the app. Open it on GitHub.' } };
    let co: string | null;
    try { co = await this.deps.readCodeownersAt(v.repo!, live.baseSha); } catch {
      // @silent-fallback-ok — not silent: answered as 502 github-unreachable
      return { status: 502, body: { error: 'github-unreachable', detail: 'GitHub did not answer. Try again in a moment.' } };
    }
    const owned = co === null ? [] : ownerFilesOf(files, co, v.profile!.identity);
    if (owned === null) return { status: 409, body: { error: 'codeowners-unreadable', detail: 'The ownership file uses rules I cannot read, so I will not approve from here. Open it on GitHub.' } };
    if (owned.length === 0) {
      return { status: 409, body: { error: 'not-awaiting-owner-review', detail: 'This pull request does not change anything that needs your approval.' } };
    }
    return null;
  }

  /**
   * Start an approval after the owner's proof. Resolves when the run finishes or `waitMs` passes;
   * a run still going answers 202 and keeps going (read it with run()).
   */
  async start(input: { pr: number; headSha: string; deviceId: string | null }, waitMs = 25_000): Promise<ApprovalResult> {
    const t0 = this.now();
    // The GitHub reads before the run share one short deadline, so the answer (or the 202) still comes
    // inside the phone's 30-second wait.
    const refusal = await Promise.race([
      this.precheck(input.pr, input.headSha),
      new Promise<ApprovalResult>((r) => { const t = setTimeout(() => r({ status: 502, body: { error: 'github-unreachable', detail: 'GitHub was too slow to answer. Nothing was approved. Try again in a moment.' } }), PRECHECK_DEADLINE_MS); (t as { unref?: () => void }).unref?.(); }),
    ]);
    if (refusal) { this.deps.audit({ pr: input.pr, headSha: input.headSha, deviceId: input.deviceId, outcome: String(refusal.body.error) }); return refusal; }
    const prof = this.resolve().profile!;
    // An earlier attempt no worker here owns must be settled first: its approval (if any) must be judged
    // against its own baseline, never folded into this run's.
    for (const r of [...this.byId.values()]) if (r.state === 'running' && !this.active.has(r.id)) await this.reconcile(r);
    if ([...this.byId.values()].some((r) => r.state === 'running' && !this.active.has(r.id))) {
      this.deps.audit({ pr: input.pr, headSha: input.headSha, deviceId: input.deviceId, outcome: 'approval-unsettled' });
      return { status: 409, body: { error: 'approval-unsettled', detail: 'I could not yet check how an earlier approval ended. Try again in a minute, or open it on GitHub.' } };
    }
    if (!this.deps.lock(prof.userDataDir)) {
      this.deps.audit({ pr: input.pr, headSha: input.headSha, deviceId: input.deviceId, outcome: 'approval-in-progress' });
      return { status: 409, body: { error: 'approval-in-progress', detail: 'Another approval is running. Try again in a minute.' } };
    }
    const run: ApprovalRun = { id: randomUUID(), pr: input.pr, headSha: input.headSha, state: 'running', startedAt: this.now() };
    this.runs.set(input.pr, run);
    this.byId.set(run.id, run);
    this.active.add(run.id);
    this.persist();
    const work = this.execute(run, input.deviceId).finally(() => { this.active.delete(run.id); this.persist(); this.deps.unlock(prof.userDataDir); });
    const left = Math.max(1_000, waitMs - (this.now() - t0));
    const timer = new Promise<'waiting'>((r) => { const t = setTimeout(() => r('waiting'), left); (t as { unref?: () => void }).unref?.(); });
    const first = await Promise.race([work.then(() => 'done' as const), timer]);
    if (first === 'done' && run.result) return run.result;
    if (first === 'done' && run.state === 'running') return { status: 202, body: { state: 'running', attemptId: run.id, pr: run.pr, headSha: run.headSha, detail: 'I could not read GitHub yet to check whether your approval landed. I will check again when you look.' } };
    return { status: 202, body: { state: 'running', attemptId: run.id, pr: run.pr, headSha: run.headSha } };
  }

  private async execute(run: ApprovalRun, deviceId: string | null): Promise<void> {
    const v = this.resolve();
    const finish = (state: ApprovalRun['state'], outcome: string, result: ApprovalResult, extra: Partial<ApprovalRun> = {}) => {
      Object.assign(run, { state, outcome, result, finishedAt: this.now() }, extra);
      this.deps.audit({ pr: run.pr, headSha: run.headSha, deviceId, outcome, ...(extra.reviewId ? { reviewId: extra.reviewId } : {}), ...(extra.commitId ? { commitId: extra.commitId } : {}) });
    };
    try {
      const profile = v.profile!, repo = v.repo!;
      let before: ReviewRow[];
      try { before = await this.deps.readReviews(repo, run.pr); } catch {
        // @silent-fallback-ok — not silent: answered as 502 github-unreachable
        finish('failed', 'github-unreachable', { status: 502, body: { error: 'github-unreachable', detail: 'GitHub did not answer. Nothing was approved. Try again in a moment.' } });
        return;
      }
      const latest = ownerLatest(before, profile.identity);
      if (latest && latest.state === 'APPROVED' && latest.commit_id === run.headSha) {
        const verifiedAt = new Date(this.now()).toISOString();
        finish('approved', 'already-approved', { status: 200, body: { approved: true, already: true, reviewId: latest.id, commitId: latest.commit_id, verifiedAt } }, { reviewId: latest.id, commitId: latest.commit_id, verifiedAt });
        return;
      }
      run.baseline = before.map((r) => r.id);
      this.persist();
      const seen = new Set(run.baseline);
      const password = this.deps.readSecret(profile.passwordRef), totpSecret = this.deps.readSecret(profile.totpRef);
      let scriptOutcome = 'error';
      if (!password || !totpSecret) scriptOutcome = 'secrets-missing';
      else {
        try {
          const r = await this.deps.runApprover({
            repo, pr: run.pr, headSha: run.headSha, expectedLogin: profile.identity, userDataDir: profile.userDataDir,
            playwrightCoreDir: v.coreDir, ghPath: this.deps.ghPath ?? 'gh', password, totpSecret, notBeforeStep: this.lastStep,
          }, APPROVER_DEADLINE_MS, (pgid) => { run.pgid = pgid; this.persist(); });
          scriptOutcome = r.outcome;
          if (typeof r.step === 'number' && r.step > this.lastStep) this.lastStep = r.step;
        } catch {
          // @silent-fallback-ok — not silent: the verification read below decides, and the outcome word is reported
          scriptOutcome = 'error';
        }
        delete run.pgid;
        // Whatever the script reported, the current code is spent: the next run waits for a fresh one.
        this.lastStep = Math.max(this.lastStep, Math.floor(this.now() / 30_000));
      }
      // Verify, whatever the script said: only a NEW owner review counts.
      let after: ReviewRow[] | null = null;
      for (let i = 0; i < VERIFY_ATTEMPTS && after === null; i++) {
        try { after = await this.deps.readReviews(repo, run.pr); } catch {
          // @silent-fallback-ok — retried; reported as verification-pending when every read fails
          if (i < VERIFY_ATTEMPTS - 1) await this.sleep(VERIFY_GAP_MS);
        }
      }
      if (after === null) {
        // Not final: the run stays 'running' with no worker, so the next read settles it from GitHub (HOLD included).
        run.outcome = 'verification-pending';
        this.deps.audit({ pr: run.pr, headSha: run.headSha, deviceId, outcome: 'verification-pending' });
        return;
      }
      await this.judge(run, after, seen, profile.identity, scriptOutcome, finish);
    } catch {
      // @silent-fallback-ok — not silent: the run is answered as failed with outcome error
      finish('failed', 'error', { status: 500, body: { error: 'approval-failed', detail: 'The approval did not finish. Check on GitHub before trying again.' } });
    }
  }

  /** Decide a run from GitHub's reviews: only a NEW owner review counts. */
  private async judge(run: ApprovalRun, after: ReviewRow[], seen: Set<number>, identity: string, scriptOutcome: string,
    finish: (state: ApprovalRun['state'], outcome: string, result: ApprovalResult, extra?: Partial<ApprovalRun>) => void): Promise<void> {
    {
      const fresh = ownerLatest(after, identity);
      const isNew = fresh !== null && !seen.has(fresh.id);
      if (isNew && fresh.state === 'APPROVED' && fresh.commit_id === run.headSha) {
        const verifiedAt = new Date(this.now()).toISOString();
        finish('approved', 'approved', { status: 200, body: { approved: true, already: false, reviewId: fresh.id, commitId: fresh.commit_id, verifiedAt } }, { reviewId: fresh.id, commitId: fresh.commit_id ?? undefined, verifiedAt });
        return;
      }
      if (isNew && fresh.state === 'APPROVED') {
        let held = false;
        for (let i = 0; i < 2 && !held; i++) {
          try { held = (await this.deps.applyHold(run.pr, 'owner approval landed on a newer head than the one approved')).ok; } catch { /* @silent-fallback-ok — retried once, then reported in the answer as held:false */ }
        }
        finish('failed', 'approved-at-other-head', { status: 409, body: { error: 'approved-at-other-head', commitId: fresh.commit_id, held, detail: held
          ? 'Your approval landed on a newer version than the one you saw. I put the pull request on hold so nothing merges it; it stays on hold until the agent that opened it releases it. You can approve the new version once you have looked at it.'
          : 'Your approval landed on a newer version than the one you saw, and I could not put it on hold. Open it on GitHub now.' } }, { reviewId: fresh.id, commitId: fresh.commit_id ?? undefined });
        return;
      }
      finish('failed', scriptOutcome, { status: 502, body: { error: 'approval-not-recorded', outcome: scriptOutcome, detail: 'GitHub does not show your approval. Nothing was approved. Try again, or open it on GitHub.' } });
    }
  }

  /** A 'running' attempt no worker here owns (the server restarted mid-run): settle it from GitHub. */
  private async reconcile(run: ApprovalRun): Promise<void> {
    // An approver left by an earlier server could still click: stop it before judging.
    if (typeof run.pgid === 'number' && run.pgid > 0) { try { this.deps.killGroup?.(run.pgid); } catch { /* @silent-fallback-ok — already gone */ } delete run.pgid; this.persist(); }
    const v = this.resolve();
    const finish = (state: ApprovalRun['state'], outcome: string, result: ApprovalResult, extra: Partial<ApprovalRun> = {}) => {
      Object.assign(run, { state, outcome, result, finishedAt: this.now() }, extra);
      this.deps.audit({ pr: run.pr, headSha: run.headSha, deviceId: null, outcome: `reconciled:${outcome}` });
      this.persist();
    };
    if (!v.available || !v.repo || !v.profile) {
      finish('failed', 'interrupted', { status: 502, body: { error: 'approval-not-recorded', outcome: 'interrupted', detail: 'The agent restarted during your approval and cannot check GitHub here. Open it on GitHub to see.' } });
      return;
    }
    let after: ReviewRow[];
    try { after = await this.deps.readReviews(v.repo, run.pr); } catch {
      // @silent-fallback-ok — stays running; the next read tries again
      return;
    }
    await this.judge(run, after, new Set(run.baseline ?? []), v.profile.identity, 'interrupted', finish);
  }

  private prune(): void {
    const t = this.now();
    for (const r of this.byId.values()) {
      // An attempt never settled within its hour ends as failed, with an audit row: never dropped silently.
      if (r.state === 'running' && !this.active.has(r.id) && t - r.startedAt > RUN_KEEP_MS) {
        Object.assign(r, { state: 'failed', outcome: 'unsettled', finishedAt: t, result: { status: 502, body: { error: 'approval-not-recorded', outcome: 'unsettled', detail: 'I could not check how this approval ended. Open the pull request on GitHub to see.' } } });
        this.deps.audit({ pr: r.pr, headSha: r.headSha, deviceId: null, outcome: 'unsettled' });
      }
    }
    const old = (r: ApprovalRun) => r.finishedAt !== undefined && t - r.finishedAt > RUN_KEEP_MS;
    for (const [k, r] of this.runs) if (old(r)) this.runs.delete(k);
    for (const [k, r] of this.byId) if (old(r)) this.byId.delete(k);
  }
}

// ── production helpers ─────────────────────────────────────────────────────

/** A process's start time (empty when it is not running): a pid plus its start time names one process. */
export function startTimeOf(pid: number): string {
  try { return withSyncOp(() => execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 5_000 })).trim(); } catch { return ''; /* @silent-fallback-ok — not running */ }
}

/** A lock file the approval service takes per profile (hand-run use of the profile is caught by Chrome's own lock); a lock whose holder pid is gone is taken over. */
export function profileLock(): { lock: (userDataDir: string) => boolean; unlock: (userDataDir: string) => void } {
  const fileOf = (dir: string) => `${dir.replace(/\/+$/, '')}.approval.lock`;
  return {
    lock: (dir) => {
      const file = fileOf(dir);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      for (let i = 0; i < 2; i++) {
        try { fs.writeFileSync(file, `${process.pid} ${startTimeOf(process.pid)}`, { flag: 'wx' }); return true; } catch {
          // @silent-fallback-ok — held: check whether its holder is the same live process (pids are reused)
          let pid = 0, started = '';
          try { const [a, ...b] = fs.readFileSync(file, 'utf8').trim().split(' '); pid = Number(a) || 0; started = b.join(' '); } catch { /* @silent-fallback-ok — unreadable lock reads as stale */ }
          const alive = pid > 0 && startTimeOf(pid) !== '' && startTimeOf(pid) === started;
          if (alive) return false;
          try { SafeFsExecutor.safeUnlinkSync(file, { operation: 'src/core/GithubOwnerApproval.ts:profileLock' }); } catch { /* @silent-fallback-ok — another process took it over first */ }
        }
      }
      return false;
    },
    unlock: (dir) => {
      const file = fileOf(dir);
      try { if (fs.readFileSync(file, 'utf8').trim().split(' ')[0] === String(process.pid)) SafeFsExecutor.safeUnlinkSync(file, { operation: 'src/core/GithubOwnerApproval.ts:profileLock' }); } catch { /* @silent-fallback-ok — already gone */ }
    },
  };
}

/** Append one audit row (metadata only), rotating the file. */
export function auditWriter(file: string, now: () => number = Date.now): (row: Record<string, unknown>) => void {
  return (row) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      maybeRotateJsonl(file, { maxBytes: 2 * 1024 * 1024, keepRatio: 0.5 });
      fs.appendFileSync(file, JSON.stringify({ at: new Date(now()).toISOString(), ...row }) + '\n', { mode: 0o600 });
    } catch { /* @silent-fallback-ok — the audit never fails an approval; the run state still carries the outcome */ }
  };
}

/**
 * Run the approver script as its own process group, secrets on stdin. Resolves with its one-word
 * outcome; at the deadline the whole group (Chrome included) is killed and the outcome is `timeout`.
 */
export function scriptApprover(scriptPath: string, nodePath: string = process.execPath): GithubOwnerApprovalDeps['runApprover'] {
  return (input, deadlineMs, onSpawn) => new Promise((resolve) => {
    const child = spawn(nodePath, [scriptPath], { stdio: ['pipe', 'pipe', 'ignore'], detached: true, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' } });
    if (child.pid) onSpawn?.(child.pid);
    let out = '';
    let done = false;
    const end = (outcome: string, step?: number) => { if (done) return; done = true; clearTimeout(timer); resolve(step === undefined ? { outcome } : { outcome, step }); };
    const timer = setTimeout(() => {
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* @silent-fallback-ok — already exited */ }
      end('timeout');
    }, deadlineMs);
    child.stdout?.on('data', (d: Buffer) => { if (out.length < 4096) out += d.toString('utf8'); });
    child.on('error', () => end('error'));
    child.on('close', () => {
      let outcome = 'error';
      let step: number | undefined;
      try {
        const j = JSON.parse(out.trim().split('\n').pop() ?? '{}') as { outcome?: unknown; step?: unknown };
        if (typeof j.outcome === 'string' && /^[a-z-]{1,40}$/.test(j.outcome)) outcome = j.outcome;
        if (typeof j.step === 'number' && Number.isInteger(j.step) && j.step > 0) step = j.step;
      } catch { /* @silent-fallback-ok — unreadable output reads as error; GitHub decides anyway */ }
      end(outcome, step);
    });
    child.stdin?.end(JSON.stringify(input));
  });
}

// ── production wiring ───────────────────────────────────────────────────────

import { execFile, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { SecretStore } from './SecretStore.js';

/** The shipped approver script, next to this module in both the source and the built layout. */
export function approverScriptPath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'github-owner-approve.mjs');
}

function gh(args: string[], timeoutMs = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr: String(stderr ?? '') })) : resolve(String(stdout))));
  });
}

/** Concatenated `gh api --paginate` output: one or more JSON arrays back to back. */
export function parsePaginated<T>(text: string): T[] {
  const out: T[] = [];
  const t = text.trim();
  if (!t) return out;
  try { const j = JSON.parse(t); return Array.isArray(j) ? j as T[] : out; } catch { /* @silent-fallback-ok — several pages: split below */ }
  for (const part of t.replace(/\]\s*\[/g, ']\n\u0000[').split('\n\u0000')) {
    const j = JSON.parse(part);
    if (Array.isArray(j)) out.push(...(j as T[]));
  }
  return out;
}

export interface GithubOwnerApprovalWiring {
  stateDir: string;
  projectDir: string;
  config: () => { github?: { ownerApproval?: { enabled?: unknown; profileId?: unknown; playwrightCoreDir?: unknown } } };
  /** The merge watcher, read at call time (it is late-bound). */
  merger: () => { repo: string; isOwnPr: (pr: number) => Promise<boolean>; applyHold: (pr: number, reason: string) => Promise<{ ok: boolean }> } | null;
}

/** The service with its real dependencies: the vault, the profile registry, gh, the merge watcher. */
export function createGithubOwnerApproval(w: GithubOwnerApprovalWiring): GithubOwnerApproval {
  let store: SecretStore | null = null;
  const secrets = (): SecretStore => (store ??= new SecretStore({ stateDir: w.stateDir }));
  const lock = profileLock();
  const runsFile = path.join(w.stateDir, 'state', 'github-owner-approval-runs.json');
  return new GithubOwnerApproval({
    config: () => w.config().github?.ownerApproval,
    repo: () => w.merger()?.repo ?? null,
    profiles: () => {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(w.stateDir, 'state', 'playwright-profiles.json'), 'utf8')) as { profiles?: unknown };
        return Array.isArray(j.profiles) ? j.profiles as Array<{ id?: unknown; userDataDir?: unknown; accounts?: unknown }> : [];
      } catch { return []; /* @silent-fallback-ok — no registry reads as no profile: availability says why */ }
    },
    hasSecret: (name) => { const v = secrets().get(name); return typeof v === 'string' && v.length > 0; },
    readSecret: (name) => { const v = secrets().get(name); return typeof v === 'string' && v.length > 0 ? v : null; },
    codeowners: () => {
      for (const rel of ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']) {
        try { return fs.readFileSync(path.join(w.projectDir, rel), 'utf8'); } catch { /* @silent-fallback-ok — try GitHub's next location */ }
      }
      return null;
    },
    readCodeownersAt: async (repo, sha) => {
      for (const rel of ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']) {
        try { return await gh(['api', `repos/${repo}/contents/${rel}?ref=${sha}`, '-H', 'Accept: application/vnd.github.raw']); } catch (err) {
          // A missing file is a 404 (try the next location); anything else is a failed read.
          if (!/HTTP 404/.test(String((err as { stderr?: unknown }).stderr ?? ''))) throw err;
        }
      }
      return null;
    },
    playwrightLoads: (dir) => {
      try { return typeof (createRequire(path.join(dir, 'package.json'))(dir) as { chromium?: unknown }).chromium === 'object'; } catch { return false; /* @silent-fallback-ok — availability says the tool is not installed */ }
    },
    readPr: async (repo, pr) => {
      const j = JSON.parse(await gh(['api', `repos/${repo}/pulls/${pr}`])) as { state?: string; merged?: boolean; title?: string; head?: { sha?: string }; base?: { sha?: string } };
      return { state: String(j.state ?? ''), merged: j.merged === true, title: String(j.title ?? ''), headSha: String(j.head?.sha ?? ''), baseSha: String(j.base?.sha ?? '') };
    },
    readReviews: async (repo, pr) => parsePaginated<ReviewRow>(await gh(['api', '--paginate', `repos/${repo}/pulls/${pr}/reviews?per_page=100`])),
    readFiles: async (repo, pr) => parsePaginated<{ filename?: string }>(await gh(['api', '--paginate', `repos/${repo}/pulls/${pr}/files?per_page=100`])).map((f) => String(f.filename ?? '')).filter(Boolean),
    runApprover: scriptApprover(approverScriptPath()),
    killGroup: (pgid) => {
      // A pid can be reused: kill only when that process is still the approver script.
      let cmd = '';
      try { cmd = withSyncOp(() => execFileSync('ps', ['-o', 'command=', '-p', String(pgid)], { encoding: 'utf8', timeout: 5_000 })); } catch { return; /* @silent-fallback-ok — no such process: nothing to stop */ }
      if (!cmd.includes('github-owner-approve.mjs')) return;
      try { process.kill(-pgid, 'SIGKILL'); } catch { /* @silent-fallback-ok — the group is already gone */ }
    },
    isAgentPr: async (pr) => { const m = w.merger(); return m ? m.isOwnPr(pr) : false; },
    applyHold: async (pr, reason) => { const m = w.merger(); return m ? m.applyHold(pr, reason) : { ok: false }; },
    lock: lock.lock,
    unlock: lock.unlock,
    audit: auditWriter(path.join(w.stateDir, 'logs', 'github-owner-approvals.jsonl')),
    runsStore: {
      load: () => { try { const j = JSON.parse(fs.readFileSync(runsFile, 'utf8')); return Array.isArray(j) ? j as ApprovalRun[] : []; } catch { return []; /* @silent-fallback-ok — no store yet */ } },
      save: (runs) => { fs.mkdirSync(path.dirname(runsFile), { recursive: true }); const tmp = `${runsFile}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(runs), { mode: 0o600 }); fs.renameSync(tmp, runsFile); },
    },
  });
}
