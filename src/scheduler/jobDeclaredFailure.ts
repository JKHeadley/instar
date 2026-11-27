/**
 * jobDeclaredFailure — lets a prompt job record its own run as failed.
 *
 * Without this, `JobScheduler.notifyJobComplete` recorded `failure` only for a
 * failed/killed session: a job that found its pipeline broken and said so
 * still ended as `success` (the feedback-factory-process job did exactly that
 * for weeks). The job writes a reason to `$INSTAR_JOB_FAILURE_FILE`; the
 * scheduler reads it once when the run ends.
 *
 * The file is named by the run's tmux session (unique per job run), so a
 * reason can only ever attach to the run that wrote it. A file, not a pane
 * marker: the prompt is echoed onto the pane, so a marker the body names would
 * trigger itself (the 2026-08-20 sentinel incident in SessionManager).
 *
 * Spec: docs/specs/feedback-inbox-vault-token.md §B.
 */
import fs from 'node:fs';
import path from 'node:path';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
import { scrubSecrets } from '../monitoring/scrubSecrets.js';

export const JOB_FAILURE_FILE_ENV = 'INSTAR_JOB_FAILURE_FILE';
const MAX_REASON_CHARS = 500;

export function jobDeclaredFailureDir(stateDir: string): string {
  return path.join(stateDir, 'state', 'job-declared-failures');
}

export function jobDeclaredFailurePath(stateDir: string, tmuxSession: string): string {
  return path.join(jobDeclaredFailureDir(stateDir), `${tmuxSession.replace(/[^A-Za-z0-9._-]/g, '_')}.txt`);
}

/** Collapse to one line, redact token shapes, cap the length. */
export function sanitizeDeclaredFailureReason(raw: string): string {
  const oneLine = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  const scrubbed = scrubSecrets(oneLine).replace(/\bBearer\s+[^\s"']+/gi, 'Bearer REDACTED');
  return scrubbed.slice(0, MAX_REASON_CHARS) || '(no reason given)';
}

/**
 * Read and remove this run's declared-failure file. Returns the sanitized
 * reason, or null when the job declared nothing. Never throws.
 */
export function readJobDeclaredFailure(stateDir: string, tmuxSession: string): string | null {
  const file = jobDeclaredFailurePath(stateDir, tmuxSession);
  if (!fs.existsSync(file)) return null;
  let reason: string;
  try {
    reason = sanitizeDeclaredFailureReason(fs.readFileSync(file, 'utf8'));
  } catch {
    // @silent-fallback-ok — the file exists, so the job declared a failure;
    // an unreadable reason still records the run as failed (the safe direction).
    reason = '(unreadable)';
  }
  try {
    SafeFsExecutor.safeUnlinkSync(file, { operation: 'src/scheduler/jobDeclaredFailure.ts:readJobDeclaredFailure' });
  } catch {
    // @silent-fallback-ok — a leftover file is harmless: the name is unique to
    // this finished run, so no later run can ever read it.
  }
  return reason;
}

/**
 * The sibling of a declared failure: a run that could not do its work for a reason
 * outside the job (its own server too busy to answer) writes a reason to
 * `$INSTAR_JOB_SKIP_FILE` and is recorded `skipped` — neither a success nor a
 * failure. A declared failure wins when a run wrote both.
 */
export const JOB_SKIP_FILE_ENV = 'INSTAR_JOB_SKIP_FILE';

export function jobDeclaredSkipPath(stateDir: string, tmuxSession: string): string {
  return path.join(jobDeclaredFailureDir(stateDir), `${tmuxSession.replace(/[^A-Za-z0-9._-]/g, '_')}.skip.txt`);
}

/** Read and remove this run's declared-skip file. Null when the job declared none. Never throws. */
export function readJobDeclaredSkip(stateDir: string, tmuxSession: string): string | null {
  const file = jobDeclaredSkipPath(stateDir, tmuxSession);
  if (!fs.existsSync(file)) return null;
  let reason: string;
  try {
    reason = sanitizeDeclaredFailureReason(fs.readFileSync(file, 'utf8'));
  } catch {
    // @silent-fallback-ok — the file exists, so the job declared a skip.
    reason = '(unreadable)';
  }
  try {
    SafeFsExecutor.safeUnlinkSync(file, { operation: 'src/scheduler/jobDeclaredFailure.ts:readJobDeclaredSkip' });
  } catch {
    // @silent-fallback-ok — the name is unique to this finished run.
  }
  return reason;
}

/** Job Scheduler awareness bullet (CLAUDE.md template + migration). */
export const JOB_DECLARED_FAILURE_AWARENESS =
  '- **A job marks its own run failed by writing a reason to `$INSTAR_JOB_FAILURE_FILE`** — ' +
  '`[ -n "$INSTAR_JOB_FAILURE_FILE" ] && printf \'%s\' "<reason>" > "$INSTAR_JOB_FAILURE_FILE"`, then finish normally. ' +
  'The scheduler reads it when the run ends and records `failure` with that reason (run history, failure count, ' +
  'the consecutive-failure alert). Saying "failed" in the output records nothing; a job that finds its pipeline ' +
  'broken must write the file. The path is unique to the run.\n';
