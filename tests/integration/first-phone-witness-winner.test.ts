import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { FencedPublicationStore } from '../../src/core/FencedPublicationStore.js';
import { holderHandoverBytes, orderedDecisionBytes, verifiedHolderSuccessor } from '../../src/core/OrderedPublicationWitness.js';
import { OrderedWitnessSnapshotStore } from '../../src/core/OrderedWitnessSnapshotStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import fixture from '../fixtures/first-phone/ordered-challenge-v2.json';

for (const winner of ['consume', 'cancel'] as const) {
  it(`keeps ${winner} as the only witnessed outcome after holder handover and stale restore`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'first-phone-witness-'));
    const scope = { agentId: 'echo', namespace: 'machine-key-history' } as const;
    const { challengeKey, challengeDigest } = fixture.expected;
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const pins = new Map([['mini', publicKey.export({ type: 'spki', format: 'der' }).toString('base64')]]);
    const genesis = { commit: 'a'.repeat(40), floor: {
      ...scope, epoch: 1, holder: fixture.input.holderMachineId, witness: 'mini', witnessGeneration: 1,
      head: '0'.repeat(64), position: 0,
    } };
    const filename = join(dir, 'witness.sqlite');
    const witness = OrderedWitnessSnapshotStore.open(filename);
    const competitor = OrderedWitnessSnapshotStore.open(filename);
    const opts = { enabled: true, pins, readIndependentFloor: () => witness.read(scope)?.floor ?? null };
    const active = FencedPublicationStore.open(join(dir, 'active.sqlite'), opts);
    const olderPath = join(dir, 'older.sqlite');
    let older = FencedPublicationStore.open(olderPath, opts);

    function attempt(action: 'consume' | 'cancel', floor = genesis.floor) {
      const payload = JSON.stringify([action, challengeKey, challengeDigest]);
      const decision = { ...floor, operationKey: challengeKey, payloadDigest: createHash('sha256').update(payload).digest('hex') };
      return { payload, decision, signature: sign(null, orderedDecisionBytes(decision), privateKey) };
    }

    try {
      expect(witness.provision(genesis)).toBe(true);
      expect(active.provisionOrdered(scope)).toBe(true);
      expect(older.provisionOrdered(scope)).toBe(true);
      const selected = attempt(winner);
      const otherAction = winner === 'consume' ? 'cancel' : 'consume';
      const loser = attempt(otherAction);
      const winningCommit = 'b'.repeat(40);
      expect(witness.acceptOrderedDecision(genesis, winningCommit, selected.decision, selected.payload, selected.signature, pins)).toBe('recorded');
      expect(competitor.acceptOrderedDecision(genesis, 'c'.repeat(40), loser.decision, loser.payload, loser.signature, pins)).toBe('conflict');
      for (const db of [active, older]) {
        expect(db.stage(scope, challengeKey, selected.decision.payloadDigest, selected.payload)).toBe('staged');
      }
      expect(active.claimOrdered(scope, selected.decision, selected.signature).kind).toBe('claimed');

      const accepted = witness.read(scope)!;
      const handover = { floor: accepted.floor, nextEpoch: 2, nextHolder: 'successor', sealDigest: 'f'.repeat(64) };
      const signature = sign(null, holderHandoverBytes(handover), privateKey);
      const next = { commit: 'd'.repeat(40), floor: verifiedHolderSuccessor(accepted.floor, handover, signature, pins)! };
      expect(active.prepareHandover(scope, accepted.floor, next.floor, handover.sealDigest)).toBe(true);
      expect(witness.recordAccepted(accepted, next)).toBe('recorded');
      expect(active.activateOrderedHandover(scope, handover, signature)).toBe(true);
      older.close();
      older = FencedPublicationStore.open(olderPath, opts);
      expect(competitor.acceptOrderedDecision(genesis, winningCommit, selected.decision, selected.payload, selected.signature, pins)).toBe('existing');

      const rebasedLoser = attempt(otherAction, next.floor);
      expect(competitor.acceptOrderedDecision(next, 'e'.repeat(40), rebasedLoser.decision, rebasedLoser.payload, rebasedLoser.signature, pins)).toBe('conflict');
      expect(older.claimOrdered(scope, selected.decision, selected.signature).kind).toBe('pending');
      expect(older.getClaim(scope, challengeKey)).toBeNull();
      expect(active.getClaim(scope, challengeKey)?.digest).toBe(selected.decision.payloadDigest);
      expect(competitor.readOperation(scope, challengeKey)).toEqual({
        payloadDigest: selected.decision.payloadDigest, commit: winningCommit,
      });
      expect(competitor.read(scope)).toEqual(next);
    } finally {
      older.close();
      active.close();
      competitor.close();
      witness.close();
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'first-phone-witness-test:cleanup' });
    }
  });
}
