/**
 * CiFailurePoller — Ingestion-sources spec §3.1.
 *
 * Periodically lists recent CI runs via `gh` and files the failed ones into the
 * FailureLedger. Read-only against GitHub; never mutates a repo. Fail-open: any
 * error (gh missing/unauthed/rate-limited/non-JSON) logs and skips the tick.
 *
 * Safety (spec §3.1/§4.1):
 *  - `gh` is invoked arg-array only (never a shell string); `repo` parsed from
 *    the git remote is validated against a strict owner/name regex before use.
 *  - Attribution is exact-OID (headSha → InitiativeTracker.findByMergeCommit),
 *    never a branch-name substring match. Unmapped → inferred / noFeatureLink.
 *  - Loop self-exclusion (§4.3): a run mapped to a `failure-learning-loop`-origin
 *    initiative is skipped (don't ingest the loop's own fix-PR failures).
 *  - Flaky guard (§3.1): per head SHA, only the LATEST run is considered; if a
 *    later run for that SHA succeeded, the failure is treated as recovered and
 *    skipped (not filed as a process failure).
 *  - Per-tick write cap (§5) bounds the ledger writes per poll.
 *  - Lease-gated (§5): runs only on the fenced-lease holder so a fleet polls
 *    GitHub once, not once per machine.
 *
 * filedBy is the constant `source:ci` (§5) so CI failures share one analyzer
 * "session" identity → they can never alone satisfy the diversity gate.
 */
import {
  createAuthenticatedGhSyncExec,
  type AuthenticatedGitHubCliRuntime,
} from '../core/githubRuntime.js';
import type { FailureLedger, FailureCategory } from './FailureLedger.js';
// scrubSecrets moved to a shared module (spec §3.3 — the Correction & Preference
// Learning Sentinel applies the SAME pass on both sides of its LLM hop). Still
// re-exported here so the poller's existing importers are unchanged.
import { scrubSecrets } from './scrubSecrets.js';
export { scrubSecrets } from './scrubSecrets.js';

/** What the poller needs to know about a mapped initiative (a subset of Initiative). */
export interface CiInitiativeRef {
  id: string;
  projectId?: string;
  specPath?: string;
  origin?: string;
}

export interface CiFailurePollerOptions {
  ledger: FailureLedger;
  /** Exact-OID reverse lookup (InitiativeTracker.findByMergeCommit). */
  resolveByMergeCommit: (oid: string) => CiInitiativeRef | undefined;
  /** Resolve the `owner/name` repo (validated by the poller). Return null if none. */
  resolveRepo: () => string | null;
  /** Per-agent state root containing the encrypted GitHub token vault. */
  stateDir?: string;
  /** Injectable gh runner (args array). Default: shared explicit-auth helper. */
  runGh?: (args: string[]) => string;
  /** Test seam: shared explicit GitHub runtime resolver. */
  githubRuntime?: () => AuthenticatedGitHubCliRuntime;
  /** Only poll when this returns true (fenced-lease holder). Default: always. */
  isLeaseHolder?: () => boolean;
  /** Poll interval (ms). Default 6h. */
  intervalMs?: number;
  /** Max failed runs filed per tick (spec §5). Default 50. */
  maxRunsPerTick?: number;
  /** gh run list --limit value (the query window). Default 50. */
  ghLimit?: number;
  onError?: (err: unknown) => void;
}

const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

interface GhRun {
  databaseId?: number;
  conclusion?: string;
  status?: string;
  headBranch?: string;
  headSha?: string;
  name?: string;
  createdAt?: string;
}

/** Deterministic CI job-name → FailureCategory (fixed allow-list, never raw name). */
export function ciCategoryFromName(name: string | undefined): FailureCategory {
  const n = (name || '').toLowerCase();
  if (/\b(test|spec|vitest|jest|e2e|unit|integration)\b/.test(n)) return 'test-failure';
  if (/\b(build|compile|tsc|lint|type.?check|bundle)\b/.test(n)) return 'build-failure';
  return 'unknown';
}

/**
 * Keep only genuine current failures: group runs by head SHA, take the LATEST
 * by createdAt per SHA, and return those whose latest conclusion is 'failure'.
 * A SHA whose latest run succeeded (a re-run recovery) is dropped (flaky guard).
 */
