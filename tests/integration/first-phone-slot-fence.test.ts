import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  firstPhoneSlotDecisionPayload, firstPhoneSlotOperationKey, type FirstPhoneSlotDecision,
} from '../../src/core/FirstPhoneSlotDecision.js';
import {
  holderHandoverBytes, orderedDecisionBytes, verifiedHolderSuccessor,
} from '../../src/core/OrderedPublicationWitness.js';
import { OrderedWitnessSnapshotStore, type AcceptedWitnessSnapshot } from '../../src/core/OrderedWitnessSnapshotStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import fixture from '../fixtures/first-phone/ordered-challenge-v2.json';

for (const winningAction of ['consume', 'replace'] as const) {
  it(`serializes ${winningAction} first against two stale attempts and recovers its exact receipt`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'first-phone-slot-'));
    const filename = join(directory, 'witness.sqlite');
    const store = OrderedWitnessSnapshotStore.open(filename);
    const concurrent = OrderedWitnessSnapshotStore.open(filename);
    const scope = { agentId: 'echo', namespace: 'machine-key-history' } as const;
    const prior = { slotKey: fixture.input.slotKey, generation: 0, keyDigest: '1'.repeat(64), reservedBy: null };
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const pins = new Map([['mini', publicKey.export({ type: 'spki', format: 'der' }).toString('base64')]]);
    const genesis: AcceptedWitnessSnapshot = {
      commit: 'a'.repeat(40), floor: {
        ...scope, witness: 'mini', witnessGeneration: 1, holder: 'studio', epoch: 1, position: 0, head: '0'.repeat(64),
      },
    };
    const first: FirstPhoneSlotDecision = {
      prior, operationId: 'first-consume', requestDigest: '2'.repeat(64),
      action: { kind: 'consume', challengeKey: fixture.expected.challengeKey,
        challengeDigest: fixture.expected.challengeDigest, keyDigest: '3'.repeat(64), projectionDigest: '4'.repeat(64) },
    };
    const second: FirstPhoneSlotDecision = {
      ...first, operationId: 'second-consume', requestDigest: '5'.repeat(64),
      action: { ...first.action, challengeKey: '6'.repeat(64), challengeDigest: '7'.repeat(64) },
    };
    const replace: FirstPhoneSlotDecision = {
      prior, operationId: 'key-replacement', requestDigest: '8'.repeat(64),
      action: { kind: 'replace', keyDigest: '9'.repeat(64), projectionDigest: 'a'.repeat(64) },
    };

    // Prepare the three candidates against the same floor before any is allowed to commit.
    function prepare(slotDecision: FirstPhoneSlotDecision, commit: string, expected = genesis) {
      const payload = firstPhoneSlotDecisionPayload(slotDecision);
      const decision = {
        ...expected.floor, operationKey: firstPhoneSlotOperationKey(slotDecision),
        payloadDigest: createHash('sha256').update(payload).digest('hex'),
      };
      const signature = sign(null, orderedDecisionBytes(decision), privateKey);
      return (connection: OrderedWitnessSnapshotStore) =>
        connection.acceptFirstPhoneSlotDecision(expected, commit, decision, slotDecision, signature, pins);
    }

    try {
      expect(store.provision(genesis)).toBe(true);
      expect(store.provisionFirstPhoneSlot(scope.agentId, prior)).toBe(true);
      const candidates = [prepare(first, 'b'.repeat(40)), prepare(second, 'c'.repeat(40)), prepare(replace, 'd'.repeat(40))];
      const winnerIndex = winningAction === 'consume' ? 0 : 2;
      const winner = [first, second, replace][winnerIndex];
      // Deliberately discard the success acknowledgement.
      candidates[winnerIndex](store);
      candidates.forEach((commit, index) => {
        if (index !== winnerIndex) expect(commit(concurrent)).toBe('conflict');
      });
      const accepted = concurrent.read(scope)!;
      expect(accepted.floor.position).toBe(1);
      const move = { floor: accepted.floor, nextEpoch: 2, nextHolder: 'successor', sealDigest: 'f'.repeat(64) };
      const signature = sign(null, holderHandoverBytes(move), privateKey);
      const next = { commit: 'e'.repeat(40), floor: verifiedHolderSuccessor(move.floor, move, signature, pins)! };
      expect(concurrent.recordAccepted(accepted, next)).toBe('recorded');

      expect(candidates[winnerIndex](concurrent)).toBe('existing');
      expect(concurrent.readFirstPhoneReceipt(scope.agentId, winner)).toMatchObject({
        decision: winner, commit: accepted.commit, floor: accepted.floor, decisionDigest: accepted.floor.head,
      });
      expect(concurrent.readFirstPhoneReceipt(scope.agentId, { ...winner, requestDigest: '0'.repeat(64) })).toBeNull();
      expect(prepare(winnerIndex === 0 ? replace : second, 'f'.repeat(40), next)(concurrent)).toBe('conflict');
      const current = concurrent.readFirstPhoneSlot(scope.agentId, prior.slotKey)!;
      expect(current).toMatchObject({ generation: 1 });
      // A fresh generation still cannot replace the wrong key lineage.
      expect(prepare({ ...replace, operationId: 'wrong-lineage', prior: { ...current, keyDigest: '0'.repeat(64) } },
        'f'.repeat(40), next)(concurrent)).toBe('conflict');
      expect(concurrent.read(scope)).toEqual(next);
    } finally {
      concurrent.close();
      store.close();
      SafeFsExecutor.safeRmSync(directory, { recursive: true, force: true, operation: 'first-phone-slot-fence-test:cleanup' });
    }
  });
}
