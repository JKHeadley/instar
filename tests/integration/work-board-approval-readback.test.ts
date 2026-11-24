import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { CoherenceJournal } from '../../src/core/CoherenceJournal.js';
import { HybridLogicalClock } from '../../src/core/HybridLogicalClock.js';
import { ReplicatedKindRegistry } from '../../src/core/ReplicatedRecordEnvelope.js';
import { ReplicatedRecordEmitter } from '../../src/core/ReplicatedRecordEmitter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { approvalEventId, type WorkBoardApprovalRequest } from '../../src/core/WorkBoardApprovalWriter.js';
import { buildRecord, toFoldRecords, WORK_BOARD_STORE_KEY, WORK_CARD_KIND_REGISTRATION, WORK_CARD_RECORD_KIND } from '../../src/core/WorkCardStore.js';
import { readWorkBoardApprovalEvent } from '../../src/core/workBoardApprovalReadback.js';

it('reads the exact approval only after the real journal advances its durable watermark', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'wb-approval-readback-'));
  const machineId = 'm1';
  const journal = new CoherenceJournal({ stateDir, machineId, flushIntervalMs: 1_000_000 });
  try {
    const registry = new ReplicatedKindRegistry();
    registry.register(WORK_CARD_KIND_REGISTRATION);
    journal.open();
    journal.setReplicatedKindRegistry(registry);
    const emitter = new ReplicatedRecordEmitter({
      journal, clock: new HybridLogicalClock({ node: machineId, now: Date.now }), registry, origin: machineId,
      stores: () => ({ [WORK_BOARD_STORE_KEY]: { enabled: true } }), loadWitness: () => undefined,
    });
    const cardId = 'wc_6248a51921c41ca0';
    const request: WorkBoardApprovalRequest = {
      proof: { epoch: 'board:2', ownerGeneration: 'owner:3', writerIncarnation: 'machine:1' },
      version: { cardId, cardRevision: 'edit:2', policyRevision: 'policy:1', visibleTextHash: 'a'.repeat(64) },
      source: 'slip',
      decisionId: 'decision:1',
    };
    const event = { eventId: approvalEventId(request), request };
    const { incarnation: journalIncarnation, lastSeq: baselineSequence } = journal.getOwnAdvert()[WORK_CARD_RECORD_KIND];
    let reserved = false;
    const read = () => readWorkBoardApprovalEvent(event.eventId, {
      journal, epoch: { machineId, journalIncarnation, baselineSequence }, current: () => true,
      hasReservation: () => reserved,
    });
    expect(read()).toEqual({ status: 'missing' });
    const result = emitter.emit(WORK_BOARD_STORE_KEY, event.eventId, buildRecord('tap', cardId, {
      action: 'approve', by: { kind: 'person', personKey: 'owner1', proof: 'presence' },
      at: '2026-11-24T20:00:00.000Z', materialHash: 'a'.repeat(64), approvalBinding: request,
    }, event.eventId));
    expect(result.outcome).toBe('emitted');
    expect(result.seq).toBeDefined();
    reserved = true;
    expect(read()).toEqual({ status: 'unknown' });
    await journal.awaitDurableSeq(WORK_CARD_RECORD_KIND, result.seq!);
    expect(read()).toEqual({ status: 'durable', event });
    const stored = journal.readKindComplete(WORK_CARD_RECORD_KIND).entries;
    expect(toFoldRecords(stored.map(({ data, machine: origin }) => ({ data, origin })))).toEqual([]);
  } finally {
    journal.close();
    SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/integration/work-board-approval-readback.test.ts' });
  }
});
