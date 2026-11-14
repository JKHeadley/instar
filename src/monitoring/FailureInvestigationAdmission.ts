/** Durable attempt budget for scheduled failure investigation. No timer re-arms it. */
import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { scrubSecrets } from './scrubSecrets.js';

export const FAILURE_INVESTIGATION_MAX_ATTEMPTS = 3;
export const FAILURE_INVESTIGATION_RETRY_DELAYS_MS = [30 * 60_000, 60 * 60_000] as const;

/** Production brake reused by the registered sustained-pressure model. */
export function decideFailureInvestigationAttempt(attempts: number, nextAt: number | null, now: number):
  | { admitted: false; reason: 'paused' | 'not-due' }
  | { admitted: true; attempts: number; nextAt: number | null } {
  if (!Number.isFinite(now)) throw new Error('finite investigation admission timestamp required');
  if (!Number.isSafeInteger(attempts) || attempts < 0 || attempts >= FAILURE_INVESTIGATION_MAX_ATTEMPTS) return { admitted: false, reason: 'paused' };
  if (nextAt !== null && now < nextAt) return { admitted: false, reason: 'not-due' };
  const nextAttempts = attempts + 1;
  const delay = FAILURE_INVESTIGATION_RETRY_DELAYS_MS[nextAttempts - 1];
  return { admitted: true, attempts: nextAttempts, nextAt: delay === undefined ? null : now + delay };
}

export interface FailureInvestigationAdmission {
  occurrenceCount: number;
  attempts: number;
  maxAttempts: typeof FAILURE_INVESTIGATION_MAX_ATTEMPTS;
  nextAttemptAt: string | null;
  paused: boolean;
  resumeEvidenceRef?: string;
}
export type FailureInvestigationClaim =
  | { admitted: true; token: string; admission: FailureInvestigationAdmission }
  | { admitted: false; reason: 'not-found' | 'not-failure' | 'verified' | 'paused' | 'not-due'; admission?: FailureInvestigationAdmission };

/** Broad reads expose scheduling state, never claim tokens or evidence refs. */
export function failureInvestigationAdmissionSummary(value: unknown): Omit<FailureInvestigationAdmission, 'resumeEvidenceRef'> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  const { occurrenceCount, attempts, maxAttempts, nextAttemptAt, paused } = v;
  if (typeof occurrenceCount !== 'number' || !Number.isSafeInteger(occurrenceCount) || occurrenceCount < 1
    || typeof attempts !== 'number' || !Number.isSafeInteger(attempts) || attempts < 0 || attempts > FAILURE_INVESTIGATION_MAX_ATTEMPTS
    || maxAttempts !== FAILURE_INVESTIGATION_MAX_ATTEMPTS || typeof paused !== 'boolean'
    || paused !== (attempts >= FAILURE_INVESTIGATION_MAX_ATTEMPTS)) return undefined;
  if (nextAttemptAt !== null && (typeof nextAttemptAt !== 'string' || !Number.isFinite(Date.parse(nextAttemptAt))
    || new Date(nextAttemptAt).toISOString() !== nextAttemptAt)) return undefined;
  return { occurrenceCount, attempts, maxAttempts: FAILURE_INVESTIGATION_MAX_ATTEMPTS, nextAttemptAt, paused };
}

