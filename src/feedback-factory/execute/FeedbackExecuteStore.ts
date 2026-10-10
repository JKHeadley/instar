/**
 * The `execution` table (docs/specs/feedback-triage-and-execution.md §2, §4 step 2).
 *
 * One row per executor attempt, in the drain's own feedback-drain.db, written only under the
 * triage store's owner-epoch fence (a stale epoch is refused). A claim is a CAS insert: it fails
 * when the item already has a live attempt, and the attempt number is the next one for the item.
 */
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import { DrainConflictError, type FeedbackDrainStore } from '../drain/FeedbackDrainStore.js';
import type { FeedbackTriageStore } from '../triage/FeedbackTriageStore.js';
import { attemptBranch, attemptId } from './executePolicy.js';

export type ExecutionState =
  | 'claimed' | 'running' | 'verifying'
  | 'pr-open' | 'spec-pr-open' | 'merge-armed' | 'merged'
  | 'failed' | 'not-reproducible' | 'held' | 'stopped' | 'would-start';

/** States that occupy an execution slot or an open-PR slot. */
export const LIVE_STATES: ReadonlySet<ExecutionState> = new Set(['claimed', 'running', 'verifying']);
export const OPEN_PR_STATES: ReadonlySet<ExecutionState> = new Set(['pr-open', 'spec-pr-open', 'merge-armed']);
const TERMINAL_STATES: ReadonlySet<ExecutionState> = new Set(['merged', 'failed', 'not-reproducible', 'held', 'stopped', 'would-start']);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS execution (
  attempt_id TEXT PRIMARY KEY, initiative_id TEXT NOT NULL, cluster_id TEXT NOT NULL, attempt INTEGER NOT NULL,
  state TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', owner_epoch INTEGER NOT NULL, lease_expires_at INTEGER,
  needs_spec INTEGER NOT NULL DEFAULT 0, user_facing INTEGER NOT NULL DEFAULT 0,
  session_name TEXT, session_machine TEXT, base_sha TEXT, workspace TEXT, publish_clone TEXT, tmp_dir TEXT,
  outcome TEXT, notes_len INTEGER, transcript_ref TEXT, branch TEXT NOT NULL, pr_number INTEGER, head_sha TEXT,
  approver TEXT, approved_sha TEXT, approved_at INTEGER, merge_deadline_at INTEGER, merge_retry_at INTEGER,
  merge_retries INTEGER NOT NULL DEFAULT 0, merged_at TEXT, merge_commit TEXT, merged_elsewhere INTEGER NOT NULL DEFAULT 0,
  disarm_failed INTEGER NOT NULL DEFAULT 0, secret_files_json TEXT, codeowners_json TEXT, held_changeset_ref TEXT,
  notified_at INTEGER, release_tag TEXT, released_at INTEGER, verify_state TEXT, verify_session TEXT,
  spec_converge_session TEXT, spec_converge_state TEXT, graded_approval INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(initiative_id, attempt)
);
CREATE INDEX IF NOT EXISTS idx_execution_state ON execution(state);
CREATE INDEX IF NOT EXISTS idx_execution_initiative ON execution(initiative_id, attempt);
CREATE TABLE IF NOT EXISTS execution_daily (utc_day TEXT PRIMARY KEY, starts INTEGER NOT NULL DEFAULT 0);
`;

export interface ExecutionRow {
  attemptId: string;
  initiativeId: string;
  clusterId: string;
  attempt: number;
  state: ExecutionState;
  reason: string;
  ownerEpoch: number;
  leaseExpiresAt: number | null;
  needsSpec: boolean;
  userFacing: boolean;
  sessionName: string | null;
  sessionMachine: string | null;
  baseSha: string | null;
  workspace: string | null;
  publishClone: string | null;
  tmpDir: string | null;
  outcome: string | null;
  transcriptRef: string | null;
  branch: string;
  prNumber: number | null;
  headSha: string | null;
  approver: string | null;
  approvedSha: string | null;
  approvedAt: number | null;
  mergeDeadlineAt: number | null;
  mergeRetryAt: number | null;
  mergeRetries: number;
  mergedAt: string | null;
  mergeCommit: string | null;
  mergedElsewhere: boolean;
  disarmFailed: boolean;
  secretFiles: string[];
  codeownersOutside: string[];
  heldChangesetRef: string | null;
  notifiedAt: number | null;
  releaseTag: string | null;
  releasedAt: number | null;
  verifyState: string | null;
  verifySession: string | null;
  specConvergeSession: string | null;
  specConvergeState: string | null;
  gradedApproval: boolean;
  createdAt: number;
  updatedAt: number;
}

export type ExecutionPatch = Partial<Omit<ExecutionRow, 'attemptId' | 'initiativeId' | 'clusterId' | 'attempt' | 'createdAt' | 'updatedAt' | 'ownerEpoch'>>;

const COLUMN: Record<keyof ExecutionPatch, string> = {
  state: 'state', reason: 'reason', leaseExpiresAt: 'lease_expires_at', needsSpec: 'needs_spec', userFacing: 'user_facing',
  sessionName: 'session_name', sessionMachine: 'session_machine', baseSha: 'base_sha', workspace: 'workspace', publishClone: 'publish_clone',
  tmpDir: 'tmp_dir', outcome: 'outcome', transcriptRef: 'transcript_ref', branch: 'branch', prNumber: 'pr_number', headSha: 'head_sha',
  approver: 'approver', approvedSha: 'approved_sha', approvedAt: 'approved_at', mergeDeadlineAt: 'merge_deadline_at', mergeRetryAt: 'merge_retry_at',
  mergeRetries: 'merge_retries', mergedAt: 'merged_at', mergeCommit: 'merge_commit', mergedElsewhere: 'merged_elsewhere', disarmFailed: 'disarm_failed',
  secretFiles: 'secret_files_json', codeownersOutside: 'codeowners_json', heldChangesetRef: 'held_changeset_ref', notifiedAt: 'notified_at',
  releaseTag: 'release_tag', releasedAt: 'released_at', verifyState: 'verify_state', verifySession: 'verify_session',
  specConvergeSession: 'spec_converge_session', specConvergeState: 'spec_converge_state', gradedApproval: 'graded_approval',
};

export class FeedbackExecuteStore {
  private readonly db: BetterSqliteDatabase;
  private readonly now: () => number;

  constructor(drain: FeedbackDrainStore, private readonly triage: FeedbackTriageStore, opts: { clock?: () => number } = {}) {
    this.db = drain.sharedDatabase();
    this.now = opts.clock ?? Date.now;
    this.db.exec(SCHEMA);
  }

  /** Run `fn` in one immediate transaction under the triage owner fence (stale epoch → DrainConflictError). */
  fenced<T>(ownerEpoch: number, fn: () => T): T { return this.triage.fenced(ownerEpoch, fn); }

  get(attemptIdValue: string): ExecutionRow | null {
    const row = this.db.prepare('SELECT * FROM execution WHERE attempt_id=?').get(attemptIdValue) as Record<string, unknown> | undefined;
    return row ? fromRow(row) : null;
  }

  latestFor(initiativeId: string): ExecutionRow | null {
    const row = this.db.prepare('SELECT * FROM execution WHERE initiative_id=? ORDER BY attempt DESC LIMIT 1').get(initiativeId) as Record<string, unknown> | undefined;
    return row ? fromRow(row) : null;
  }

  attemptsFor(initiativeId: string): ExecutionRow[] {
    return (this.db.prepare('SELECT * FROM execution WHERE initiative_id=? ORDER BY attempt').all(initiativeId) as Record<string, unknown>[]).map(fromRow);
  }

  inStates(...states: ExecutionState[]): ExecutionRow[] {
    const marks = states.map(() => '?').join(',');
    return (this.db.prepare(`SELECT * FROM execution WHERE state IN (${marks}) ORDER BY created_at, attempt_id`).all(...states) as Record<string, unknown>[]).map(fromRow);
  }

  all(): ExecutionRow[] {
    return (this.db.prepare('SELECT * FROM execution ORDER BY created_at, attempt_id').all() as Record<string, unknown>[]).map(fromRow);
  }

  liveCount(): number {
    return (this.db.prepare(`SELECT COUNT(*) n FROM execution WHERE state IN ('claimed','running','verifying')`).get() as { n: number }).n;
  }

  openPrCount(): number {
    return (this.db.prepare(`SELECT COUNT(*) n FROM execution WHERE state IN ('pr-open','spec-pr-open','merge-armed')`).get() as { n: number }).n;
  }

  startsToday(now = this.now()): number {
    const row = this.db.prepare('SELECT starts FROM execution_daily WHERE utc_day=?').get(new Date(now).toISOString().slice(0, 10)) as { starts: number } | undefined;
    return Number(row?.starts ?? 0);
  }

  /**
   * CAS claim (§4 step 2): refused under a stale epoch, when the item already has a live or
   * open-PR attempt, or when the daily start cap is reached. Returns the new row or null.
   */
  claim(ownerEpoch: number, input: { initiativeId: string; clusterId: string; needsSpec: boolean; userFacing: boolean; leaseMs: number; maxStartsPerDay: number; state?: ExecutionState }): ExecutionRow | null {
    return this.fenced(ownerEpoch, () => {
      const now = this.now();
      const busy = this.db.prepare(`SELECT 1 FROM execution WHERE initiative_id=? AND state IN ('claimed','running','verifying','pr-open','spec-pr-open','merge-armed')`).get(input.initiativeId);
      if (busy) return null;
      const day = new Date(now).toISOString().slice(0, 10);
      const dryRun = input.state === 'would-start';
      if (!dryRun && this.startsToday(now) >= input.maxStartsPerDay) return null;
      const last = this.db.prepare('SELECT MAX(attempt) n FROM execution WHERE initiative_id=?').get(input.initiativeId) as { n: number | null };
      const attempt = Number(last.n ?? 0) + 1;
      const id = attemptId(input.initiativeId, attempt);
      this.db.prepare(`INSERT INTO execution(attempt_id,initiative_id,cluster_id,attempt,state,owner_epoch,lease_expires_at,needs_spec,user_facing,branch,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, input.initiativeId, input.clusterId, attempt, input.state ?? 'claimed', ownerEpoch,
        dryRun ? null : now + input.leaseMs, input.needsSpec ? 1 : 0, input.userFacing ? 1 : 0, attemptBranch(input.initiativeId, attempt), now, now);
      if (!dryRun) this.db.prepare('INSERT INTO execution_daily(utc_day,starts) VALUES (?,1) ON CONFLICT(utc_day) DO UPDATE SET starts=starts+1').run(day);
      return this.get(id);
    });
  }

  /** Fenced patch of one attempt. A patch to a terminal row only updates bookkeeping fields, never its state. */
  patch(ownerEpoch: number, attemptIdValue: string, patch: ExecutionPatch): ExecutionRow {
    return this.fenced(ownerEpoch, () => {
      const current = this.get(attemptIdValue);
      if (!current) throw new DrainConflictError('execution row missing');
      const entries = Object.entries(patch).filter(([key]) => key in COLUMN) as Array<[keyof ExecutionPatch, unknown]>;
      if (entries.length === 0) return current;
      const sets: string[] = [];
      const values: unknown[] = [];
      for (const [key, value] of entries) {
        sets.push(`${COLUMN[key]}=?`);
        values.push(serialize(key, value));
      }
      sets.push('updated_at=?');
      values.push(this.now());
      this.db.prepare(`UPDATE execution SET ${sets.join(', ')} WHERE attempt_id=?`).run(...values, attemptIdValue);
      return this.get(attemptIdValue)!;
    });
  }

  /**
   * The current owner adopts an attempt claimed under an older epoch (same machine re-acquired the
   * lease with the session still alive, or a PR it re-gated): the row is re-stamped with the current
   * epoch so the stale-epoch stop path does not fire on it again every tick.
   */
  adopt(ownerEpoch: number, attemptIdValue: string): ExecutionRow {
    return this.fenced(ownerEpoch, () => {
      this.db.prepare('UPDATE execution SET owner_epoch=?, updated_at=? WHERE attempt_id=?').run(ownerEpoch, this.now(), attemptIdValue);
      return this.get(attemptIdValue)!;
    });
  }

  /** Attempt episodes that ended `failed` / `not-reproducible` for the item (the loop terminator counts these). */
  failureEpisodes(initiativeId: string): { failed: number; notReproducible: number } {
    const rows = this.attemptsFor(initiativeId);
    return { failed: rows.filter((r) => r.state === 'failed').length, notReproducible: rows.filter((r) => r.state === 'not-reproducible').length };
  }

  isTerminal(state: ExecutionState): boolean { return TERMINAL_STATES.has(state); }
}

