/**
 * The approver mark in the owner record (identity-security piece 3a) — the pure parts.
 *
 * An approving device's presence key is an owner key in the signed owner record. The first one is admitted by a
 * private-chat claim whose proof is a machine attestation checked against the record itself; later ones are added
 * by an approver's signature. Spec: docs/specs/identity-security-piece3a-approver-in-owner-record.md
 */
import crypto from 'node:crypto';
import { ownerRecordPresenceMessage, type FirstOwnerProofContext, type OwnerRecordEntry } from './ownerRecord.js';

/** `agentId` is part of signed framing: no newline (or anything else) can forge a field boundary. */
export const AGENT_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** §1: a device's owner-key id comes from its presence key (with a separator), so a phone paired with two machines
 *  has one owner key, and a reinstalled app (a new presence key) gets a new id. */
export function ownerKeyIdFor(presenceKey: string): string {
  return 'o_' + crypto.createHash('sha256').update('instar-owner-key\0' + presenceKey).digest('hex').slice(0, 24);
}

/** §1: the message an approver's app signs for a record entry, after computing the entry id itself. */
export function recordEntryPresenceMessage(agentId: string, entryId: string): string {
  if (!AGENT_ID_PATTERN.test(agentId)) throw new Error('agent id is not safe to sign');
  return ownerRecordPresenceMessage(agentId, entryId);
}

/** §3: the text a machine key signs to attest that the lease holder checked the private-chat claim code. */
export function firstOwnerProofMessage(agentId: string, parentId: string, deviceId: string, ownerKeyId: string, presenceKey: string): string {
  if (!AGENT_ID_PATTERN.test(agentId)) throw new Error('agent id is not safe to sign');
  for (const f of [parentId, deviceId, ownerKeyId, presenceKey]) if (/[\n\r]/.test(f)) throw new Error('newline in a signed field');
  return `instar-first-owner-v1\n${agentId}\n${parentId}\n${deviceId}\n${ownerKeyId}\n${presenceKey}`;
}

/** §3: build the proof (`body.proof`) with this machine's record key. */
export function makeFirstOwnerProof(input: { agentId: string; parentId: string; deviceId: string; ownerKeyId: string; presenceKey: string; machineId: string; sign: (text: string) => string }): { by: string; sig: string } {
  return { by: input.machineId, sig: input.sign(firstOwnerProofMessage(input.agentId, input.parentId, input.deviceId, input.ownerKeyId, input.presenceKey)) };
}

/**
 * §3: 2a's proof hook. The proof verifies against the attesting machine's key AS IT STANDS IN THE RECORD at the
 * entry's parent, so a later rotation or retirement can't undo it, and it binds the parent, device and key so it
 * can't be replayed onto another entry.
 */
export function makeFirstOwnerProofVerifier(agentId: string): (body: Record<string, unknown>, ctx: FirstOwnerProofContext) => boolean {
  return (body, ctx) => {
    const proof = body.proof as { by?: unknown; sig?: unknown } | undefined;
    if (!proof || typeof proof.by !== 'string' || typeof proof.sig !== 'string') return false;
    if (typeof body.deviceId !== 'string' || typeof body.keyId !== 'string' || typeof body.publicKey !== 'string') return false;
    if (body.keyType !== 'p256' || body.keyId !== ownerKeyIdFor(body.publicKey)) return false;
    const machine = ctx.keysAtParent.get(proof.by);
    if (!machine || machine.type !== 'machine') return false;
    let text: string;
    try { text = firstOwnerProofMessage(agentId, ctx.parentId, body.deviceId, body.keyId, body.publicKey); } catch { return false; /* @silent-fallback-ok: an unsafe field fails the proof; the entry is rejected and listed */ }
    try { return crypto.verify(null, Buffer.from(text), machine.publicKey, Buffer.from(proof.sig, 'base64')); } catch { return false; /* @silent-fallback-ok: an unparseable key or signature does not verify; the entry is rejected and listed */ }
  };
}

/** §1: the unsigned first owner-key entry the device is shown, renders, hashes and signs. */
export function firstOwnerKeyDraft(input: { agentId: string; parentId: string; deviceId: string; label: string; presenceKey: string; proof: { by: string; sig: string } }): Omit<OwnerRecordEntry, 'sig'> {
  const keyId = ownerKeyIdFor(input.presenceKey);
  return {
    v: 1, kind: 'add-owner-key', agentId: input.agentId, parents: [input.parentId],
    body: { keyId, publicKey: input.presenceKey, keyType: 'p256', deviceId: input.deviceId, label: input.label.slice(0, 80), via: 'first', proof: input.proof },
    signer: { type: 'owner-key', keyId },
  };
}
