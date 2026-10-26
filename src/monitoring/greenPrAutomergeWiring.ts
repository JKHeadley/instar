/**
 * greenPrAutomergeWiring — builds the real gh / fs / lease / latch dependencies
 * for the GreenPrAutoMerger (green-pr-automerge-enforcement). Extracted from
 * server.ts so the dependency construction is itself unit-testable (Testing
 * Integrity: wiring-integrity tests prove deps are real, not nulls/no-ops).
 *
 * Repo-gated: the watcher only runs in the dev/maintainer environment where an
 * analyzable instar git repo AND scripts/safe-merge.mjs are present. On a plain
 * npm install both are absent → the server constructs nothing → routes 503.
 *
 * All gh goes through `execFile` (no shell). The list query is pinned oldest-first
 * server-side. Identity (R4) is `gh api user`. Audit is one JSONL line per
 * transition. State is per-machine (machine-local BY DESIGN).
 *
 * RULE 3.1 RATIONALE
 *   Criticality: high — these adapters surface the PR/identity/code-owner
 *                state the merge watcher acts on.
 *   Frequency:   per-tick (≤ once per ~10-minute interval).
 *   Stability:   stable — every read uses `gh ... --json`/`gh api --jq`
 *                STRUCTURED output, never regex over human gh text.
 *   Fallback:    a failing/unparseable list call THROWS (→ the watcher's
 *                tick-failed canary feeds the breaker); codeOwnedPaths failure →
 *                `unverifiable:true` (→ skip, never merge); identity unresolved →
 *                skip. Every path fails toward NOT merging.
 *   Verdict:     deterministic; safe-merge re-verifies at act time, so a misread
 *                here can only cause a refusal, never an unintended merge.
 */

import { extractRulesetReviewPolicy, parseCodeowners, codeOwnedFiles } from '../../scripts/local-verify-floor.mjs';
import { independentReviewProblem, isTracePath } from '../../scripts/lib/instar-dev-trace.mjs';
import fs from 'node:fs';
import path from 'node:path';

import {
  createAuthenticatedGhExec,
  createAuthenticatedGitHubCliRuntimeResolver,
  type AuthenticatedGitHubCliRuntime,
} from '../core/githubRuntime.js';
import { installedSafeMergePath } from '../core/installedSafeMerge.js';
import { DegradationReporter } from './DegradationReporter.js';
import { GuardLatchStore, type GuardLatchEntry } from './GuardLatchStore.js';
import { DefaultMergeRunner } from './MergeRunner.js';
import {
  type GreenPrAutoMergerDeps,
  type GreenPrState,
  type CodeOwnedPathsVerdict,
  type IndependentReviewVerdict,
  freshState,
} from './GreenPrAutoMerger.js';
import { latestRunPerCheck, failingChecksFromRollup, FAILING_CONCLUSIONS, NO_CHECKS_ROLLUP, agentOwnership, type PrSummary } from './greenPrLogic.js';

/**
 * The verifier's protected list (local-verify `protectedList`): a PR touching these
 * is recorded `protectedPath`, which the local floor admits only with an independent
 * second-pass review (spec local-verify-merge-authority.md). The watcher itself no
 * longer routes these to the operator (directive 2026-10-22); only CODEOWNERS-owned
 * files wait for the operator, through GitHub's code-owner review.
 */
