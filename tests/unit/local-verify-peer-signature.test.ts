/**
 * Signed Local Verify peer results (docs/specs/local-verify-peer-result-trust.md, D1).
 * Every refusal reason, tampering after signing, request binding, and receive-time key validity.
 */
import { describe, expect, it } from 'vitest';
import { generateSigningKeyPair, sign as edSign } from '../../src/core/MachineIdentity.js';
import { signerKeyHashOf, type MachineKeyLookup, type MachineSigner } from '../../src/core/AppRecordSignatures.js';
import { peerResultPayload, requestDigest, signPeerResult, verifyPeerResult } from '../../src/localVerify/peerResultSignature.js';

const PEER = 'm_peer';
const keys = generateSigningKeyPair();
const other = generateSigningKeyPair();

function signerFor(machineId: string, k: { publicKey: string; privateKey: string }): MachineSigner {
  return {
    machineId: () => machineId,
    signerKeyHash: () => signerKeyHashOf(k.publicKey),
    sign: (payload) => ({ machineId, signerKeyHash: signerKeyHashOf(k.publicKey), sig: edSign(payload, k.privateKey) }),
  };
}

/** A pinned-key lookup holding PEER's key, optionally revoked at `revokedAt`. */
function lookup(revokedAt: number | null = null): MachineKeyLookup {
  return (machineId, hash, atMs) => {
    if (machineId !== PEER || hash !== signerKeyHashOf(keys.publicKey)) return { status: 'unknown' };
    if (revokedAt !== null && atMs >= revokedAt) return { status: 'unknown' };
    return { status: 'ok', publicKeyPem: keys.publicKey };
  };
}

const request = { attemptId: 'a1', kind: 'main', pr: 0, headSha: 'h'.repeat(40), isolation: { allowed: false } };
const record = { kind: 'main', outcome: 'success', headSha: 'h'.repeat(40), flakyRetried: [] as string[], attempt: { id: 'a1' } };
const NOW = 1_800_000_000_000;

function answer(over: Partial<{ record: unknown; run: unknown }> = {}) {
  const body = { record: over.record ?? record, run: over.run, requestDigest: requestDigest(request) };
  return { ...body, sig: signPeerResult(signerFor(PEER, keys), body) };
}

describe('Local Verify peer result signatures', () => {
  it('a signed answer to the request that was sent verifies', () => {
    expect(verifyPeerResult(answer(), { peerMachineId: PEER, requestDigest: requestDigest(request) }, lookup(), NOW)).toBeNull();
  });

  it('the request digest does not depend on key order, and the payload is stable', () => {
    const reordered = { headSha: request.headSha, isolation: { allowed: false }, pr: 0, kind: 'main', attemptId: 'a1' };
    expect(requestDigest(reordered)).toBe(requestDigest(request));
    const b = { record, requestDigest: requestDigest(request) };
    expect(peerResultPayload(b)).toBe(peerResultPayload({ ...b, run: undefined }));
    expect(peerResultPayload(b).startsWith('instar-lv-peer-result-v1\n')).toBe(true);
  });

  it('a missing signature is refused', () => {
    const a = answer();
    expect(verifyPeerResult({ ...a, sig: undefined }, { peerMachineId: PEER, requestDigest: requestDigest(request) }, lookup(), NOW)).toBe('unsigned');
  });

  it('a request loosened on the way (isolation flipped) is refused even though the peer signed honestly', () => {
    const loosened = { ...request, isolation: { allowed: true } };
    const body = { record, requestDigest: requestDigest(loosened) };
    const a = { ...body, sig: signPeerResult(signerFor(PEER, keys), body) };
    expect(verifyPeerResult(a, { peerMachineId: PEER, requestDigest: requestDigest(request) }, lookup(), NOW)).toBe('request-mismatch');
  });

  it('a signature from another machine is refused', () => {
    const body = { record, requestDigest: requestDigest(request) };
    const a = { ...body, sig: signPeerResult(signerFor('m_other', other), body) };
    expect(verifyPeerResult(a, { peerMachineId: PEER, requestDigest: requestDigest(request) }, lookup(), NOW)).toBe('signature-wrong-machine');
  });

  it('a key the coordinator has not pinned for that peer is refused', () => {
    const body = { record, requestDigest: requestDigest(request) };
    const a = { ...body, sig: signPeerResult(signerFor(PEER, other), body) };
    expect(verifyPeerResult(a, { peerMachineId: PEER, requestDigest: requestDigest(request) }, lookup(), NOW)).toBe('signature-unknown-key');
  });

  it('a key revoked before the coordinator received the answer is refused', () => {
    expect(verifyPeerResult(answer(), { peerMachineId: PEER, requestDigest: requestDigest(request) }, lookup(NOW - 1), NOW)).toBe('signature-unknown-key');
  });

  it('an outcome or flaky list edited after signing is refused', () => {
    const a = answer();
    const expected = { peerMachineId: PEER, requestDigest: requestDigest(request) };
    expect(verifyPeerResult({ ...a, record: { ...record, outcome: 'failure' } }, expected, lookup(), NOW)).toBe('signature-bad');
    expect(verifyPeerResult({ ...a, record: { ...record, flakyRetried: ['tests/unit/x.test.ts'] } }, expected, lookup(), NOW)).toBe('signature-bad');
    expect(verifyPeerResult({ ...a, run: { reasons: ['added'] } }, expected, lookup(), NOW)).toBe('signature-bad');
  });

  it('a signed run detail verifies on the raw body it was sent with', () => {
    const run = { reasons: ['r'], failures: [{ file: 'tests/unit/a.test.ts', lane: 'unit' }] };
    expect(verifyPeerResult(answer({ run }), { peerMachineId: PEER, requestDigest: requestDigest(request) }, lookup(), NOW)).toBeNull();
  });
});

describe('the signing code sits inside the verifier version', () => {
  it('peerResultSignature is in the hashed import graph, so a change to it changes the verifier version', async () => {
    const { localImportGraph, VERIFIER_ROOTS } = await import('../../src/localVerify/verifierVersion.js');
    const path = await import('node:path');
    const dir = path.resolve(__dirname, '../../src/localVerify');
    const roots = VERIFIER_ROOTS.map((n) => path.join(dir, `${n}.ts`));
    const files = localImportGraph(roots).map((f) => f.replace(/\\/g, '/'));
    expect(files.some((f) => /localVerify\/peerResultSignature\.(ts|js)$/.test(f))).toBe(true);
  });
});
