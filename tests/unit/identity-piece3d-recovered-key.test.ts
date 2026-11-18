/**
 * identity-security piece 3d §2: a recovered owner key enters the record after enrolment only with the home machine's
 * proof that a 72-hour wait passed with no stop, verified against the record itself. Nothing else loosens 2a.
 */
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { evaluateOwnerRecord, signOwnerRecordEntry, ownerRecordEntryId, type OwnerRecordEntry } from '../../src/core/ownerRecord.js';
import { ownerKeyIdFor, recordEntryPresenceMessage, makeFirstOwnerProof, makeFirstOwnerProofVerifier, firstOwnerKeyDraft, makeRecoveryProofVerifier, recoveryProofMessage } from '../../src/core/ownerApprover.js';
import { makeDevice } from '../helpers/mobileDevice.js';

const AGENT = 'agent-1';
function ed() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  return { pub: publicKey as string, sign: (t: string) => crypto.sign(null, Buffer.from(t), privateKey).toString('base64') };
}
const OPTS = { agentId: AGENT, verifyFirstOwnerProof: makeFirstOwnerProofVerifier(AGENT), verifyRecoveryProof: makeRecoveryProofVerifier(AGENT) };

function enrolled() {
  const m = ed();
  const g = signOwnerRecordEntry({ kind: 'genesis', agentId: AGENT, parents: [], body: { machineId: 'm_A', publicKey: m.pub, level: 'basic', agentProducible: true }, signer: { type: 'machine', keyId: 'm_A' } }, m.sign);
  const first = makeDevice();
  const proof = makeFirstOwnerProof({ agentId: AGENT, parentId: g.id, deviceId: 'dev1', ownerKeyId: ownerKeyIdFor(first.publicKey), presenceKey: first.publicKey, machineId: 'm_A', sign: m.sign });
  const draft = firstOwnerKeyDraft({ agentId: AGENT, parentId: g.id, deviceId: 'dev1', label: 'Lost phone', presenceKey: first.publicKey, proof });
  const id = ownerRecordEntryId(draft as OwnerRecordEntry);
  const fo = { ...draft, sig: first.sign(recordEntryPresenceMessage(AGENT, id)) } as OwnerRecordEntry;
  return { m, g, fo, foId: id };
}

function recovered(m: ReturnType<typeof ed>, parentId: string, candidate: ReturnType<typeof makeDevice>, o: { hours?: number; by?: string; stopCheck?: string; tamperKey?: boolean } = {}) {
  const startedAt = new Date(Date.UTC(2026, 10, 10, 0, 0, 0)).toISOString();
  const finishedAt = new Date(Date.parse(startedAt) + (o.hours ?? 73) * 3600_000).toISOString();
  const keyId = ownerKeyIdFor(candidate.publicKey);
  const sig = m.sign(recoveryProofMessage({ agentId: AGENT, parentId, recoveryId: 'r1', deviceId: 'dev2', ownerKeyId: keyId, presenceKey: candidate.publicKey, startedAt, finishedAt }));
  const body: Record<string, unknown> = { keyId, publicKey: o.tamperKey ? makeDevice().publicKey : candidate.publicKey, keyType: 'p256', deviceId: 'dev2', label: 'New phone', via: 'recovered',
    recovery: { recoveryId: 'r1', startedAt, readyAt: finishedAt, finishedAt, stopCheck: o.stopCheck ?? 'clear', proof: { by: o.by ?? 'm_A', sig } } };
  const draft = { v: 1 as const, kind: 'add-owner-key' as const, agentId: AGENT, parents: [parentId], body, signer: { type: 'owner-key' as const, keyId } };
  const id = ownerRecordEntryId(draft as OwnerRecordEntry);
  return { entry: { ...draft, sig: candidate.sign(recordEntryPresenceMessage(AGENT, id)) } as OwnerRecordEntry, id, keyId };
}

describe('a recovered owner key (piece 3d §2)', () => {
  it('enters an enrolled record with the home machine\'s proof of a 72-hour wait', () => {
    const { m, g, fo, foId } = enrolled();
    const cand = makeDevice();
    const r = recovered(m, foId, cand);
    const st = evaluateOwnerRecord([g.entry, fo, r.entry], OPTS);
    expect(st.keys.some((k) => k.keyId === r.keyId && k.type === 'owner-key')).toBe(true);
  });

  it('is refused with a short wait, a stop, a proof by an unknown machine, a swapped key, or no proof hook', () => {
    const { m, g, fo, foId } = enrolled();
    const cand = makeDevice();
    const has = (e: OwnerRecordEntry, opts = OPTS) => evaluateOwnerRecord([g.entry, fo, e], opts).keys.some((k) => k.publicKey === cand.publicKey);
    expect(has(recovered(m, foId, cand, { hours: 71 }).entry)).toBe(false);
    expect(has(recovered(m, foId, cand, { stopCheck: 'stopped' }).entry)).toBe(false);
    expect(has(recovered(ed(), foId, cand, { by: 'm_X' }).entry)).toBe(false);
    expect(has(recovered(m, foId, cand, { tamperKey: true }).entry)).toBe(false);
    expect(has(recovered(m, foId, cand).entry, { agentId: AGENT, verifyFirstOwnerProof: OPTS.verifyFirstOwnerProof } as typeof OPTS)).toBe(false);
  });

  it('does not loosen anything else: a self-signed owner key without via=recovered is still refused after enrolment', () => {
    const { g, fo, foId } = enrolled();
    const cand = makeDevice();
    const keyId = ownerKeyIdFor(cand.publicKey);
    const draft = { v: 1 as const, kind: 'add-owner-key' as const, agentId: AGENT, parents: [foId], body: { keyId, publicKey: cand.publicKey, keyType: 'p256', deviceId: 'dev2', label: 'x', via: 'grant' }, signer: { type: 'owner-key' as const, keyId } };
    const id = ownerRecordEntryId(draft as OwnerRecordEntry);
    const e = { ...draft, sig: cand.sign(recordEntryPresenceMessage(AGENT, id)) } as OwnerRecordEntry;
    expect(evaluateOwnerRecord([g.entry, fo, e], OPTS).keys.some((k) => k.publicKey === cand.publicKey)).toBe(false);
  });
});
