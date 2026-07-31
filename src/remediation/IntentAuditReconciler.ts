/**
 * Boot-time reconciliation between durable remediation intents and the
 * writer's bounded, hydrated audit tail.
 *
 * An intent is written before the first `started` audit row. If the process
 * dies or audit persistence fails in that gap, the next process must make the
 * mismatch visible instead of leaving both read APIs dormant.
 */
import type { IntentJournal } from './IntentJournal.js';
import type { AuditWriter } from './audit/AuditWriter.js';

export interface IntentAuditReconciliation {
  intentsRead: number;
  auditEntriesRead: number;
  unmatchedIntentAttemptIds: string[];
}

// Intent persistence immediately precedes the first audit append. Include a
// generous overlap before the oldest retained audit row so a missing `started`
// row remains detectable even when key derivation or a busy host delayed the
// append. Remediation dispatch is rate-bounded, so this cannot pull an
// operationally large intent set into the comparison window.
const INTENT_AUDIT_OVERLAP_MS = 5 * 60 * 1000;

export async function reconcileIntentAudit(
  intentJournal: IntentJournal,
  auditWriter: AuditWriter,
): Promise<IntentAuditReconciliation> {
  const auditTail = auditWriter.recentTail();
  const earliestAuditTimestamp = auditTail.reduce(
    (earliest, entry) => Math.min(earliest, entry.timestamp),
    Number.POSITIVE_INFINITY,
  );
  // The tail is a bounded window. Only compare intents inside that window so
  // an old, valid intent is never called unmatched merely because its audit
  // row has aged out of memory. With no audit rows, read all intents: a
  // non-empty intent journal beside an empty projection is itself the signal.
  const cursor = Number.isFinite(earliestAuditTimestamp)
    ? Math.max(0, earliestAuditTimestamp - INTENT_AUDIT_OVERLAP_MS)
    : 0;
  const intents = await intentJournal.readSince(cursor);
  const auditedAttemptIds = new Set(auditTail.map((entry) => entry.attemptId));
  const unmatchedIntentAttemptIds = intents
    .filter((intent) => !auditedAttemptIds.has(intent.attemptId))
    .map((intent) => intent.attemptId);

  return {
    intentsRead: intents.length,
    auditEntriesRead: auditTail.length,
    unmatchedIntentAttemptIds,
  };
}
