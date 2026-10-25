import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { FeedbackDrainStore } from '../../../src/feedback-factory/drain/FeedbackDrainStore.js';
import { FeedbackTriageStore } from '../../../src/feedback-factory/triage/FeedbackTriageStore.js';
import { FeedbackExecuteStore } from '../../../src/feedback-factory/execute/FeedbackExecuteStore.js';

const KEY = 'k'.repeat(32);
const REVIEW_COLUMNS = ['review_sha', 'review_verdict', 'review_reason', 'reviewed_at'];

/** The `execution` table as it shipped before the independent-review columns existed. */
const OLD_EXECUTION_TABLE = `
CREATE TABLE execution (
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
);`;

function columns(db: InstanceType<typeof Database>): string[] {
  return (db.prepare('PRAGMA table_info(execution)').all() as Array<{ name: string }>).map((c) => c.name);
}

describe('FeedbackExecuteStore schema migration', () => {
  it('a database from before the independent review gains the four review columns in place, and an old row reads as never reviewed', () => {
    const db = new Database(':memory:');
    const drain = new FeedbackDrainStore({ dbPath: ':memory:', db, tokenHmacKey: KEY, clock: () => 1 });
    const triage = new FeedbackTriageStore(drain, { hmacKey: KEY, clock: () => 1 });
    db.exec(OLD_EXECUTION_TABLE);
    db.prepare(`INSERT INTO execution (attempt_id, initiative_id, cluster_id, attempt, state, owner_epoch, branch, created_at, updated_at) VALUES ('i1:a1','i1','c1',1,'pr-open',1,'feedback/i1-a1',1,1)`).run();
    for (const c of REVIEW_COLUMNS) expect(columns(db)).not.toContain(c);
    const store = new FeedbackExecuteStore(drain, triage, { clock: () => 2 });
    for (const c of REVIEW_COLUMNS) expect(columns(db)).toContain(c);
    expect(store.get('i1:a1')).toMatchObject({ attemptId: 'i1:a1', state: 'pr-open', reviewSha: null, reviewVerdict: null, reviewReason: null, reviewedAt: null });
    // Idempotent: a second construction neither fails nor duplicates columns.
    new FeedbackExecuteStore(drain, triage, { clock: () => 3 });
    expect(columns(db).filter((c) => REVIEW_COLUMNS.includes(c))).toHaveLength(4);
  });

  it('a fresh database carries the columns from the schema itself', () => {
    const db = new Database(':memory:');
    const drain = new FeedbackDrainStore({ dbPath: ':memory:', db, tokenHmacKey: KEY, clock: () => 1 });
    const triage = new FeedbackTriageStore(drain, { hmacKey: KEY, clock: () => 1 });
    new FeedbackExecuteStore(drain, triage, { clock: () => 2 });
    for (const c of REVIEW_COLUMNS) expect(columns(db)).toContain(c);
  });
});
