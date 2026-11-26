import { sha256Hex, signerKeyHashOf, verifyMachineSignature, type MachineSigner, type MachineSignature } from './AppRecordSignatures.js';
import { validateAppEvent, type CreatedEvent } from './AppConversationStore.js';
import { isAppConversationKey } from './appConversationText.js';
import { canonicalJson } from './appMediaTypes.js';

export interface AppRemovalCreationProof extends MachineSignature {
  version: 1;
  claimedTimeMs: number;
}

function proofBytes(namespace: string, creation: CreatedEvent, machine: string, key: string, time: number): string | null {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(namespace) || !/^[a-f0-9]{64}$/.test(key)
    || !isAppConversationKey(creation.conversationKey) || !/^[A-Za-z0-9._:-]{1,128}$/.test(creation.eventId)
    || !Number.isSafeInteger(time) || time <= 0 || creation.machineId !== machine) return null;
  const normalized = validateAppEvent(creation);
  if (normalized?.kind !== 'created') return null;
  const record = canonicalJson(normalized);
  if (Buffer.byteLength(record) > 8192) return null;
  return canonicalJson(['instar-app-removal-creation', 1, namespace, creation.conversationKey,
    creation.eventId, sha256Hex(record), machine, key, time]);
}

/** The caller supplies the origin's durably reread, conflict-free creation record. */
export function signAppRemovalCreation(
  namespace: string, creation: CreatedEvent, signer: MachineSigner, claimedTimeMs: number,
): AppRemovalCreationProof | null {
  const bytes = proofBytes(namespace, creation, signer.machineId(), signer.signerKeyHash(), claimedTimeMs);
  if (!bytes) return null;
  const signature = signer.sign(bytes);
  if (proofBytes(namespace, creation, signature.machineId, signature.signerKeyHash, claimedTimeMs) !== bytes) return null;
  return { version: 1, claimedTimeMs, ...signature };
}

/** First admission only. The lookup must enforce current eligibility using trusted authority.
 * Claimed signing time is covered by the signature and never goes into the key lookup.
 */
export function verifyNewAppRemovalCreation(
  namespace: string, creation: CreatedEvent, proof: AppRemovalCreationProof,
  authenticatedSender: string, currentKey: (machine: string, key: string) => string | null,
): boolean {
  if (proof.version !== 1 || proof.machineId !== authenticatedSender
    || typeof proof.sig !== 'string' || proof.sig.length > 128) return false;
  const bytes = proofBytes(namespace, creation, proof.machineId, proof.signerKeyHash, proof.claimedTimeMs);
  if (!bytes) return false;
  return verifyMachineSignature((machine, key) => {
    const publicKeyPem = currentKey(machine, key);
    return publicKeyPem && signerKeyHashOf(publicKeyPem) === key ? { status: 'ok', publicKeyPem } : { status: 'unknown' };
  }, proof, bytes, 0) === 'ok';
}

export interface AppRemovalCreationAdmission {
  authenticatedSender: string;
  admittedAtMs: number;
  historyRevision: string;
  proof: AppRemovalCreationProof;
}

/**
 * Recheck a durably admitted proof. The authority must reject restored admission
 * evidence and rolled-back history and apply rotation and compromise cutoffs.
 */
export function verifyRetainedAppRemovalCreation(
  namespace: string, creation: CreatedEvent, admission: AppRemovalCreationAdmission,
  authority: (admission: Readonly<AppRemovalCreationAdmission>) => string | null,
): boolean {
  const { proof, authenticatedSender, admittedAtMs, historyRevision } = admission;
  if (!Number.isSafeInteger(admittedAtMs) || admittedAtMs <= 0
    || !/^[A-Za-z0-9._:-]{1,128}$/.test(historyRevision)) return false;
  return verifyNewAppRemovalCreation(namespace, creation, proof, authenticatedSender, () => authority(admission));
}