export function currentFailures(runs: GhRun[]): GhRun[] {
  const latestBySha = new Map<string, GhRun>();
  for (const r of runs) {
    const sha = r.headSha;
    if (!sha) continue;
    const prev = latestBySha.get(sha);
    if (!prev || String(r.createdAt || '') > String(prev.createdAt || '')) latestBySha.set(sha, r);
  }
  return [...latestBySha.values()].filter((r) => r.conclusion === 'failure');
}

export class CiFailurePoller {
  private readonly ledger: FailureLedger;
  private readonly resolveByMergeCommit: (oid: string) => CiInitiativeRef | undefined;
  private readonly resolveRepo: () => string | null;
  private readonly runGh: (args: string[]) => string;
  private readonly isLeaseHolder: () => boolean;
  private readonly intervalMs: number;
  private readonly maxRunsPerTick: number;
  private readonly ghLimit: number;
  private readonly onError: (err: unknown) => void;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(opts: CiFailurePollerOptions) {
    this.ledger = opts.ledger;
    this.resolveByMergeCommit = opts.resolveByMergeCommit;
    this.resolveRepo = opts.resolveRepo;
    this.runGh =
      opts.runGh ??
      createAuthenticatedGhSyncExec({
        stateDir: opts.stateDir,
        resolveRuntime: opts.githubRuntime,
      });
    this.isLeaseHolder = opts.isLeaseHolder ?? (() => true);
    this.intervalMs = opts.intervalMs && opts.intervalMs > 0 ? opts.intervalMs : 6 * 60 * 60 * 1000;
    this.maxRunsPerTick = opts.maxRunsPerTick && opts.maxRunsPerTick > 0 ? opts.maxRunsPerTick : 50;
    this.ghLimit = opts.ghLimit && opts.ghLimit > 0 ? opts.ghLimit : 50;
    this.onError = opts.onError ?? ((err) => console.warn('[ci-failure-poller]', err));
  }

  start(): void {
    if (this.timer) return;
    queueMicrotask(() => this.tick());
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One poll. Public for tests. Fail-open throughout. Returns # records filed. */
  tick(): number {
    if (this.running) return 0;
    this.running = true;
    let filed = 0;
    try {
      if (!this.isLeaseHolder()) return 0;
      const repo = this.resolveRepo();
      if (!repo || !REPO_RE.test(repo)) return 0; // no repo / untrusted remote → skip
      const raw = this.runGh([
        'run', 'list', '--repo', repo, '--limit', String(this.ghLimit),
        '--json', 'databaseId,conclusion,status,headBranch,headSha,name,createdAt',
      ]);
      const runs = JSON.parse(raw) as GhRun[];
      if (!Array.isArray(runs)) return 0;
      const failures = currentFailures(runs).slice(0, this.maxRunsPerTick);
      for (const run of failures) {
        try {
          const headSha = run.headSha as string;
          const mapped = this.resolveByMergeCommit(headSha);
          if (mapped && mapped.origin === 'failure-learning-loop') continue; // loop self-exclusion (§4.3)
          const category = ciCategoryFromName(run.name);
          const conclusion = String(run.conclusion);
          const jobName = String(run.name || 'CI');
          const rec = this.ledger.open({
            source: 'ci',
            severity: 'medium',
            category,
            summary: `CI ${jobName} ${conclusion}`,
            detail: {
              redacted: `${jobName}: ${conclusion}`,
              full: scrubSecrets(`run ${run.databaseId ?? '?'} on ${run.headBranch ?? '?'} (${headSha}) — ${conclusion}`),
            },
            causeCommitOid: headSha,
            initiativeId: mapped?.id,
            projectId: mapped?.projectId,
            specPath: mapped?.specPath,
            filedBy: 'source:ci',
            attribution: mapped ? 'automatic' : 'inferred',
            attributionConfidence: mapped ? 0.9 : 0.2,
          });
          if (rec) filed += 1;
        } catch (err) {
          this.onError(err); // per-run fail-open; keep going
        }
      }
    } catch (err) {
      this.onError(err); // whole-tick fail-open
    } finally {
      this.running = false;
    }
    return filed;
  }
}
