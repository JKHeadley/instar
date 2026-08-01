import { describe, expect, it } from 'vitest';
import { reconcileIntentAudit } from '../../src/remediation/IntentAuditReconciler.js';
import type { IntentEntry, IntentJournal } from '../../src/remediation/IntentJournal.js';
import type { AuditEntry, AuditWriter } from '../../src/remediation/audit/AuditWriter.js';

function intent(attemptId: string, declaredAt: number): IntentEntry {
  return {
    intentId: `intent-${attemptId}`,
    attemptId,
    runbookId: 'fixture',
    signatureHash: 'sig',
    blastRadius: 'process',
    intent: 'dispatch',
    declaredAt,
    monotonicTs: BigInt(declaredAt),
  };
}

function audit(attemptId: string, timestamp: number): AuditEntry {
  return {
    entryId: `audit-${attemptId}`,
    attemptId,
    outcome: 'started',
    runbookId: 'fixture',
    subsystem: 'fixture',
    timestamp,
    monotonicTs: BigInt(timestamp),
    auditToken: Buffer.from('token'),
  };
}

describe('reconcileIntentAudit', () => {
  it('invokes both readers and reports an intent missing audit evidence', async () => {
    let observedCursor = -1;
    const intentJournal = {
      readSince: async (cursor: number) => {
        observedCursor = cursor;
        return [intent('matched', 100), intent('missing', 101)];
      },
    } as IntentJournal;
    const auditWriter = {
      recentTail: () => [audit('matched', 100)],
    } as AuditWriter;

    const result = await reconcileIntentAudit(intentJournal, auditWriter);

    expect(observedCursor).toBe(0);
    expect(result).toEqual({
      intentsRead: 2,
      auditEntriesRead: 1,
      unmatchedIntentAttemptIds: ['missing'],
    });
  });

  it('reads from the beginning when the hydrated audit window is empty', async () => {
    let observedCursor = -1;
    const intentJournal = {
      readSince: async (cursor: number) => {
        observedCursor = cursor;
        return [];
      },
    } as IntentJournal;
    const auditWriter = { recentTail: () => [] } as unknown as AuditWriter;

    await reconcileIntentAudit(intentJournal, auditWriter);
    expect(observedCursor).toBe(0);
  });
});
