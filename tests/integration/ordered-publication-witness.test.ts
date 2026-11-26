import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { FencedPublicationStore } from '../../src/core/FencedPublicationStore.js';
import {
  orderedDecisionBytes, verifiedOrderedSuccessor, verifiedWitnessSuccessor, witnessTransferBytes,
  type PublicationFloor,
} from '../../src/core/OrderedPublicationWitness.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

for (const namespace of ['needs-you', 'mobile-ingress'] as const) {
  it(`records ${namespace} only after exact independent acceptance and refuses a restored floor`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'ordered-publication-'));
    const file = join(directory, 'authority.sqlite');
    const restoredFile = join(directory, 'restored.sqlite');
    const scope = { agentId: 'echo', namespace };
    const current: PublicationFloor = {
      ...scope, epoch: 1, holder: 'studio', witness: 'm5', witnessGeneration: 1, position: 0,
      head: '0'.repeat(64),
    };
    const m5 = generateKeyPairSync('ed25519');
    const mini = generateKeyPairSync('ed25519');
    const pins = new Map([
      ['m5', m5.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')],
      ['mini', mini.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')],
    ]);
    let independent: PublicationFloor | null = current;
    const options = { enabled: true, pins, readIndependentFloor: () => independent };
    const store = FencedPublicationStore.open(file, options);
    const restored = FencedPublicationStore.open(restoredFile, options);
    const disabled = FencedPublicationStore.open(file);
    try {
      expect(disabled.provisionOrdered(scope)).toBe(false);
      expect(store.provisionOrdered(scope)).toBe(true);
      expect(restored.provisionOrdered(scope)).toBe(true);
      const payload = 'exact staged bytes';
      const decision = {
        ...current, operationKey: 'operation-1',
        payloadDigest: createHash('sha256').update(payload).digest('hex'),
      };
      const signature = sign(null, orderedDecisionBytes(decision), m5.privateKey);
      for (const db of [store, restored]) expect(db.stage(scope, decision.operationKey, decision.payloadDigest, payload)).toBe('staged');
      expect(disabled.claim(scope, current, decision.operationKey, decision.payloadDigest).kind).toBe('fenced');
      expect(store.claimOrdered(scope, decision, signature).kind).toBe('pending');
      independent = verifiedOrderedSuccessor(current, decision, payload, signature, pins);
      expect(independent).not.toBeNull();
      expect(store.claimOrdered(scope, decision, Buffer.alloc(64)).kind).toBe('fenced');
      expect(store.claimOrdered(scope, decision, signature).kind).toBe('claimed');
      const transfer = { floor: independent!, nextWitness: 'mini', nextWitnessGeneration: 2 };
      const offer = sign(null, witnessTransferBytes(transfer, 'offer'), m5.privateKey);
      const receipt = sign(null, witnessTransferBytes(transfer, 'receipt'), mini.privateKey);
      expect(store.transferWitness(scope, transfer, offer, receipt)).toBe(false);
      independent = verifiedWitnessSuccessor(transfer.floor, transfer, offer, receipt, pins);
      expect(independent).not.toBeNull();
      expect(store.transferWitness(scope, transfer, offer, receipt)).toBe(true);
      expect(store.transferWitness(scope, transfer, offer, receipt)).toBe(false);
      expect(restored.claimOrdered(scope, decision, signature).kind).toBe('pending');
      independent = null;
      expect(restored.claimOrdered(scope, decision, signature).kind).toBe('pending');
    } finally {
      disabled.close();
      restored.close();
      store.close();
      SafeFsExecutor.safeRmSync(directory, { recursive: true, force: true, operation: 'ordered-witness-test:cleanup' });
    }
  });
}