function serialize(key: keyof ExecutionPatch, value: unknown): unknown {
  if (key === 'secretFiles' || key === 'codeownersOutside') return JSON.stringify(Array.isArray(value) ? value.slice(0, 50) : []);
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') return value.slice(0, 2_000);
  return value ?? null;
}

function fromRow(row: Record<string, unknown>): ExecutionRow {
  const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
  const list = (v: unknown): string[] => { try { const p = JSON.parse(String(v ?? '[]')); return Array.isArray(p) ? p.map(String) : []; } catch { return []; } };
  return {
    attemptId: String(row.attempt_id), initiativeId: String(row.initiative_id), clusterId: String(row.cluster_id), attempt: Number(row.attempt),
    state: row.state as ExecutionState, reason: String(row.reason ?? ''), ownerEpoch: Number(row.owner_epoch), leaseExpiresAt: num(row.lease_expires_at),
    needsSpec: Number(row.needs_spec) === 1, userFacing: Number(row.user_facing) === 1, sessionName: str(row.session_name), sessionMachine: str(row.session_machine),
    baseSha: str(row.base_sha), workspace: str(row.workspace), publishClone: str(row.publish_clone), tmpDir: str(row.tmp_dir), outcome: str(row.outcome),
    transcriptRef: str(row.transcript_ref), branch: String(row.branch), prNumber: num(row.pr_number), headSha: str(row.head_sha), approver: str(row.approver),
    approvedSha: str(row.approved_sha), approvedAt: num(row.approved_at), mergeDeadlineAt: num(row.merge_deadline_at), mergeRetryAt: num(row.merge_retry_at),
    mergeRetries: Number(row.merge_retries ?? 0), mergedAt: str(row.merged_at), mergeCommit: str(row.merge_commit), mergedElsewhere: Number(row.merged_elsewhere) === 1,
    disarmFailed: Number(row.disarm_failed) === 1, secretFiles: list(row.secret_files_json), codeownersOutside: list(row.codeowners_json),
    heldChangesetRef: str(row.held_changeset_ref), notifiedAt: num(row.notified_at), releaseTag: str(row.release_tag), releasedAt: num(row.released_at),
    verifyState: str(row.verify_state), verifySession: str(row.verify_session), specConvergeSession: str(row.spec_converge_session),
    specConvergeState: str(row.spec_converge_state), gradedApproval: Number(row.graded_approval) === 1,
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}
