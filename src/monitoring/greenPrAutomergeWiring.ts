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
 *   Criticality: high — these adapters surface the PR/identity/protected-paths
 *                state the merge watcher acts on.
 *   Frequency:   per-tick (≤ once per ~10-minute interval).
 *   Stability:   stable — every read uses `gh ... --json`/`gh api --jq`
 *                STRUCTURED output, never regex over human gh text.
 *   Fallback:    a failing/unparseable list call THROWS (→ the watcher's
 *                tick-failed canary feeds the breaker); protectedPaths failure →
 *                `unverifiable:true` (→ skip, never merge); identity unresolved →
 *                skip. Every path fails toward NOT merging.
 *   Verdict:     deterministic; safe-merge re-verifies at act time, so a misread
 *                here can only cause a refusal, never an unintended merge.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

import { GuardLatchStore, type GuardLatchEntry } from './GuardLatchStore.js';
import { DefaultMergeRunner } from './MergeRunner.js';
import {
  type GreenPrAutoMergerDeps,
  type GreenPrState,
  type ProtectedPathsVerdict,
  freshState,
} from './GreenPrAutoMerger.js';
import { latestRunPerCheck, failingChecksFromRollup, FAILING_CONCLUSIONS, type PrSummary } from './greenPrLogic.js';

/** Protected globs (round-4/6): a PR touching these never auto-merges. */
export const PROTECTED_PATH_PREFIXES = [
  '.github/',
  'scripts/safe-merge.mjs',
  'src/monitoring/GreenPrAutoMerger.ts',
  'src/monitoring/MergeRunner.ts',
  'src/monitoring/GuardLatchStore.ts',
  'src/monitoring/greenPrLogic.ts',
  'src/monitoring/floorDriftCanary.ts',
  'src/monitoring/greenPrAutomergeWiring.ts',
];
/** Gate scripts the floor contexts execute (extend, never shrink). */
export const PROTECTED_GATE_SCRIPTS = [
  'scripts/safe-merge.mjs',
];

export function isAnalyzableGreenPrRepo(repoPath: string, safeMergePath: string): boolean {
  try {
    return fs.existsSync(path.join(repoPath, '.git')) && fs.existsSync(safeMergePath);
  } catch { /* @silent-fallback-ok: green-pr-automerge fail-safe — skip/refuse, never over-merge; safe-merge is the act-time authority */
    return false;
  }
}

/** Does any changed file touch a protected path? */
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
}

