import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { keyHashOf } from '../../src/core/MobileDeviceKeys.js';
import { orderedDecisionBytes } from '../../src/core/OrderedPublicationWitness.js';
import { OrderedWitnessSnapshotStore } from '../../src/core/OrderedWitnessSnapshotStore.js';
import { encodeFirstPhoneOrderedChallenge } from '../../src/core/trustJourney/firstPhoneOrderedChallenge.js';
import { createFirstPhoneOrderedEnrollment } from '../../src/core/trustJourney/firstPhoneOrderedEnrollment.js';
import { createFirstPhoneWitnessAuthority } from '../../src/core/trustJourney/firstPhoneWitnessAuthority.js';
import type { FirstPhoneSlotDecision } from '../../src/core/FirstPhoneSlotDecision.js';
import vector from '../fixtures/first-phone/ordered-challenge-v2.json';
import { makeDevice } from '../helpers/mobileDevice.js';

it.each(['consume', 'cancel', 'closed-during-observation', 'missing-staged-candidate'] as const)('connects the handler to the compound witness transaction: %s', async (mode) => {
  const dir = mkdtempSync(join(tmpdir(), 'first-phone-witness-authority-'));
  const store = OrderedWitnessSnapshotStore.open(join(dir, 'witness.sqlite'));
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pins = new Map([['mini', publicKey.export({ type: 'spki', format: 'der' }).toString('base64')]]);
  const phone = makeDevice();
  const challenge = { ...vector.input, holderEpoch: '1', presenceKeyHash: keyHashOf(phone.publicKey) };
  const { challengeKey, challengeDigest, bytes } = encodeFirstPhoneOrderedChallenge(challenge)!;
  const priorSlot = { slotKey: challenge.slotKey, generation: 0, keyDigest: 'a'.repeat(64), reservedBy: null };
  const scope = { agentId: 'echo', namespace: 'machine-key-history' } as const;
  let admitsConsume = true;
  let historical: FirstPhoneSlotDecision | undefined;
  const authority = createFirstPhoneWitnessAuthority({
    ...scope, holderMachineId: challenge.holderMachineId, store, pins,
    readAttempt: (key) => key === challengeKey ? {
      current: { challenge, presencePublicKey: phone.publicKey }, priorSlot,
      projectionDigest: 'b'.repeat(64), admitsConsume, admitsCancel: true, historical,
    } : null,
    async observe(_expected, decision, payload) {
      if (mode === 'closed-during-observation') admitsConsume = false;
      candidate = (JSON.parse(payload) as [string, FirstPhoneSlotDecision])[1];
      if (mode !== 'missing-staged-candidate') {
        expect(store.stageCandidate(scope, 'c'.repeat(40), decision.operationKey, Buffer.from(payload))).toBe('staged');
      }
      return { commit: 'c'.repeat(40), signature: sign(null, orderedDecisionBytes(decision), privateKey) };
    },
  });
  let candidate: FirstPhoneSlotDecision | undefined;
  const handler = createFirstPhoneOrderedEnrollment(authority);
  const consume = { challengeKey, challengeDigest, operationId: 'phone-confirmation-1', presenceSignature: phone.sign(bytes.toString('utf8')) };
  const cancel = { challengeKey, challengeDigest, operationId: 'holder-cancellation-1' };

  try {
    expect(store.provision({ commit: 'a'.repeat(40), floor: {
      ...scope, epoch: 1, holder: challenge.holderMachineId, witness: 'mini', witnessGeneration: 1,
      position: 0, head: '0'.repeat(64),
    } })).toBe(true);
    expect(store.provisionFirstPhoneSlot(scope.agentId, priorSlot)).toBe(true);
    const first = mode === 'cancel' ? await handler.cancel(cancel) : await handler.consume(consume, challenge);
    if (mode === 'closed-during-observation' || mode === 'missing-staged-candidate') {
      expect(first).toEqual({ kind: 'pending' });
      expect(store.read(scope)?.floor.position).toBe(0);
      expect(store.readFirstPhoneSlot(scope.agentId, challenge.slotKey)).toEqual(priorSlot);
      return;
    }
    expect(first).toMatchObject({ kind: 'witnessed', outcome: { decision: mode === 'consume' ? 'accepted' : 'canceled' } });
    expect(store.read(scope)?.floor.position).toBe(1);
    expect(store.readFirstPhoneSlot(scope.agentId, challenge.slotKey)).toMatchObject({
      generation: mode === 'consume' ? 1 : 0, reservedBy: mode === 'consume' ? challengeKey : null,
    });
    historical = candidate;
    admitsConsume = false;
    const exactRetry = mode === 'cancel' ? await handler.cancel(cancel) : await handler.consume(consume, challenge);
    expect(exactRetry).toEqual(first);
    const original = historical!;
    historical = { ...original, requestDigest: 'd'.repeat(64) };
    await expect(handler.consume(consume, challenge)).resolves.toEqual({ kind: 'pending' });
    historical = original;
    const loser = mode === 'cancel' ? await handler.consume(consume, challenge) : await handler.cancel(cancel);
    expect(loser).toEqual({ kind: 'refused' });
    expect(store.read(scope)?.floor.position).toBe(1);
  } finally {
    store.close();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'first-phone-witness-authority-test:cleanup' });
  }
});
