/**
 * reopen.ts — TS port of the auto-reopen-on-regression decision.
 *
 * Ports the decision embedded in cmd_apply_clusters (the-portal/.claude/scripts/
 * feedback-processor.py, the regression branch ~:1543) out of the DB-write code
 * into a pure function. When the clustering driver (cluster.ts) merges a new
 * report into a cluster that was already fixed/resolved/deferred (a "possible
 * regression" note), the cluster is auto-reopened. This computes the reopen
 * outcome from the cluster's prior status:
 *
 *   - deferred  → AGED-REOPEN  → status 'new',          annotate actionTaken,   no recurrence bump
 *   - otherwise → REGRESSION   → status 'investigating', annotate researchNotes, bump recurrenceCount
 *
 * The DB writes (the prisma update with `{ increment: 1 }` etc.) stay in the
 * adapter; this is the pure decision + the audit-note text. `now` is injected.
 * Reference is interleaved with DB I/O, so equivalence is by faithful
 * transcription + exhaustive unit tests (no clean isolated reference function to
 * run a cross-runtime harness against).
 */

import type { Cluster } from './types.js';

export interface ReopenDecision {
  /** New lifecycle status to set on the reopened cluster. */
  newStatus: 'new' | 'investigating';
  /** Whether to bump recurrenceCount (chronic-regression accounting; NOT for aged-reopen). */
  bumpRecurrence: boolean;
  /** Which cluster field the audit note is appended to. */
  annotateField: 'actionTaken' | 'researchNotes';
  /** The note tag. */
  noteTag: 'AGED-REOPEN' | 'REGRESSION';
  /** The audit note appended to the chosen field. */
  note: string;
}

/**
 * Compute the auto-reopen outcome for a cluster being merged into on a regression.
 * `wasStatus` is the cluster's status before reopen; `feedbackId` is the incoming
 * report; `now` is the injected ISO timestamp (reference uses new Date().toISOString()).
 */
export function computeReopen(cluster: Cluster, feedbackId: string, now: string): ReopenDecision {
  const wasStatus = cluster.status ?? null;
  const isAged = wasStatus === 'deferred';
  const newStatus: 'new' | 'investigating' = isAged ? 'new' : 'investigating';
  const noteTag: 'AGED-REOPEN' | 'REGRESSION' = isAged ? 'AGED-REOPEN' : 'REGRESSION';
  const fixedInVersion = (cluster.fixedInVersion as string) || 'n/a';

  // Verbatim from the reference's regressionNote template.
  const note = `[${noteTag} ${now}] New report matched cluster previously marked '${wasStatus}' (fixedInVersion=${fixedInVersion}). Auto-reopened to '${newStatus}' for review. Report: ${feedbackId}`;

  return {
    newStatus,
    bumpRecurrence: !isAged,
    annotateField: isAged ? 'actionTaken' : 'researchNotes',
    noteTag,
    note,
  };
}