function gh(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile('gh', args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code: err ? (err as NodeJS.ErrnoException & { code?: number }).code ?? 1 : 0 });
    });
  });
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
  const exec = opts.ghExec ?? gh;
  const now = opts.now ?? (() => Date.now());

  const runner = new DefaultMergeRunner(
    {
      stateDir: opts.stateDir,
      repo: opts.repo,
      safeMergePath: opts.safeMergePath,
      mergeTimeoutMs: opts.mergeTimeoutMs,
      mergeKillGraceMs: opts.mergeKillGraceMs,
      expectedContractVersion: 2,
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
    listOpenPrs: async () => {
      const r = await exec([
        'pr', 'list', '--author', '@me', '--state', 'open', '--base', 'main',
        // Widened (mergerunner-auto-arm-handoff Blocker 4 — the cheap-pass): one
        // extra field on the single oldest-first list call already made each tick
        // lets gather() skip an already-armed PR FREE, regardless of local state.
        '--limit', '100', '--json', 'number,title,labels,isDraft,headRefName,headRefOid,mergeable,statusCheckRollup,autoMergeRequest',
        '--search', 'sort:created-asc',
      ]);
      if (r.code !== 0) throw new Error(`gh pr list failed: ${r.stderr.slice(0, 200)}`);
      const rows = JSON.parse(r.stdout) as Array<Record<string, unknown>>;
      return rows.map(mapPr);
    },
    protectedPaths: async (pr: PrSummary): Promise<ProtectedPathsVerdict> => {
      // Enumerate changed files to exhaustion via the API (paginated).
      const r = await exec(['api', `repos/${opts.repo}/pulls/${pr.number}/files`, '--paginate', '--jq', '.[].filename']);
      if (r.code !== 0) return { touches: false, unverifiable: true };
      const files = r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
      return { touches: diffTouchesProtected(files), unverifiable: false };
    },
    refetchPr: async (pr: number) => {
      // Widened (mergerunner-auto-arm-handoff Blocker 4): also returns
      // mergeCommitOid (informational for the merged-at-unexpected-head audit)
      // and autoMergeRequest (present ⇔ armed; expectedHeadOid = the PR's final
      // head GitHub will merge — the head-pin comparison operand). Used by the
      // act-time pre-arm gate AND the armed-episode reconciliation read.
      const r = await exec(['pr', 'view', String(pr), '--repo', opts.repo, '--json', 'title,labels,isDraft,headRefOid,state,mergeCommitOid,autoMergeRequest']);
      if (r.code !== 0) return null;
      try {
        const j = JSON.parse(r.stdout);
        const amr = j.autoMergeRequest && typeof j.autoMergeRequest === 'object'
          ? { enabledAt: j.autoMergeRequest.enabledAt ?? null, expectedHeadOid: j.autoMergeRequest.expectedHeadOid ?? null }
          : null;
        return {
          title: String(j.title ?? ''),
          labels: Array.isArray(j.labels) ? j.labels.map((l: { name?: string }) => l.name ?? '') : [],
          isDraft: !!j.isDraft,
          headRefOid: String(j.headRefOid ?? ''),
          state: String(j.state ?? 'UNKNOWN'),
          mergeCommitOid: j.mergeCommitOid != null ? String(j.mergeCommitOid) : null,
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
      const r = await exec(['pr', 'view', String(pr), '--repo', opts.repo, '--json', 'state,headRefName']);
      if (r.code !== 0) return { ok: false, status: 404, detail: 'PR not found' };
      try {
        const j = JSON.parse(r.stdout);
        if (j.state !== 'OPEN') return { ok: false, status: 409, detail: `PR is ${j.state}` };
        const ns = opts.agentNamespace.endsWith('/') ? opts.agentNamespace : `${opts.agentNamespace}/`;
        if (!String(j.headRefName ?? '').startsWith(ns)) return { ok: false, status: 403, detail: 'PR is not in this agent\'s namespace' };
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

function mapPr(row: Record<string, unknown>): PrSummary {
  const labels = Array.isArray(row.labels) ? (row.labels as Array<{ name?: string }>).map((l) => l.name ?? '') : [];
  const rollup = row.statusCheckRollup;
  return {
    number: Number(row.number),
    title: String(row.title ?? ''),
    labels,
    isDraft: !!row.isDraft,
    headRefName: String(row.headRefName ?? ''),
    headRefOid: String(row.headRefOid ?? ''),
    mergeable: String(row.mergeable ?? 'UNKNOWN'),
    statusRollup: deriveRollup(rollup),
    // mergerunner-auto-arm-handoff Blocker 4: GitHub-side armed state, derived
    // from the autoMergeRequest field of the widened pr-list projection.
    autoMergeArmed: !!row.autoMergeRequest,
    // red-pr-watchdog: the latest-run-per-check FAILING checks (no new gh call —
    // derived from the same rollup the list projection already fetched).
    failingChecks: failingChecksFromRollup(rollup),
  };
}

/**
 * Derive a single SUCCESS|PENDING|FAILURE from the statusCheckRollup array.
 *
 * red-pr-watchdog correctness fix: dedup to the LATEST run per check name BEFORE
 * collapsing. Previously a stale FAILED run superseded by a passing rerun still
 * short-circuited to 'FAILURE' (the 2026-07-08 bug). latestRunPerCheck keeps only
 * the newest run of each check, so a green rerun correctly reads SUCCESS.
 */
export function deriveRollup(rollup: unknown): string | null {
  if (!Array.isArray(rollup)) return typeof rollup === 'string' ? rollup : null;
  let sawPending = false;
  for (const c of latestRunPerCheck(rollup)) {
    // A check whose latest run has not COMPLETED (an in-progress rerun) is pending.
    if (c.status && c.status !== 'COMPLETED') { sawPending = true; continue; }
    if (FAILING_CONCLUSIONS.has(c.conclusion)) return 'FAILURE';
    if (c.conclusion === 'PENDING' || c.conclusion === 'EXPECTED' || c.conclusion === 'IN_PROGRESS' || c.conclusion === 'QUEUED') sawPending = true;
  }
  return sawPending ? 'PENDING' : 'SUCCESS';
}
