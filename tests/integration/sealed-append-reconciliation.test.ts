import { createHash, createPublicKey, verify } from 'node:crypto';
import { expect, it } from 'vitest';
import { canonicalJson } from '../../src/core/appMediaTypes.js';
import { verifySealedAppendReconciliation } from '../../src/core/SealedAppendReconciliation.js';
import fixture from '../fixtures/sealed-append-reconciliation.json';

const key = createPublicKey({
  key: Buffer.from(fixture.signature.publicKeySpkiBase64, 'base64'), type: 'spki', format: 'der',
});

function authenticate<T>(envelope: { kind: string; payload: T; signatureBase64: string }, kind: string) {
  expect(envelope.kind).toBe(kind);
  const message = Buffer.from(fixture.signature.domain + '\0' + kind + '\0' + canonicalJson(envelope.payload));
  expect(verify(null, message, key, Buffer.from(envelope.signatureBase64, 'base64'))).toBe(true);
  return { payload: envelope.payload, digest: createHash('sha256').update(canonicalJson(envelope)).digest('hex') };
}

for (const { name, input, expected } of fixture.cases) {
  it(name, () => {
    const seal = authenticate(input.seal, 'predecessor-seal');
    expect(seal.payload.digestFormat).toBe('instar-journal-prefix-v1');
    const manifest = authenticate(input.manifest, 'activation-manifest');
    const evidence: Parameters<typeof verifySealedAppendReconciliation>[0] = {
      activeGeneration: fixture.activeGeneration,
      activeManifestDigest: manifest.digest,
      predecessor: {
        agent: 'synthetic-agent', store: 'chief-decision-frontier', transitionId: 'synthetic-lease-transition-41-to-42',
        predecessor: { stream: 'synthetic-chief-stream', incarnation: 'previous-incarnation', writer: 'previous-writer', leaseEpoch: 41 },
      },
      manifest,
      seal: { ...seal, payload: { ...seal.payload, digestFormat: 'instar-journal-prefix-v1' } },
      intent: authenticate(input.unresolvedIntent, 'unresolved-intent'),
      reconciliation: input.reconciliation ? authenticate(input.reconciliation, 'exact-reconciliation').payload : null,
      bytes: input.visiblePrefixBase64 === null ? null : Buffer.from(input.visiblePrefixBase64, 'base64'),
    };
    expect(verifySealedAppendReconciliation(evidence)).toBe(expected.status);
    expect(verifySealedAppendReconciliation({ ...evidence, activeManifestDigest: '0'.repeat(64) })).toBe('pending');
  });
}