export function initFailureInvestigationAdmission(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS correction_failure_investigation_admission (
    correction_id TEXT NOT NULL,
    occurrence_count INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER,
    claim_token TEXT,
    resume_evidence_ref TEXT,
    PRIMARY KEY (correction_id, occurrence_count)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS correction_failure_investigation_resume_refs (
    correction_id TEXT NOT NULL,
    occurrence_count INTEGER NOT NULL,
    evidence_ref TEXT NOT NULL,
    PRIMARY KEY (correction_id, occurrence_count, evidence_ref)
  )`);
}

/** Does not read CorrectionRecord, avoiding recursion in row conversion. */
export function readFailureInvestigationAdmission(db: Database, id: string): FailureInvestigationAdmission | undefined {
  const row = db.prepare(`SELECT c.occurrence_count, a.attempts, a.next_attempt_at, a.resume_evidence_ref
    FROM correction_records c LEFT JOIN correction_failure_investigation_admission a
    ON a.correction_id=c.id AND a.occurrence_count=c.occurrence_count
    WHERE c.id=? AND c.failure_case_json IS NOT NULL`).get(id) as {
      occurrence_count: number; attempts: number | null; next_attempt_at: number | null; resume_evidence_ref: string | null;
    } | undefined;
  if (!row) return undefined;
  const attempts = row.attempts ?? 0;
  return { occurrenceCount: row.occurrence_count, attempts, maxAttempts: FAILURE_INVESTIGATION_MAX_ATTEMPTS,
    nextAttemptAt: row.next_attempt_at == null ? null : new Date(row.next_attempt_at).toISOString(), paused: attempts >= FAILURE_INVESTIGATION_MAX_ATTEMPTS,
    ...(row.resume_evidence_ref ? { resumeEvidenceRef: row.resume_evidence_ref } : {}) };
}

/** Caller holds the ledger transaction, including its snapshot and replication hook. */
export function claimFailureInvestigationAdmission(db: Database, id: string, now: number): FailureInvestigationClaim {
  if (!Number.isFinite(now)) throw new Error('finite investigation admission timestamp required');
  const record = db.prepare('SELECT failure_case_json FROM correction_records WHERE id=?').get(id) as { failure_case_json: string | null } | undefined;
  if (!record) return { admitted: false, reason: 'not-found' };
  if (!record.failure_case_json) return { admitted: false, reason: 'not-failure' };
  if (JSON.parse(record.failure_case_json).state === 'verified') return { admitted: false, reason: 'verified' };
  const current = readFailureInvestigationAdmission(db, id)!;
  const decision = decideFailureInvestigationAttempt(current.attempts, current.nextAttemptAt ? Date.parse(current.nextAttemptAt) : null, now);
  if (!decision.admitted) return { admitted: false, reason: decision.reason, admission: current };
  const token = randomUUID();
  db.prepare(`INSERT INTO correction_failure_investigation_admission (correction_id,occurrence_count,attempts,next_attempt_at,claim_token)
    VALUES (?,?,?,?,?) ON CONFLICT(correction_id,occurrence_count) DO UPDATE SET
    attempts=excluded.attempts,next_attempt_at=excluded.next_attempt_at,claim_token=excluded.claim_token`)
    .run(id, current.occurrenceCount, decision.attempts, decision.nextAt, token);
  db.prepare('UPDATE correction_records SET version=version+1 WHERE id=?').run(id);
  return { admitted: true, token, admission: readFailureInvestigationAdmission(db, id)! };
}

/** An explicit new evidence event, never a cron/progress-update side effect. */
export function resumeFailureInvestigationAdmission(db: Database, id: string, evidenceRef: string): FailureInvestigationAdmission {
  const reference = typeof evidenceRef === 'string' ? scrubSecrets(evidenceRef).trim() : '';
  if (!reference || reference.length > 4000) throw new Error('bounded resume evidence reference required');
  const current = readFailureInvestigationAdmission(db, id);
  if (!current) throw new Error('failure case not found');
  const row = db.prepare('SELECT failure_case_json FROM correction_records WHERE id=?').get(id) as { failure_case_json: string };
  const failure = JSON.parse(row.failure_case_json);
  const refs = [...(failure.context?.sourceRefs ?? []), ...(failure.investigation?.fixRefs ?? [])];
  if (!refs.includes(reference)) throw new Error('resume evidence must already be recorded in context.sourceRefs or investigation.fixRefs');
  const used = db.prepare(`SELECT 1 FROM correction_failure_investigation_resume_refs WHERE correction_id=? AND occurrence_count=? AND evidence_ref=?`)
    .get(id, current.occurrenceCount, reference);
  if (used || current.resumeEvidenceRef === reference) throw new Error('new evidence reference required to resume investigation');
  db.prepare('INSERT INTO correction_failure_investigation_resume_refs (correction_id,occurrence_count,evidence_ref) VALUES (?,?,?)')
    .run(id, current.occurrenceCount, reference);
  db.prepare(`INSERT INTO correction_failure_investigation_admission (correction_id,occurrence_count,attempts,next_attempt_at,resume_evidence_ref)
    VALUES (?,?,0,NULL,?) ON CONFLICT(correction_id,occurrence_count) DO UPDATE SET
    attempts=0,next_attempt_at=NULL,claim_token=NULL,resume_evidence_ref=excluded.resume_evidence_ref`)
    .run(id, current.occurrenceCount, reference);
  db.prepare('UPDATE correction_records SET version=version+1 WHERE id=?').run(id);
  return readFailureInvestigationAdmission(db, id)!;
}
