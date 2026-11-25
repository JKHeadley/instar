import { generateKeyPairSync, sign, verify } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CameraAcceptanceJournalAdapter } from '../../src/core/CameraAcceptanceJournalAdapter.js';
import { cameraAcceptanceJournalBackend } from '../../src/core/CameraAcceptanceJournalBackend.js';
import { cameraJournalRecordKey, cameraJournalSigningText, type CameraJournalRecordBody } from '../../src/core/CameraAcceptanceJournalRecord.js';
import { cameraAcceptanceJournalSnapshot } from '../../src/core/CameraAcceptanceJournalSnapshot.js';
import { issueCameraVerifierRequest, recordCameraVerifierReceipt } from '../../src/core/CameraAcceptanceRequests.js';
import { buildCameraAcceptancePut, CHIEF_OF_STAFF_KIND_REGISTRATION, CHIEF_OF_STAFF_RECORD_KIND, CHIEF_OF_STAFF_STORE_KEY } from '../../src/core/ChiefOfStaffStore.js';
import { CoherenceJournal } from '../../src/core/CoherenceJournal.js';
import { HybridLogicalClock } from '../../src/core/HybridLogicalClock.js';
import { ReplicatedKindRegistry } from '../../src/core/ReplicatedRecordEnvelope.js';
import { ReplicatedRecordEmitter } from '../../src/core/ReplicatedRecordEmitter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('Camera receipt journal restart', () => {
  it('reopens an issued request and its subsequent Pass from the real durable Chief of Staff stream', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'camera-acceptance-'));
    const holder = 'studio';
    const scope = {
      conversationKey: 'app:camera-test', milestone: 'camera', leaseEpoch: 2,
      binding: { physical: 100, logical: 0, node: holder },
    };
    const keys = generateKeyPairSync('ed25519');
    const signHolder = (text: string) => sign(null, Buffer.from(text), keys.privateKey).toString('base64');
    const verifyHolder = (text: string, value: string) =>
      verify(null, Buffer.from(text), keys.publicKey, Buffer.from(value, 'base64'));
    const registry = new ReplicatedKindRegistry();
    registry.register(CHIEF_OF_STAFF_KIND_REGISTRATION);
    let activeJournal: CoherenceJournal | undefined;

    function open() {
      const journal = new CoherenceJournal({ stateDir: dir, machineId: holder, flushIntervalMs: 1_000_000 });
      activeJournal = journal;
      journal.setReplicatedKindRegistry(registry);
      journal.open();
      const emitter = new ReplicatedRecordEmitter({
        journal, registry, origin: holder, clock: new HybridLogicalClock({ node: holder, now: Date.now }),
        stores: () => ({ chiefOfStaff: { enabled: true } }), loadWitness: () => undefined,
      });
      const source = cameraAcceptanceJournalSnapshot({
        machineId: holder, journal, verifyHolder,
        loadCompleteUnion: () => {
          const read = journal.readKindComplete(CHIEF_OF_STAFF_RECORD_KIND);
          return read.complete ? read.entries.map(entry => ({ origin: entry.machine, data: entry.data })) : null;
        },
      });
      const backend = cameraAcceptanceJournalBackend({
        machineId: holder, journal, emitter, ...source, sign: signHolder,
        withConversationLock: (_conversation, run) => run(),
        readersReady: () => true, holdsLease: epoch => epoch === scope.leaseEpoch,
      });
      return { journal, emitter, adapter: new CameraAcceptanceJournalAdapter(scope, backend) };
    }

    try {
      const first = open();
      const body: CameraJournalRecordBody = {
        binding: scope.binding, milestone: scope.milestone, leaseEpoch: scope.leaseEpoch,
        holder, assignmentEpoch: 1, journalSequence: 1, revision: 1,
        candidate: 'camera-build', verifier: 'independent-reviewer',
        event: { kind: 'requirement', builders: ['builder'], designApprovalDigest: 'a'.repeat(64) },
      };
      const record = { ...body, signature: signHolder(cameraJournalSigningText(scope.conversationKey, body)) };
      const emitted = first.emitter.emit(CHIEF_OF_STAFF_STORE_KEY, cameraJournalRecordKey(scope.conversationKey, record),
        buildCameraAcceptancePut(scope.conversationKey, record));
      expect(emitted.outcome).toBe('emitted');
      await first.journal.awaitDurableSeq(CHIEF_OF_STAFF_RECORD_KIND, emitted.seq!);

      const issue = await issueCameraVerifierRequest(first.adapter, body.verifier);
      expect(issue.status).toBe('issued');
      if (issue.status !== 'issued') throw new Error('Expected issued request');
      first.journal.close();
      activeJournal = undefined;

      const second = open();
      await expect(second.adapter.withWriteLock(async tx => tx?.findRequest(issue.request.id))).resolves.toEqual(issue.request);
      expect(second.journal.readKindComplete(CHIEF_OF_STAFF_RECORD_KIND).entries).toHaveLength(2);

      const grant = { id: 'target-grant', phone: 'test-phone', computer: 'target', access: 'manage', expiresAt: null, revokedAt: null };
      const other = { ...grant, id: 'other-grant', computer: 'other' };
      const before = [other];
      const after = [other, grant];
      const unlinked = { before, after: before, visibleComputer: null };
      const evidence = {
        candidate: body.candidate, computer: grant.computer, phone: grant.phone, expectedGrant: grant,
        observedAt: '2026-11-25T02:23:00Z', redirected: false,
        success: { before, after, visibleComputer: grant.computer },
        cancellation: unlinked, expiry: unlinked,
        replay: { before: after, after, visibleComputer: grant.computer },
      };
      const recorded = await recordCameraVerifierReceipt(second.adapter, body.verifier, issue.request.id, evidence);
      expect(recorded).toMatchObject({ status: 'recorded', receipt: { decision: 'pass' } });
      second.journal.close();
      activeJournal = undefined;

      const third = open();
      await expect(issueCameraVerifierRequest(third.adapter, body.verifier)).resolves.toEqual({ status: 'pending-required' });
      await expect(recordCameraVerifierReceipt(third.adapter, body.verifier, issue.request.id, evidence)).resolves.toEqual(recorded);
      expect(third.journal.readKindComplete(CHIEF_OF_STAFF_RECORD_KIND).entries).toHaveLength(3);
    } finally {
      activeJournal?.close();
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'camera-acceptance-journal-restart-test' });
    }
  });
});
