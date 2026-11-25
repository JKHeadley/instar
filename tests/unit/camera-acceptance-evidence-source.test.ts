import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { cameraAcceptanceEvidenceSource, cameraEvidenceSigningText } from '../../src/core/CameraAcceptanceEvidenceSource.js';
import { canonicalHash } from '../../src/core/GraphWitnessTypes.js';

const scope = { conversationKey: 'app:camera', milestone: 'camera', leaseEpoch: 2, binding: { physical: 1, logical: 0, node: 'studio' } };
const requestId = 'fe45a4f2-2bd4-4c72-b16e-43ecda0b441f';
const principal = 'reviewer';
const keys = generateKeyPairSync('ed25519');
const unlinked = { before: [], after: [], visibleComputer: null };
const unsigned = {
  requestId, principal, scopeDigest: canonicalHash(scope), signature: '',
  evidence: {
    candidate: 'build', phone: 'phone', computer: 'target', observedAt: '2026-11-25T04:53:00Z',
    redirected: true, success: unlinked, cancellation: unlinked, expiry: unlinked, replay: unlinked,
    expectedGrant: { id: 'grant', phone: 'phone', computer: 'target', access: 'read', expiresAt: null, revokedAt: null },
  },
};
const signature = sign(null, Buffer.from(cameraEvidenceSigningText(unsigned)), keys.privateKey).toString('base64');
const record = { ...unsigned, signature };

function fixture() {
  const readProtected = vi.fn<() => Promise<unknown>>(async () => record);
  const load = cameraAcceptanceEvidenceSource({
    readProtected,
    verifyAttester: (_scope, _principal, text, value) =>
      verify(null, Buffer.from(text), keys.publicKey, Buffer.from(value, 'base64')),
  });
  return { load, readProtected };
}

describe('Camera protected evidence source', () => {
  it('loads a signed record only for the exact request, principal and scope', async () => {
    const { load, readProtected } = fixture();
    await expect(load(scope, principal, requestId)).resolves.toEqual(record.evidence);
    await expect(load(scope, 'other-reviewer', requestId)).resolves.toBeNull();
    await expect(load({ ...scope, leaseEpoch: 3 }, principal, requestId)).resolves.toBeNull();
    await expect(load(scope, principal, 'b5b3f6c2-3dbe-4c14-86ec-efdfdb027cc5')).resolves.toBeNull();
    await expect(load(scope, principal, '../../evidence')).resolves.toBeNull();
    expect(readProtected).toHaveBeenCalledTimes(4);
  });

  it('holds altered evidence, unexpected fields and an unavailable store', async () => {
    const { load, readProtected } = fixture();
    readProtected.mockResolvedValueOnce({ ...record, evidence: { ...record.evidence, redirected: false } });
    await expect(load(scope, principal, requestId)).resolves.toBeNull();
    readProtected.mockResolvedValueOnce({ ...record, extra: true });
    await expect(load(scope, principal, requestId)).resolves.toBeNull();
    readProtected.mockRejectedValueOnce(new Error('store unavailable'));
    await expect(load(scope, principal, requestId)).resolves.toBeNull();
  });
});