export const PROTECTED_PATH_PREFIXES = [
  '.github/',
  'scripts/safe-merge.mjs',
  'src/monitoring/GreenPrAutoMerger.ts',
  'src/monitoring/MergeRunner.ts',
  'src/monitoring/GuardLatchStore.ts',
  'src/monitoring/greenPrLogic.ts',
  'scripts/latest-run-per-check.mjs',
  'src/core/installedSafeMerge.ts',
  'src/monitoring/floorDriftCanary.ts',
  'src/monitoring/greenPrAutomergeWiring.ts',
  // audit-convergence-enforcement §3: an audit-report PR gets a human eye instead
  // of auto-merging (the ADV-3 shape≠depth mitigation), AND the validator's own
  // enforcing machinery is protected from being neutered by an auto-merged PR
  // (adversarial-R4 finding-2 — same precedent as protecting safe-merge above).
  // (This is the ARM-TIME protection — the common case: a PR opened WITH the audit
  // report is routed to the operator. The adversarial arm-then-push TOCTOU hardening
  // — the gather() re-check + re-adoption — ships as a tracked follow-up: ACT-1192.)
  'docs/audits/',
  'scripts/write-audit-convergence.mjs',
  'scripts/audit-secret-patterns.mjs',
  'tests/unit/audit-convergence-reports.test.ts',
];
/** Gate scripts the floor contexts execute (extend, never shrink). */
export const PROTECTED_GATE_SCRIPTS = [
  'scripts/safe-merge.mjs',
];

/**
 * The `--json` fields `gh pr view` / `gh pr list` accept (gh 2.97.0, `gh pr view
 * --json` with no field list prints this set). A field outside it makes gh print
 * `Unknown JSON field: "<name>"` and exit 1 — which `refetchPr` used to read as
 * "the PR vanished", so EVERY pull request audited `skipped:vanished` and the
 * watcher armed nothing (2026-10-24, PR #2334 sat green and unmerged: the list
 * carried `mergeCommitOid`; the real field is `mergeCommit`, an object with
 * `.oid`). The unit test pins every projection in this file to this set, so a
 * field drift fails a test instead of silently nulling every PR.
 */
export const GH_PR_JSON_FIELDS: readonly string[] = [
  'additions', 'assignees', 'author', 'autoMergeRequest', 'baseRefName', 'baseRefOid', 'body',
  'changedFiles', 'closed', 'closedAt', 'closingIssuesReferences', 'comments', 'commits', 'createdAt',
  'deletions', 'files', 'fullDatabaseId', 'headRefName', 'headRefOid', 'headRepository',
  'headRepositoryOwner', 'id', 'isCrossRepository', 'isDraft', 'labels', 'latestReviews',
  'maintainerCanModify', 'mergeCommit', 'mergeStateStatus', 'mergeable', 'mergedAt', 'mergedBy',
  'milestone', 'number', 'potentialMergeCommit', 'projectCards', 'projectItems', 'reactionGroups',
  'reviewDecision', 'reviewRequests', 'reviews', 'state', 'statusCheckRollup', 'title', 'updatedAt', 'url',
];

/** The `refetchPr` projection (act-time pre-arm gate + armed-episode reconciliation read). */
export const REFETCH_PR_JSON_FIELDS: readonly string[] = [
  'title', 'labels', 'isDraft', 'headRefOid', 'state', 'mergeCommit', 'autoMergeRequest',
];

/** The `listOpenPrs` projection. */
export const LIST_PR_JSON_FIELDS: readonly string[] = [
  'number', 'title', 'labels', 'isDraft', 'headRefName', 'headRefOid', 'baseRefName', 'mergeable',
  'statusCheckRollup', 'autoMergeRequest', 'reviewDecision', 'createdAt',
  // merge-line-author-eligibility: ownership by author on a same-repo head.
  'author', 'isCrossRepository',
];

const UNKNOWN_JSON_FIELD_RE = /Unknown JSON field:\s*"([^"]+)"/i;
const reportedUnknownJsonFields = new Set<string>();

/**
 * A non-zero `gh ... --json` exit whose stderr names an unknown field is a FIELD
 * DRIFT (our projection vs the installed gh), never a fact about the PR. Surface
 * it loudly — once per field per process — through the degradation reporter and
 * the wiring logger; the caller still fails toward NOT merging (returns null).
 */
export function reportUnknownGhJsonField(
  stderr: string,
  seam: string,
  logger?: (msg: string) => void,
  report: (event: Parameters<DegradationReporter['report']>[0]) => void = (e) => DegradationReporter.getInstance().report(e),
): string | null {
  const field = UNKNOWN_JSON_FIELD_RE.exec(stderr ?? '')?.[1] ?? null;
  if (!field) return null;
  const msg = `[green-pr-automerge] gh rejected the --json field "${field}" in ${seam}; every PR reads as vanished until the projection is fixed (gh: ${stderr.trim().split('\n')[0]})`;
  if (reportedUnknownJsonFields.has(field)) return field;
  reportedUnknownJsonFields.add(field);
  try { logger?.(msg); } catch { /* @silent-fallback-ok: a logger failure must not hide the degradation report below */ }
  try {
    report({
      feature: `GreenPrAutoMerger.${seam}.unknownJsonField`,
      primary: `gh ${seam} read with the projection this build ships`,
      fallback: 'the read returns null — the watcher audits skipped:vanished and arms/merges nothing',
      reason: `Why: the installed gh does not know the --json field "${field}" (field drift between the wiring and gh).`,
      impact: 'Green PRs are never armed or merged until the projection matches the installed gh.',
    });
  } catch { /* @silent-fallback-ok: the reporter may be unconfigured in tests; the logger line above already carried the field */ }
  return field;
}

/**
 * The two paths the watcher is built from (ACT-150):
 *  - `repoPath` — the instar source checkout its git reads need (the server's
 *    working directory);
 *  - `safeMergePath` — the INSTALLED safe-merge that ships with the running
 *    server, never the checkout's copy. The checkout can sit on any branch with
 *    uncommitted edits (2026-10-22: an old branch, 279 uncommitted changes and a
 *    pre-local-verify safe-merge, which the watcher then spawned). Spec:
 *    local-verify-merge-authority.md §2.
 */
export function resolveGreenPrPaths(cwd: string, installed: () => string = installedSafeMergePath): { repoPath: string; safeMergePath: string } {
  return { repoPath: cwd, safeMergePath: installed() };
}

/**
 * The watcher runs only in an instar source checkout (its git reads need one;
 * `scripts/safe-merge.mjs` in the checkout is what marks it as instar) AND only
 * when the safe-merge it will run (the installed copy) exists. The checkout's
 * own safe-merge is a marker here, never the script that runs.
 */
export function isAnalyzableGreenPrRepo(repoPath: string, safeMergePath: string): boolean {
  try {
    return fs.existsSync(path.join(repoPath, '.git'))
      && fs.existsSync(path.join(repoPath, 'scripts', 'safe-merge.mjs'))
      && fs.existsSync(safeMergePath);
  } catch { /* @silent-fallback-ok: green-pr-automerge fail-safe — skip/refuse, never over-merge; safe-merge is the act-time authority */
    return false;
  }
}

/** Does any changed file touch a protected path (the verifier's protectedPath flag)? */
export function diffTouchesProtected(files: string[]): boolean {
  return files.some((f) => PROTECTED_PATH_PREFIXES.some((p) => f === p || f.startsWith(p)));
}

export interface GreenPrWiringOpts {
  repoPath: string;
  safeMergePath: string;
  stateDir: string;
  machineId: string;
  repo: string;
  agentNamespace: string;
  /** merge-line-author-eligibility: the agent's GitHub login (ownership by author for holds). */
  expectedGhLogin?: string;
  mergeTimeoutMs: number;
  mergeKillGraceMs: number;
  /**
   * mergerunner-auto-arm-handoff. The two runner-path fields threaded into
   * MergeRunnerConfig: `mergeStrategy` ('auto' default | 'admin') selects
   * --auto vs --admin; `armTimeoutMs` is the --auto spawn deadline (60s).
   */
  mergeStrategy?: 'auto' | 'admin';
  armTimeoutMs?: number;
  /** Lease accessors (single-machine: () => true / () => 0). */
  holdsLease: () => boolean;
  leaseEpoch: () => number;
  /** Merged peer guard-latch view (single-machine: () => []). */
  readPeerLatches?: () => GuardLatchEntry[];
  /** Replication writer (optional). */
  journal?: { emitGuardLatch: (d: Record<string, unknown>) => void };
  /** Attention sink — raise/refresh the ONE aggregated item. */
  postAttentionAggregate: (lines: string[]) => Promise<void>;
  auditPath: string;
  now?: () => number;
  logger?: (msg: string) => void;
  /** Test seam: override the gh exec. */
  ghExec?: (args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>;
  /** Test seam: where a gh `--json` field drift is reported (default: DegradationReporter). */
  reportDegradation?: (event: Parameters<DegradationReporter['report']>[0]) => void;
  /** Test seam: explicit GitHub runtime shared by reads and safe-merge. */
  githubRuntime?: () => AuthenticatedGitHubCliRuntime;
}

/** Resolve the watcher-owned branch prefix without conflating it with identity. */
export function resolveGreenPrAgentNamespace(
  configured: unknown,
  projectName: unknown,
): string {
  if (typeof configured === 'string' && configured.trim()) return configured.trim();
  if (typeof projectName === 'string' && projectName.trim()) return projectName.trim();
  return 'agent';
}

/** Build the GuardLatchStore for this install. */
export function buildGuardLatchStore(opts: GreenPrWiringOpts): GuardLatchStore {
  return new GuardLatchStore({
    stateDir: opts.stateDir,
    machineId: opts.machineId,
    journal: opts.journal as never,
    leaseEpoch: opts.leaseEpoch,
    readPeerEntries: opts.readPeerLatches,
    now: opts.now ? () => new Date(opts.now!()) : undefined,
    logger: opts.logger,
  });
}

/** Build the full GreenPrAutoMerger deps (real gh adapters). */
export function buildGreenPrDeps(opts: GreenPrWiringOpts, latches: GuardLatchStore): GreenPrAutoMergerDeps {
  const githubRuntime = opts.githubRuntime
    ?? createAuthenticatedGitHubCliRuntimeResolver({ stateDir: opts.stateDir });
  const exec = opts.ghExec ?? createAuthenticatedGhExec({
    stateDir: opts.stateDir,
    resolveRuntime: githubRuntime,
  });
  const now = opts.now ?? (() => Date.now());

  const runner = new DefaultMergeRunner(
    {
      stateDir: opts.stateDir,
      repo: opts.repo,
      safeMergePath: opts.safeMergePath,
      mergeTimeoutMs: opts.mergeTimeoutMs,
      mergeKillGraceMs: opts.mergeKillGraceMs,
      expectedContractVersion: 2,
      resolveGitHubEnv: () => {
        try {
          return githubRuntime().env;
        } catch { /* @silent-fallback-ok: missing explicit GitHub identity makes the autonomous act path refuse */
          return null;
        }
      },
      // mergerunner-auto-arm-handoff M2: the runner selects --auto vs --admin and
      // the auto-path deadline from these (config → GreenPrAutoMergerConfig →
      // buildGreenPrDeps → MergeRunnerConfig). Defaults keep the arm path.
      mergeStrategy: opts.mergeStrategy ?? 'auto',
      armTimeoutMs: opts.armTimeoutMs ?? 60_000,
    },
    {
      confirmMerged: async (pr, repo) => {
        const r = await exec(['pr', 'view', String(pr), '--repo', repo, '--json', 'state,mergedAt']);
        if (r.code !== 0) return false;
        try { const j = JSON.parse(r.stdout); return j.state === 'MERGED' || !!j.mergedAt; } catch { /* @silent-fallback-ok: green-pr-automerge fail-safe — skip/refuse, never over-merge; safe-merge is the act-time authority */ return false; }
      },
      prState: async (pr, repo) => {
        const r = await exec(['pr', 'view', String(pr), '--repo', repo, '--json', 'state']);
        if (r.code !== 0) return 'UNKNOWN';
        try { return String(JSON.parse(r.stdout).state ?? 'UNKNOWN'); } catch { /* @silent-fallback-ok: green-pr-automerge fail-safe — skip/refuse, never over-merge; safe-merge is the act-time authority */ return 'UNKNOWN'; }
      },
      logger: opts.logger,
    },
  );

  const audit = (event: Record<string, unknown>): void => {
    try {
      const dir = path.dirname(opts.auditPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(opts.auditPath, JSON.stringify({ ts: new Date(now()).toISOString(), ...event }) + '\n', { mode: 0o600 });
    } catch { /* @silent-fallback-ok: green-pr-automerge fail-safe — skip/refuse, never over-merge; safe-merge is the act-time authority */ /* audit failure is non-fatal */ }
  };

  const statePath = path.join(opts.stateDir, 'state', 'green-pr-automerge.json');
  const loadState = (): GreenPrState => {
    try {
      const raw = fs.readFileSync(statePath, 'utf-8');
      const obj = JSON.parse(raw) as GreenPrState;
      return { ...freshState(), ...obj };
    } catch { /* @silent-fallback-ok: green-pr-automerge fail-safe — skip/refuse, never over-merge; safe-merge is the act-time authority */ return freshState(); }
  };
  const saveState = (state: GreenPrState): void => {
    try {
      const dir = path.dirname(statePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = statePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
      fs.renameSync(tmp, statePath);
    } catch { /* @silent-fallback-ok: green-pr-automerge fail-safe — skip/refuse, never over-merge; safe-merge is the act-time authority */ /* best-effort */ }
  };

  return {
    holdsLease: opts.holdsLease,
    leaseEpoch: opts.leaseEpoch,
    rulesetReviewPolicy: async () => {
      // The same ruleset read safe-merge's review precheck uses (a non-admin can read it).
      const r = await exec(['api', `repos/${opts.repo}/rules/branches/main`]);
      if (r.code !== 0) throw new Error(`ruleset read failed: ${r.stderr.slice(0, 200)}`);
      return extractRulesetReviewPolicy(JSON.parse(r.stdout));
    },
    listOpenPrs: async () => {
      const r = await exec([
        'pr', 'list', '--author', '@me', '--state', 'open', '--base', 'main',
        // Widened (mergerunner-auto-arm-handoff Blocker 4 — the cheap-pass): one
        // extra field on the single oldest-first list call already made each tick
        // lets gather() skip an already-armed PR FREE, regardless of local state.
        '--limit', '100', '--json', LIST_PR_JSON_FIELDS.join(','),
        '--search', 'sort:created-asc',
      ]);
      if (r.code !== 0) throw new Error(`gh pr list failed: ${r.stderr.slice(0, 200)}`);
      const rows = JSON.parse(r.stdout) as Array<Record<string, unknown>>;
      return rows.map(mapPr);
    },
    codeOwnedPaths: async (pr: PrSummary): Promise<CodeOwnedPathsVerdict> => {
      // CODEOWNERS is read at runtime from the PR's base branch on GitHub (the copy GitHub
      // enforces), never the local checkout, which can sit on any branch.
      const unverifiable: CodeOwnedPathsVerdict = { touches: false, files: [], unverifiable: true };
      const base = pr.baseRefName || 'main';
      const co = await exec(['api', `repos/${opts.repo}/contents/.github/CODEOWNERS?ref=${encodeURIComponent(base)}`, '-H', 'Accept: application/vnd.github.raw']);
      let rules: ReturnType<typeof parseCodeowners> = null;
      if (co.code === 0) rules = parseCodeowners(co.stdout);
      else if (/HTTP 404/.test(co.stderr)) rules = []; // no CODEOWNERS on the base: nothing is code-owned
      if (!rules) return unverifiable;
      // Enumerate changed files to exhaustion via the API (paginated).
      const r = await exec(['api', `repos/${opts.repo}/pulls/${pr.number}/files`, '--paginate', '--jq', '.[].filename']);
      if (r.code !== 0) return unverifiable;
      const changed = r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
      const files = codeOwnedFiles(changed, rules);
      return { touches: files.length > 0, files, protectedFiles: changed.filter((f) => diffTouchesProtected([f])), unverifiable: false };
    },
    independentReviewAtHead: async (pr: PrSummary, flaggedPaths: string[]): Promise<IndependentReviewVerdict> => {
      // The changed files that are trace files (added or modified), read AT THE HEAD, so a
      // trace pushed after this head never counts for it. Same judge as the verifier.
      const r = await exec(['api', `repos/${opts.repo}/pulls/${pr.number}/files`, '--paginate', '--jq', '.[] | select(.status != "removed") | .filename']);
      if (r.code !== 0) return { ok: false, unverifiable: true, problem: 'files-unreadable' };
      const raw = async (p: string): Promise<string | null> => {
        const x = await exec(['api', `repos/${opts.repo}/contents/${p}?ref=${pr.headRefOid}`, '-H', 'Accept: application/vnd.github.raw']);
        return x.code === 0 ? x.stdout : null;
      };
      const problems: string[] = [];
      for (const f of r.stdout.split('\n').map((s) => s.trim()).filter(isTracePath)) {
        let trace: unknown = null;
        try { trace = JSON.parse((await raw(f)) ?? ''); } catch { /* @silent-fallback-ok: an unparseable trace counts as no review (the judge names it trace-unparseable) */ trace = null; }
        const art = trace && typeof trace === 'object' ? (trace as { artifactPath?: unknown }).artifactPath : undefined;
        const artifactText = typeof art === 'string' && art ? await raw(art) : null;
        let problem = independentReviewProblem({ trace, flaggedPaths, artifactText });
        if (problem === null) {
          // Bound to the head, as the verifier does: no flagged path may change after
          // the trace's last commit (compare <traceLast>...<head> lists what changed since).
          const last = await exec(['api', `repos/${opts.repo}/commits?sha=${pr.headRefOid}&path=${encodeURIComponent(f)}&per_page=1`, '--jq', '.[0].sha']);
          const traceLast = last.code === 0 ? last.stdout.trim() : '';
          if (!/^[0-9a-f]{40}$/.test(traceLast)) return { ok: false, unverifiable: true, problem: 'trace-commit-unreadable' };
          const cmp = await exec(['api', `repos/${opts.repo}/compare/${traceLast}...${pr.headRefOid}`, '--paginate', '--jq', '.files[]?.filename']);
          if (cmp.code !== 0) return { ok: false, unverifiable: true, problem: 'review-binding-unreadable' };
          const since = new Set(cmp.stdout.split('\n').map((x) => x.trim()).filter(Boolean));
          // GitHub's compare lists at most 300 files; a list that long may hide a flagged path.
          if (since.size >= 300) return { ok: false, unverifiable: true, problem: 'review-binding-truncated' };
          const stale = flaggedPaths.filter((x) => since.has(x));
          problem = stale.length ? `flagged-changed-after-trace:${stale.slice(0, 3).join(',')}` : null;
        }
        if (problem === null) return { ok: true, unverifiable: false };
        problems.push(`${f}: ${problem}`);
      }
      return { ok: false, unverifiable: false, problem: problems[0] ?? 'no-trace-in-pr' };
    },
    refetchPr: async (pr: number) => {
      // Widened (mergerunner-auto-arm-handoff Blocker 4): also returns
      // mergeCommitOid (informational for the merged-at-unexpected-head audit)
      // and autoMergeRequest (present ⇔ armed; expectedHeadOid = the PR's final
      // head GitHub will merge — the head-pin comparison operand). Used by the
      // act-time pre-arm gate AND the armed-episode reconciliation read.
      // gh's field is `mergeCommit` ({ oid }); the returned shape keeps `mergeCommitOid`
      // so consumers are unchanged. The field list is pinned to GH_PR_JSON_FIELDS.
      const r = await exec(['pr', 'view', String(pr), '--repo', opts.repo, '--json', REFETCH_PR_JSON_FIELDS.join(',')]);
      if (r.code !== 0) {
        // An unknown-field exit is OUR drift, not a vanished PR — say so loudly
        // (once per field) before failing toward not-merging.
        reportUnknownGhJsonField(r.stderr, 'refetchPr', opts.logger, opts.reportDegradation);
        return null;
      }
      try {
        const j = JSON.parse(r.stdout);
        const amr = j.autoMergeRequest && typeof j.autoMergeRequest === 'object'
          ? { enabledAt: j.autoMergeRequest.enabledAt ?? null, expectedHeadOid: j.autoMergeRequest.expectedHeadOid ?? null }
          : null;
        const mergeOid = j.mergeCommit && typeof j.mergeCommit === 'object' ? j.mergeCommit.oid : null;
        return {
          title: String(j.title ?? ''),
          labels: Array.isArray(j.labels) ? j.labels.map((l: { name?: string }) => l.name ?? '') : [],
          isDraft: !!j.isDraft,
          headRefOid: String(j.headRefOid ?? ''),
          state: String(j.state ?? 'UNKNOWN'),
          mergeCommitOid: mergeOid != null ? String(mergeOid) : null,
          autoMergeRequest: amr,
        };
      } catch { /* @silent-fallback-ok: green-pr-automerge fail-safe — skip/refuse, never over-merge; safe-merge is the act-time authority */ return null; }
    },
    disarmArmedEpisodes: async (pr: number) => {
      // gh pr merge <pr> --disable-auto. Confirmed-disabled ⇔ the command
      // succeeds AND an independent re-read shows autoMergeRequest absent.
      const r = await exec(['pr', 'merge', String(pr), '--repo', opts.repo, '--disable-auto']);
      if (r.code !== 0) {
        // An "already disabled / not armed" stderr is a confirmed not-armed state.
        if (/not.*auto.?merge|auto.?merge.*not|no auto-?merge/i.test(r.stderr)) return true;
        return false;
      }
      try {
        const v = await exec(['pr', 'view', String(pr), '--repo', opts.repo, '--json', 'autoMergeRequest']);
        if (v.code !== 0) return false;
        const j = JSON.parse(v.stdout);
        return !j.autoMergeRequest;
      } catch { /* @silent-fallback-ok: green-pr-automerge fail-safe — could not confirm disable → honest FAILED, never claim success */ return false; }
    },
    resolveGhLogin: async () => {
      const r = await exec(['api', 'user', '--jq', '.login']);
      if (r.code !== 0) return null;
      const login = r.stdout.trim();
      return login || null;
    },
    holdEligible: async (pr: number) => {
      const r = await exec(['pr', 'view', String(pr), '--repo', opts.repo, '--json', 'state,headRefName,author,isCrossRepository']);
      if (r.code !== 0) return { ok: false, status: 404, detail: 'PR not found' };
      try {
        const j = JSON.parse(r.stdout);
        if (j.state !== 'OPEN') return { ok: false, status: 409, detail: `PR is ${j.state}` };
        // merge-line-author-eligibility: a hold covers every PR the watcher can merge
        // (namespace OR same-repo author), using the SAME ownership read.
        const own = agentOwnership({
          headRefName: String(j.headRefName ?? ''),
          ...(typeof j.author?.login === 'string' ? { authorLogin: j.author.login } : {}),
          ...(typeof j.isCrossRepository === 'boolean' ? { isCrossRepository: j.isCrossRepository } : {}),
        }, opts.agentNamespace, opts.expectedGhLogin);
        if (!own.owned) return { ok: false, status: 403, detail: `PR is not this agent's own (${own.reason})` };
        return { ok: true };
      } catch { /* @silent-fallback-ok: green-pr-automerge fail-safe — skip/refuse, never over-merge; safe-merge is the act-time authority */ return { ok: false, status: 502, detail: 'unparseable gh response' }; }
    },
    applyHoldMarker: async (pr: number, reason: string) => {
      // Read the current title, prefix [HOLD: …] (idempotent if already held).
      const view = await exec(['pr', 'view', String(pr), '--repo', opts.repo, '--json', 'title']);
      if (view.code !== 0) return false;
      let title = '';
      try { title = String(JSON.parse(view.stdout).title ?? ''); } catch { /* @silent-fallback-ok: green-pr-automerge fail-safe — skip/refuse, never over-merge; safe-merge is the act-time authority */ return false; }
      if (title.trim().toLowerCase().startsWith('[hold')) return true; // already held
      const safeReason = reason.replace(/[\]\n\r]/g, ' ').slice(0, 80);
      const newTitle = `[HOLD: ${safeReason || 'held'}] ${title}`.slice(0, 256);
      const edit = await exec(['pr', 'edit', String(pr), '--repo', opts.repo, '--title', newTitle]);
      return edit.code === 0;
    },
    runner,
    latches,
    postAttentionAggregate: opts.postAttentionAggregate,
    audit,
    loadState,
    saveState,
    now,
  };
}

export function mapPr(row: Record<string, unknown>): PrSummary {
  const labels = Array.isArray(row.labels) ? (row.labels as Array<{ name?: string }>).map((l) => l.name ?? '') : [];
  const rollup = row.statusCheckRollup;
  return {
    number: Number(row.number),
    title: String(row.title ?? ''),
    labels,
    isDraft: !!row.isDraft,
    headRefName: String(row.headRefName ?? ''),
    headRefOid: String(row.headRefOid ?? ''),
    // local-verify: the base branch the record key needs (absent → no record matches).
    ...(typeof row.baseRefName === 'string' && row.baseRefName ? { baseRefName: row.baseRefName } : {}),
    // local-verify: the review precheck + the "ready" time for verify ordering.
    ...(typeof row.reviewDecision === 'string' ? { reviewDecision: row.reviewDecision } : {}),
    ...(typeof row.createdAt === 'string' && row.createdAt ? { createdAt: row.createdAt } : {}),
    mergeable: String(row.mergeable ?? 'UNKNOWN'),
    statusRollup: deriveRollup(rollup),
    // mergerunner-auto-arm-handoff Blocker 4: GitHub-side armed state, derived
    // from the autoMergeRequest field of the widened pr-list projection.
    autoMergeArmed: !!row.autoMergeRequest,
    // red-pr-watchdog: the latest-run-per-check FAILING checks (no new gh call —
    // derived from the same rollup the list projection already fetched).
    failingChecks: failingChecksFromRollup(rollup),
    // merge-line-author-eligibility: absent fields stay absent (only the namespace rule admits then).
    ...(row.author && typeof (row.author as { login?: unknown }).login === 'string'
      ? { authorLogin: (row.author as { login: string }).login } : {}),
    ...(typeof row.isCrossRepository === 'boolean' ? { isCrossRepository: row.isCrossRepository } : {}),
  };
}

/**
 * Derive a single SUCCESS|PENDING|FAILURE|NO_CHECKS from the statusCheckRollup array.
 *
 * red-pr-watchdog correctness fix: dedup to the LATEST run per check name BEFORE
 * collapsing. Previously a stale FAILED run superseded by a passing rerun still
 * short-circuited to 'FAILURE' (the 2026-07-08 bug). latestRunPerCheck keeps only
 * the newest run of each check, so a green rerun correctly reads SUCCESS.
 */
export function deriveRollup(rollup: unknown): string | null {
  if (!Array.isArray(rollup)) return typeof rollup === 'string' ? rollup : null;
  let sawPending = false;
  // A head where no GitHub Actions workflow produced a check (nothing at all,
  // or only commit statuses such as Vercel) has had NO checks run. It must not
  // read SUCCESS: "no checks" and "all checks green" look alike at a glance
  // (PR #2302, 2026-10-22: pull_request never fired, only Vercel reported).
  const sawWorkflowCheck = (rollup as Array<Record<string, unknown>>).some(
    (r) => !!r && typeof r === 'object' && typeof r.workflowName === 'string' && r.workflowName.trim() !== '');
  for (const c of latestRunPerCheck(rollup)) {
    // A check whose latest run has not COMPLETED (an in-progress rerun) is pending.
    if (c.status && c.status !== 'COMPLETED') { sawPending = true; continue; }
    if (FAILING_CONCLUSIONS.has(c.conclusion)) return 'FAILURE';
    if (c.conclusion === 'PENDING' || c.conclusion === 'EXPECTED' || c.conclusion === 'IN_PROGRESS' || c.conclusion === 'QUEUED') sawPending = true;
  }
  if (sawPending) return 'PENDING';
  return sawWorkflowCheck ? 'SUCCESS' : NO_CHECKS_ROLLUP;
}
