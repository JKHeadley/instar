import {verifyEd25519Memoized} from './VerifiedSignatureMemo.js';
import {graphMemberLossActivationDomain,verifyGraphMemberLossActivationAuthority,verifyGraphMemberLossActivationHolding,verifyGraphMemberLossPlanAuthority,type GraphMemberLossActivationAuthority,type GraphMemberLossActivationHolding} from './GraphMemberLossActivation.js';
import {verifyGraphCustodyProfile} from './GraphCustodyProfile.js';
/** Cryptographic wire contract for the independent Conversations witness.
 * Spec: conversation-effort-hierarchy-v3 §7.2. No title/transcript plaintext belongs here.
 */
import crypto from 'node:crypto';
import { GRAPH_REPLICATION_MAX_LEASE_EPOCH, GRAPH_REPLICATION_MAX_MEMBERSHIP_EPOCH } from './ConversationGraphReplicationLimits.js';
import type { LeaseRecord } from './types.js';
import { FencedLease } from './FencedLease.js';
import { verify as verifyMachineSignature } from './MachineIdentity.js';

/** Complete history population supported by the immutable recovery manifest. */
export const GRAPH_RECOVERY_MAX_MANIFEST_ENTRIES=20000;

export type {GraphMembershipMember,GraphMembershipEpoch} from './GraphMembershipTypes.js';
import type {GraphMembershipMember,GraphMembershipEpoch} from './GraphMembershipTypes.js';
export interface GraphWitnessLease {
  v: 1; agentId: string; membershipEpoch: number; leaseEpoch: number;
  writerId: string; issuedAt: string; expiresAt: string; fencedLeaseHash: string; signature: string;
}
export type GraphCoreType = 'graph-event'|'header-op'|'source-observation';
export function graphOperationKey(coreType:GraphCoreType,rawId:string):string{
 if(!['graph-event','header-op','source-observation'].includes(coreType)||!opaque(rawId))throw new Error('graph-operation-key-invalid');
 return `${coreType}:${rawId}`;
}
export function validGraphOperationKey(coreType:unknown,value:unknown):boolean{
 if(!['graph-event','header-op','source-observation'].includes(String(coreType))||typeof value!=='string')return false;
 const prefix=`${coreType}:`;return value.startsWith(prefix)&&opaque(value.slice(prefix.length));
}
export interface GraphErasureIdentity {sourceKind:'header'|'conversation-metadata'|'graph-intent';sourceId:string}
export function validateGraphErasureIdentity(raw:unknown):raw is GraphErasureIdentity{
 const value=raw as GraphErasureIdentity;if(!exactFields(value,['sourceKind','sourceId']))return false;
 return value.sourceKind==='header'?opaque(value.sourceId):value.sourceKind==='conversation-metadata'?hash(value.sourceId):value.sourceKind==='graph-intent'?(typeof value.sourceId==='string'&&/^queued:[a-f0-9]{64}$/.test(value.sourceId)||['graph-event','header-op','source-observation'].some(kind=>validGraphOperationKey(kind,value.sourceId))):false;
}
export function sameGraphErasureIdentity(a:GraphErasureIdentity,b:GraphErasureIdentity):boolean{return validateGraphErasureIdentity(a)&&validateGraphErasureIdentity(b)&&a.sourceKind===b.sourceKind&&a.sourceId===b.sourceId;}
export function erasureCoversPacket(proof:GraphWitnessErasure,packet:GraphOperationPacket):boolean{return proof.agentId===packet.agentId&&sameGraphErasureIdentity(proof.target,packet.erasureIdentity);}
export interface GraphOperationPacket {
  coreType: GraphCoreType;
  erasureIdentity:GraphErasureIdentity;
  agentId: string; eventId: string; idempotencyKey: string; coreHash: string;
  authorizationReceiptHash: string; controlHash:string; sourceSequence: number; predecessorHash: string | null;
  membershipEpoch: number; leaseEpoch: number; writerId: string; sourceBundleHash: string;
}
export interface GraphMemberReceipt {
  agentId: string; eventId: string; operationHash: string; membershipEpoch: number;
  leaseEpoch: number; machineId: string; phase: 'source' | 'certificate' | 'cancellation';
  certificateHash?: string; persistedAt: string; signature: string;
}
export interface GraphCommitCertificate {
  v: 1; agentId: string; eventId: string; operationHash: string; coreHash: string;
  authorizationReceiptHash: string; sourceSequence: number; predecessorHash: string | null;
  membershipEpoch: number; leaseEpoch: number; membershipHash: string;
  memberReceipts: GraphMemberReceipt[]; witnessId: string; committedAt: string; signature: string;
  adoption?: GraphAdoptionCertificate;
}
export interface GraphCancellationCertificate {
  v: 1; agentId: string; eventId: string; operationHash: string; coreHash: string;
  authorizationReceiptHash: string; sourceSequence: number; predecessorHash: string | null;
  membershipEpoch: number; leaseEpoch: number; membershipHash: string;
  outcome: 'canceled' | 'erased'; cancellationHash: string; memberReceipts: GraphMemberReceipt[];
  witnessId: string; canceledAt: string; signature: string;
  adoption?: GraphAdoptionCertificate;
}
export interface GraphWitnessErasedControlProof {
 v:1;agentId:string;eventId:string;operationHash:string;membershipEpoch:number;custodyMembershipEpoch:number;leaseEpoch:number;witnessId:string;targetHash:string;recordedAt:string;signature:string;
}
export interface GraphWitnessPrepareProof {
  v: 1; agentId: string; eventId: string; operationHash: string; membershipEpoch: number;
  leaseEpoch: number; witnessId: string; preparedAt: string; signature: string;
}
export interface GraphWitnessCancellation {
  v: 1; agentId: string; eventId: string; operationHash: string;
  membershipEpoch: number; leaseEpoch: number; witnessId: string; canceledAt: string; signature: string;
}
export interface GraphWitnessOperationStateProof {
  v: 1; agentId: string; idempotencyKey: string; operationHash: string; packetSignatureHash:string; erasedControlProofHash:string|null;
  state: 'prepared' | 'certified' | 'canceled' | 'erased'; certificateHash: string | null;
  cancellationHash: string | null; cancellationCertificateHash: string | null; erasureHash: string | null;
  adoptionHash: string | null;
  materializationHash:string|null;
  rewrapHash: string | null;
  certificatePersistenceHash: string;
  witnessId: string; observedAt: string; signature: string;
}
export interface GraphWitnessErasure {
  v: 1; agentId: string; requestId: string; target:GraphErasureIdentity; bundleHashes: string[];
  membershipEpoch: number; leaseEpoch: number; authorizationReceiptHash: string;
  witnessId: string; erasedAt: string; signature: string;
}
export function verifyWitnessErasure(proof: GraphWitnessErasure, witnessPublicKey: crypto.KeyLike): boolean {
  return exactFields(proof, ['v','agentId','requestId','target','bundleHashes','membershipEpoch','leaseEpoch','authorizationReceiptHash','witnessId','erasedAt','signature'])
    && validateGraphErasureIdentity(proof.target) && proof.v === 1 && opaque(proof.agentId) && opaque(proof.requestId) && positive(proof.membershipEpoch)
    && positive(proof.leaseEpoch) && hash(proof.authorizationReceiptHash) && iso(proof.erasedAt)
    && Array.isArray(proof.bundleHashes) && proof.bundleHashes.length <= 256
    && proof.bundleHashes.every(hash) && new Set(proof.bundleHashes).size === proof.bundleHashes.length
    && verifyGraphRecord(GRAPH_SIGNATURE_DOMAINS.erasure, unsigned(proof), proof.signature, witnessPublicKey);
}
export interface GraphSealedEnvelope {
  machineId: string; ephemeralPublicKey: string; nonce: string; ciphertext: string; tag: string;
}
export interface GraphEncryptedBundle {
  v: 1; algorithm: 'aes-256-gcm+x25519-hkdf-sha256'; nonce: string;
  ciphertext: string; tag: string; envelopes: GraphSealedEnvelope[];
}
/** A new membership may add envelope recipients, never change original source hashes. */
export interface GraphBundleRewrap {
  v: 1; agentId: string; eventId: string; originalBundleHash: string; ciphertextHash: string;
  newMembershipHash: string; membershipEpoch: number; writerId: string;
  envelopes: GraphSealedEnvelope[]; rewrappedAt: string; signature: string;
}
export interface GraphPendingRevalidation {
  v: 1; agentId: string; idempotencyKey: string; operationHash: string; coreHash: string;
  sourceProofHash: string; subjectHeadsHash: string; dependenciesHash: string; rewrapHash: string;
  newMembershipHash: string; currentLeaseHash: string; writerId: string;
  decision: 'adopt' | 'refuse';
  reason: 'ok' | 'stale-heads' | 'dependency-refused' | 'source-invalid' | 'owner-proof-invalid' | 'erased-source' | 'operator-refused';
  validatedAt: string; signature: string;
}
export interface GraphRecoveryAuthorization {
  v: 1; agentId: string; recoveryId: string; previousMembershipHash: string; newMembershipHash: string;
  previousWitnessId: string; newWitnessId: string; fenceEpoch: number;
  highestCertifiedSequence: number; highestCertifiedCoreHash: string | null;
  pendingOutcomes: Array<{ idempotencyKey: string; operationHash: string; decision: 'adopt' | 'refuse'; revalidationHash: string }>;
  sourceManifestHash: string; rewrapInventoryHash:string; issuedAt: string; signature: string;
}
export interface GraphMembershipTransferReceipt {
  v: 1; agentId: string; recoveryId: string; newMembershipHash: string; sourceManifestHash: string; rewrapInventoryHash:string;
  highestCertifiedSequence: number; highestCertifiedCoreHash: string | null; machineId: string;
  persistedAt: string; signature: string;
}
export interface GraphRewrapInventoryEntry {eventId:string;rewrapHash:string}
export function canonicalGraphRewrapInventory(entries:GraphRewrapInventoryEntry[]):GraphRewrapInventoryEntry[]{
 if(!Array.isArray(entries)||entries.length>20000)throw new Error('graph-rewrap-inventory-invalid');
 const ids=new Set<string>();for(const entry of entries){
  if(!exactFields(entry,['eventId','rewrapHash'])||!['graph-event','header-op','source-observation'].some(kind=>validGraphOperationKey(kind,entry.eventId))
    ||!hash(entry.rewrapHash)||ids.has(entry.eventId))throw new Error('graph-rewrap-inventory-invalid');ids.add(entry.eventId);
 }
 return entries.map(entry=>({...entry})).sort((a,b)=>a.eventId<b.eventId?-1:a.eventId>b.eventId?1:0);
}
export function graphRewrapInventoryHash(entries:GraphRewrapInventoryEntry[]):string{return canonicalHash(canonicalGraphRewrapInventory(entries));}
export interface GraphMembershipActivationCertificate {
  memberLoss?:GraphMemberLossActivationAuthority;activationHolding?:GraphMemberLossActivationHolding;
  v: 1; agentId: string; previousMembership: GraphMembershipEpoch; newMembership: GraphMembershipEpoch;
  ownerAuthorization: GraphRecoveryAuthorization; stateTransferReceipts: GraphMembershipTransferReceipt[];
  witnessId: string; activatedAt: string; signature: string;
}
export interface GraphRecoverySourceManifest {
  v: 1; agentId: string; membershipHash: string;
  highestCertifiedSequence: number; highestCertifiedCoreHash: string | null;
  highestAcknowledgedSequence: number; highestAcknowledgedCoreHash: string | null;
  entries: Array<{
    eventId: string; idempotencyKey: string; sourceSequence: number; operationHash: string;
    coreHash: string; authorizationReceiptHash: string; sourceBundleHash: string;
    prepareProofHash: string | null; erasedControlProofHash:string|null; certificateHash: string | null; cancellationHash: string | null;
    cancellationCertificateHash: string | null; adoptionHash: string | null; rewrapHash: string | null;
    erasureHash: string | null; certificatePersistenceHash: string;
  }>;
}
export interface GraphAdoptionCertificate {
  v: 1; agentId: string; idempotencyKey: string; operationHash: string; originalMembershipHash: string;
  newMembership: GraphMembershipEpoch; currentLease: GraphWitnessLease; originalCurrentLease: LeaseRecord;
  ownerAuthorization: GraphRecoveryAuthorization | null; revalidation: GraphPendingRevalidation; rewrapHash: string;
  membershipChain: GraphMembershipEpoch[];
  activation?: GraphMembershipActivationCertificate;
  disposition: 'adopted' | 'refused'; witnessId: string; adoptedAt: string; signature: string;
  erasedControlHash?:string; // Negative terminal authority only; never source adoption.
}
export interface GraphReceiptContext { membershipEpoch: number; leaseEpoch: number }

export const GRAPH_SIGNATURE_DOMAINS = {
  membership: 'graph-membership-v1', lease: 'graph-lease-v1',
  memberReceipt: 'graph-member-receipt-v1', certificate: 'graph-commit-certificate-v1',
  erasedControl:'graph-witness-erased-control-v1',prepare: 'graph-witness-prepare-v1', cancellation: 'graph-witness-cancellation-v1',
  cancellationCertificate: 'graph-cancellation-certificate-v1',
  erasure: 'graph-witness-erasure-v1',
  packet: 'graph-operation-packet-v1', action: 'graph-witness-action-v1',
  operationState: 'graph-witness-operation-state-v1',
  rewrap: 'graph-bundle-rewrap-v1', revalidation: 'graph-pending-revalidation-v1',
  recovery: 'graph-recovery-authorization-v1', adoption: 'graph-adoption-certificate-v1',
  membershipTransfer: 'graph-membership-transfer-v1',
  membershipActivation: 'graph-membership-activation-v1',
} as const;

export function witnessActionPayload(action: 'cancel' | 'erase', fields: Record<string, unknown>, lease: GraphWitnessLease) {
  return { action, ...fields, agentId: lease.agentId, membershipEpoch: lease.membershipEpoch, leaseEpoch: lease.leaseEpoch };
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().filter((key) => obj[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`).join(',')}}`;
  }
  throw new Error('graph-witness-invalid-canonical-value');
}
export function canonicalHash(value: unknown): string { return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex'); }
export function exactFields(value: unknown, fields: string[]): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...fields].sort().join(',');
}
/** canonicalPublicKey is a pure function of (type, PEM text). The graph re-walks the
 * same signed lineage on every readiness check, and parsing + re-exporting a PEM was
 * about a fifth of all CPU there (Linux profile, 2026-11-10), so the verdict is kept.
 * Bounded; oldest entry evicted first. Only key-sized strings are kept, so untrusted
 * oversized input cannot pin memory. */
const CANONICAL_KEY_LIMIT = 1024, CANONICAL_KEY_MAX_CHARS = 512;
const canonicalKeyVerdicts = new Map<string, boolean>();
export function canonicalPublicKey(value: string, type: 'ed25519' | 'x25519'): boolean {
  if (typeof value !== 'string') return false;
  const id = type + '\n' + value, cached = canonicalKeyVerdicts.get(id);
  if (cached !== undefined) return cached;
  let verdict: boolean;
  try { const key = crypto.createPublicKey(value); verdict = key.asymmetricKeyType === type && key.export({ type: 'spki', format: 'pem' }).toString() === value; }
  catch { /* @silent-fallback-ok: malformed untrusted PEM is a negative canonical-key predicate, never accepted key authority */ verdict = false; }
  if (value.length > CANONICAL_KEY_MAX_CHARS) return verdict;
  if (canonicalKeyVerdicts.size >= CANONICAL_KEY_LIMIT) canonicalKeyVerdicts.delete(canonicalKeyVerdicts.keys().next().value!);
  canonicalKeyVerdicts.set(id, verdict);
  return verdict;
}
export function unsigned<T extends { signature: string }>(record: T): Omit<T, 'signature'> {
  const { signature: _signature, ...payload } = record;
  return payload;
}
function signedBytes(domain: string, payload: unknown): Buffer { return Buffer.from(`${domain}\n${canonicalJson(payload)}`, 'utf8'); }
export function signGraphRecord(domain: string, payload: unknown, privateKey: crypto.KeyLike): string {
  return crypto.sign(null, signedBytes(domain, payload), privateKey).toString('base64url');
}
export function verifyGraphRecord(domain: string, payload: unknown, signature: string, publicKey: crypto.KeyLike): boolean {
  try {
    if (!/^[A-Za-z0-9_-]{86}$/.test(signature)) return false;
    if (Buffer.from(signature, 'base64url').toString('base64url') !== signature) return false;
    return verifyEd25519Memoized(signedBytes(domain, payload), Buffer.from(signature, 'base64url'), publicKey);
  } catch { /* @silent-fallback-ok: malformed untrusted signature, payload or public key is failed verification, never runtime recovery */ return false; }
}
export function verifyMembershipEpoch(epoch: GraphMembershipEpoch, ownerPublicKey: crypto.KeyLike): boolean {
  try {
    if (!exactFields(epoch,['agentId','createdAt','epoch','failureDomain','members','previousMembershipHash','signature','v','witnessId','writerId',...(epoch.custodyProfile===undefined?[]:['custodyProfile'])])
      || epoch.v !== 1 || !opaque(epoch.agentId) || !positive(epoch.epoch) || epoch.epoch>GRAPH_REPLICATION_MAX_MEMBERSHIP_EPOCH || !opaque(epoch.writerId) || !opaque(epoch.witnessId)
      || !opaque(epoch.failureDomain) || !iso(epoch.createdAt) || !Array.isArray(epoch.members) || !epoch.members.length || epoch.members.length > 64) return false;
    if (epoch.previousMembershipHash !== null && !hash(epoch.previousMembershipHash)) return false;
    const ids = new Set<string>();
    for (const member of epoch.members) {
      if (Object.keys(member).sort().join(',') !== 'machineId,sealingPublicKey,signingPublicKey' || !opaque(member.machineId) || ids.has(member.machineId)) return false;
      if (!canonicalPublicKey(member.signingPublicKey, 'ed25519') || !canonicalPublicKey(member.sealingPublicKey, 'x25519')) return false;
      ids.add(member.machineId);
    }
    if(epoch.custodyProfile!==undefined&&!verifyGraphCustodyProfile(epoch.custodyProfile,epoch,ownerPublicKey))return false;
    return ids.has(epoch.writerId) && verifyGraphRecord(GRAPH_SIGNATURE_DOMAINS.membership, unsigned(epoch), epoch.signature, ownerPublicKey);
  } catch { /* @silent-fallback-ok: malformed untrusted roster is rejected as invalid membership, never replaced with a default roster */ return false; }
}
export function verifyWitnessLease(lease: GraphWitnessLease, membership: GraphMembershipEpoch, now?: number): boolean {
  if (!exactFields(lease, ['v','agentId','membershipEpoch','leaseEpoch','writerId','issuedAt','expiresAt','fencedLeaseHash','signature'])) return false;
  const writer = membership.members.find((m) => m.machineId === lease.writerId);
  if (!writer || lease.v !== 1 || lease.agentId !== membership.agentId || !positive(lease.membershipEpoch) || lease.membershipEpoch>GRAPH_REPLICATION_MAX_MEMBERSHIP_EPOCH || lease.membershipEpoch !== membership.epoch
    || !positive(lease.leaseEpoch) || lease.leaseEpoch > GRAPH_REPLICATION_MAX_LEASE_EPOCH || !hash(lease.fencedLeaseHash) || !iso(lease.issuedAt) || !iso(lease.expiresAt)
    || Date.parse(lease.expiresAt) <= Date.parse(lease.issuedAt)) return false;
  if (now !== undefined && (Date.parse(lease.issuedAt) > now + 5000 || Date.parse(lease.expiresAt) <= now)) return false;
  return verifyGraphRecord(GRAPH_SIGNATURE_DOMAINS.lease, unsigned(lease), lease.signature, writer.signingPublicKey);
}
/** The bridge never replaces the installed signed lease authority. NEW admission
 * must also re-check WriteAdmission; historical replay calls this without a clock. */
export function verifyFencedLeaseBridge(bridge: GraphWitnessLease, original: LeaseRecord, membership: GraphMembershipEpoch): boolean {
  const member = membership.members.find((m) => m.machineId === bridge.writerId);
  try {
    return exactFields(original, ['holder','epoch','acquiredAt','expiresAt','nonce','signature', ...(original.released === undefined ? [] : ['released'])])
      && !!member && opaque(original.holder) && positive(original.epoch) && original.epoch <= GRAPH_REPLICATION_MAX_LEASE_EPOCH && Number.isSafeInteger(original.nonce) && original.nonce >= 0
      && iso(original.acquiredAt) && iso(original.expiresAt) && (original.released === undefined || typeof original.released === 'boolean')
      && typeof original.signature === 'string' && Buffer.from(original.signature, 'base64').length === 64
      && Buffer.from(original.signature, 'base64').toString('base64') === original.signature
      && original.holder === bridge.writerId && original.epoch === bridge.leaseEpoch
      && original.released !== true && bridge.fencedLeaseHash === canonicalHash(original)
      && original.acquiredAt === bridge.issuedAt && original.expiresAt === bridge.expiresAt
      && verifyWitnessLease(bridge, membership)
      && verifyMachineSignature(FencedLease.canonicalize(original), original.signature, member.signingPublicKey);
  } catch { /* @silent-fallback-ok: malformed native lease evidence fails authority verification, never grants admission */ return false; }
}
export function verifyWitnessCancellation(proof: GraphWitnessCancellation, packet: GraphOperationPacket, witnessPublicKey: crypto.KeyLike, context?: GraphReceiptContext): boolean {
  return exactFields(proof, ['v','agentId','eventId','operationHash','membershipEpoch','leaseEpoch','witnessId','canceledAt','signature'])
    && proof.v === 1 && proof.agentId === packet.agentId && proof.eventId === packet.eventId && proof.operationHash === canonicalHash(packet)
    && proof.membershipEpoch === (context?.membershipEpoch ?? packet.membershipEpoch) && proof.leaseEpoch === (context?.leaseEpoch ?? packet.leaseEpoch) && iso(proof.canceledAt)
    && verifyGraphRecord(GRAPH_SIGNATURE_DOMAINS.cancellation, unsigned(proof), proof.signature, witnessPublicKey);
}
export function bundleCiphertextHash(bundle: GraphEncryptedBundle): string {
  return canonicalHash({ v: bundle.v, algorithm: bundle.algorithm, nonce: bundle.nonce, ciphertext: bundle.ciphertext, tag: bundle.tag });
}
export function verifyBundleRewrap(rewrap: GraphBundleRewrap, bundle: GraphEncryptedBundle, membership: GraphMembershipEpoch): boolean {
  try {
    if (!exactFields(rewrap, ['v','agentId','eventId','originalBundleHash','ciphertextHash','newMembershipHash','membershipEpoch','writerId','envelopes','rewrappedAt','signature'])
      || rewrap.v !== 1 || rewrap.agentId !== membership.agentId || !opaque(rewrap.eventId) || rewrap.originalBundleHash !== canonicalHash(bundle)
      || rewrap.ciphertextHash !== bundleCiphertextHash(bundle) || rewrap.newMembershipHash !== canonicalHash(membership)
      || rewrap.membershipEpoch !== membership.epoch || !iso(rewrap.rewrappedAt) || !Array.isArray(rewrap.envelopes)
      || rewrap.envelopes.length !== membership.members.length) return false;
    const writer = membership.members.find((m) => m.machineId === rewrap.writerId);
    const seen = new Set<string>();
    for (const envelope of rewrap.envelopes) {
      if (!exactFields(envelope, ['machineId','ephemeralPublicKey','nonce','ciphertext','tag']) || seen.has(envelope.machineId)
        || !membership.members.some((m) => m.machineId === envelope.machineId) || !canonicalPublicKey(envelope.ephemeralPublicKey, 'x25519')
        || Buffer.from(envelope.nonce, 'base64url').length !== 12 || Buffer.from(envelope.ciphertext, 'base64url').length !== 32
        || Buffer.from(envelope.tag, 'base64url').length !== 16) return false;
      for (const value of [envelope.nonce, envelope.ciphertext, envelope.tag]) if (Buffer.from(value, 'base64url').toString('base64url') !== value) return false;
      seen.add(envelope.machineId);
    }
    return !!writer && verifyGraphRecord(GRAPH_SIGNATURE_DOMAINS.rewrap, unsigned(rewrap), rewrap.signature, writer.signingPublicKey);
  } catch { /* @silent-fallback-ok: malformed envelope or rewrap evidence is rejected, never treated as recoverable source */ return false; }
}
export function verifyMemberReceipt(receipt: GraphMemberReceipt, packet: GraphOperationPacket, membership: GraphMembershipEpoch,
  phase: GraphMemberReceipt['phase'], certificateHash?: string, context?: GraphReceiptContext): boolean {
  if (!exactFields(receipt, ['agentId','eventId','operationHash','membershipEpoch','leaseEpoch','machineId','phase','persistedAt','signature', ...(phase === 'source' ? [] : ['certificateHash'])])) return false;
  const member = membership.members.find((m) => m.machineId === receipt.machineId);
  return !!member && receipt.agentId === packet.agentId && receipt.eventId === packet.eventId
    && receipt.operationHash === canonicalHash(packet) && receipt.membershipEpoch === (context?.membershipEpoch ?? packet.membershipEpoch)
    && membership.epoch === receipt.membershipEpoch && receipt.leaseEpoch === (context?.leaseEpoch ?? packet.leaseEpoch) && receipt.phase === phase && iso(receipt.persistedAt)
    && receipt.certificateHash === certificateHash
    && verifyGraphRecord(GRAPH_SIGNATURE_DOMAINS.memberReceipt, unsigned(receipt), receipt.signature, member.signingPublicKey);
}
export function verifyCommitCertificate(certificate: GraphCommitCertificate, packet: GraphOperationPacket,
  membership: GraphMembershipEpoch, witnessPublicKey: crypto.KeyLike, ownerPublicKey?: crypto.KeyLike): boolean {
  if(certificate.adoption?.erasedControlHash!==undefined)return false;
  if (certificate.adoption && (!ownerPublicKey || certificate.adoption.disposition !== 'adopted' || !verifyAdoptionCertificate(certificate.adoption, packet, membership, ownerPublicKey, witnessPublicKey))) return false;
  const effectiveMembership = certificate.adoption?.newMembership ?? membership;
  const context = certificate.adoption ? { membershipEpoch: effectiveMembership.epoch, leaseEpoch: certificate.adoption.currentLease.leaseEpoch } : undefined;
  if (!exactFields(certificate, ['v','agentId','eventId','operationHash','coreHash','authorizationReceiptHash','sourceSequence','predecessorHash','membershipEpoch','leaseEpoch','membershipHash','memberReceipts','witnessId','committedAt','signature', ...(certificate.adoption ? ['adoption'] : [])])
    || certificate.v !== 1 || certificate.agentId !== packet.agentId || certificate.eventId !== packet.eventId
    || certificate.operationHash !== canonicalHash(packet) || certificate.coreHash !== packet.coreHash
    || certificate.authorizationReceiptHash !== packet.authorizationReceiptHash || certificate.sourceSequence !== packet.sourceSequence
    || certificate.predecessorHash !== packet.predecessorHash || certificate.membershipEpoch !== (context?.membershipEpoch ?? packet.membershipEpoch)
    || certificate.leaseEpoch !== (context?.leaseEpoch ?? packet.leaseEpoch) || certificate.membershipHash !== canonicalHash(effectiveMembership)
    || certificate.witnessId !== effectiveMembership.witnessId || !iso(certificate.committedAt)
    || !Array.isArray(certificate.memberReceipts) || certificate.memberReceipts.length !== effectiveMembership.members.length) return false;
  const ids = new Set<string>();
  for (const receipt of certificate.memberReceipts) {
    if (ids.has(receipt.machineId) || !verifyMemberReceipt(receipt, packet, effectiveMembership, 'source', undefined, context)) return false;
    ids.add(receipt.machineId);
  }
  return verifyGraphRecord(GRAPH_SIGNATURE_DOMAINS.certificate, unsigned(certificate), certificate.signature, witnessPublicKey);
}
export function verifyCancellationCertificate(certificate: GraphCancellationCertificate, packet: GraphOperationPacket,
  membership: GraphMembershipEpoch, witnessPublicKey: crypto.KeyLike, ownerPublicKey?: crypto.KeyLike): boolean {
  if (certificate.adoption && (!ownerPublicKey || !verifyAdoptionCertificate(certificate.adoption, packet, membership, ownerPublicKey, witnessPublicKey))) return false;
  const effectiveMembership = certificate.adoption?.newMembership ?? membership;
  const context = certificate.adoption ? { membershipEpoch: effectiveMembership.epoch, leaseEpoch: certificate.adoption.currentLease.leaseEpoch } : undefined;
  if (!exactFields(certificate, ['v','agentId','eventId','operationHash','coreHash','authorizationReceiptHash','sourceSequence','predecessorHash','membershipEpoch','leaseEpoch','membershipHash','outcome','cancellationHash','memberReceipts','witnessId','canceledAt','signature', ...(certificate.adoption ? ['adoption'] : [])])
    || certificate.v !== 1 || certificate.agentId !== packet.agentId || certificate.eventId !== packet.eventId
    || certificate.operationHash !== canonicalHash(packet) || certificate.coreHash !== packet.coreHash
    || certificate.authorizationReceiptHash !== packet.authorizationReceiptHash || certificate.sourceSequence !== packet.sourceSequence
    || certificate.predecessorHash !== packet.predecessorHash || certificate.membershipEpoch !== (context?.membershipEpoch ?? packet.membershipEpoch)
    || certificate.leaseEpoch !== (context?.leaseEpoch ?? packet.leaseEpoch) || certificate.membershipHash !== canonicalHash(effectiveMembership)
    || certificate.witnessId !== effectiveMembership.witnessId || !iso(certificate.canceledAt) || !hash(certificate.cancellationHash)
    || !['canceled', 'erased'].includes(certificate.outcome) || !Array.isArray(certificate.memberReceipts)
    || certificate.memberReceipts.length !== effectiveMembership.members.length) return false;
  const ids = new Set<string>();
  for (const receipt of certificate.memberReceipts) {
    if (ids.has(receipt.machineId) || !verifyMemberReceipt(receipt, packet, effectiveMembership, 'cancellation', certificate.cancellationHash, context)) return false;
    ids.add(receipt.machineId);
  }
  return verifyGraphRecord(GRAPH_SIGNATURE_DOMAINS.cancellationCertificate, unsigned(certificate), certificate.signature, witnessPublicKey);
}
export function verifyRecoveryAuthorization(authorization: GraphRecoveryAuthorization, previous: GraphMembershipEpoch,
  next: GraphMembershipEpoch, ownerPublicKey: crypto.KeyLike): boolean {
  try {
    if (!exactFields(authorization, ['v','agentId','recoveryId','previousMembershipHash','newMembershipHash','previousWitnessId','newWitnessId','fenceEpoch','highestCertifiedSequence','highestCertifiedCoreHash','pendingOutcomes','sourceManifestHash','rewrapInventoryHash','issuedAt','signature'])
      || authorization.v !== 1 || authorization.agentId !== previous.agentId || authorization.agentId !== next.agentId || !opaque(authorization.recoveryId)
      || authorization.previousMembershipHash !== canonicalHash(previous) || authorization.newMembershipHash !== canonicalHash(next)
      || next.epoch !== previous.epoch + 1 || next.previousMembershipHash !== canonicalHash(previous)
      || authorization.previousWitnessId !== previous.witnessId || authorization.newWitnessId !== next.witnessId
      || !positive(authorization.fenceEpoch) || !Number.isSafeInteger(authorization.highestCertifiedSequence) || authorization.highestCertifiedSequence < 0
      || (authorization.highestCertifiedCoreHash !== null && !hash(authorization.highestCertifiedCoreHash))
      || ((authorization.highestCertifiedSequence === 0) !== (authorization.highestCertifiedCoreHash === null))
      || !hash(authorization.rewrapInventoryHash) || !hash(authorization.sourceManifestHash) || !iso(authorization.issuedAt) || !Array.isArray(authorization.pendingOutcomes) || authorization.pendingOutcomes.length > 512
      || !verifyMembershipEpoch(previous, ownerPublicKey) || !verifyMembershipEpoch(next, ownerPublicKey)) return false;
    const keys = new Set<string>();
    for (const outcome of authorization.pendingOutcomes) {
      if (!exactFields(outcome, ['idempotencyKey','operationHash','decision','revalidationHash']) || !opaque(outcome.idempotencyKey)
        || keys.has(outcome.idempotencyKey) || !hash(outcome.operationHash) || !hash(outcome.revalidationHash) || !['adopt','refuse'].includes(outcome.decision)) return false;
      keys.add(outcome.idempotencyKey);
    }
    return verifyGraphRecord(GRAPH_SIGNATURE_DOMAINS.recovery, unsigned(authorization), authorization.signature, ownerPublicKey);
  } catch { /* @silent-fallback-ok: malformed owner recovery plan is rejected, never authorizes a transition */ return false; }
}
export function verifyPendingRevalidation(proof: GraphPendingRevalidation, packet: GraphOperationPacket,
  membership: GraphMembershipEpoch, lease: GraphWitnessLease): boolean {
  if (!exactFields(proof, ['v','agentId','idempotencyKey','operationHash','coreHash','sourceProofHash','subjectHeadsHash','dependenciesHash','rewrapHash','newMembershipHash','currentLeaseHash','writerId','decision','reason','validatedAt','signature'])
    || proof.v !== 1 || proof.agentId !== packet.agentId || proof.idempotencyKey !== packet.idempotencyKey || proof.operationHash !== canonicalHash(packet)
    || proof.coreHash !== packet.coreHash || !hash(proof.sourceProofHash) || !hash(proof.subjectHeadsHash) || !hash(proof.dependenciesHash) || !hash(proof.rewrapHash)
    || proof.newMembershipHash !== canonicalHash(membership) || proof.currentLeaseHash !== canonicalHash(lease) || proof.writerId !== lease.writerId
    || !iso(proof.validatedAt) || Date.parse(proof.validatedAt) < Date.parse(lease.issuedAt) || Date.parse(proof.validatedAt) >= Date.parse(lease.expiresAt)
    || (proof.decision === 'adopt' ? proof.reason !== 'ok' : proof.decision !== 'refuse' || !['stale-heads','dependency-refused','source-invalid','owner-proof-invalid','erased-source','operator-refused'].includes(proof.reason))) return false;
  const writer = membership.members.find((m) => m.machineId === proof.writerId);
  return !!writer && verifyGraphRecord(GRAPH_SIGNATURE_DOMAINS.revalidation, unsigned(proof), proof.signature, writer.signingPublicKey);
}
export function verifyMembershipTransferReceipt(receipt: GraphMembershipTransferReceipt, authorization: GraphRecoveryAuthorization,
  membership: GraphMembershipEpoch): boolean {
  if (!exactFields(receipt, ['v','agentId','recoveryId','newMembershipHash','sourceManifestHash','rewrapInventoryHash','highestCertifiedSequence','highestCertifiedCoreHash','machineId','persistedAt','signature'])
    || receipt.v !== 1 || receipt.agentId !== authorization.agentId || receipt.recoveryId !== authorization.recoveryId
    || receipt.newMembershipHash !== canonicalHash(membership) || receipt.sourceManifestHash !== authorization.sourceManifestHash || receipt.rewrapInventoryHash!==authorization.rewrapInventoryHash
    || receipt.highestCertifiedSequence !== authorization.highestCertifiedSequence || receipt.highestCertifiedCoreHash !== authorization.highestCertifiedCoreHash
    || !iso(receipt.persistedAt)) return false;
  const member = membership.members.find((m) => m.machineId === receipt.machineId);
  return !!member && verifyGraphRecord(GRAPH_SIGNATURE_DOMAINS.membershipTransfer, unsigned(receipt), receipt.signature, member.signingPublicKey);
}
export function validateRecoverySourceManifest(manifest: GraphRecoverySourceManifest): boolean {
  try {
    if (!exactFields(manifest, ['v','agentId','membershipHash','highestCertifiedSequence','highestCertifiedCoreHash','highestAcknowledgedSequence','highestAcknowledgedCoreHash','entries'])
      || manifest.v !== 1 || !opaque(manifest.agentId) || !hash(manifest.membershipHash) || !Array.isArray(manifest.entries) || manifest.entries.length > GRAPH_RECOVERY_MAX_MANIFEST_ENTRIES) return false;
    for (const [sequence, coreHash] of [[manifest.highestCertifiedSequence, manifest.highestCertifiedCoreHash], [manifest.highestAcknowledgedSequence, manifest.highestAcknowledgedCoreHash]] as const)
      if (!Number.isSafeInteger(sequence) || sequence < 0 || ((sequence === 0) !== (coreHash === null)) || (coreHash !== null && !hash(coreHash))) return false;
    if (manifest.highestAcknowledgedSequence > manifest.highestCertifiedSequence) return false;
    const ids = new Set<string>(); const keys = new Set<string>();
    let prior: GraphRecoverySourceManifest['entries'][number] | null = null;
    for (const entry of manifest.entries) {
      if (!exactFields(entry, ['eventId','idempotencyKey','sourceSequence','operationHash','coreHash','authorizationReceiptHash','sourceBundleHash','prepareProofHash','erasedControlProofHash','certificateHash','cancellationHash','cancellationCertificateHash','adoptionHash','rewrapHash','erasureHash','certificatePersistenceHash'])
        || !opaque(entry.eventId) || !opaque(entry.idempotencyKey) || !positive(entry.sourceSequence) || ids.has(entry.eventId) || keys.has(entry.idempotencyKey)
        || ![entry.operationHash,entry.coreHash,entry.authorizationReceiptHash,entry.sourceBundleHash,entry.certificatePersistenceHash].every(hash)) return false;
      for (const value of [entry.prepareProofHash,entry.erasedControlProofHash,entry.certificateHash,entry.cancellationHash,entry.cancellationCertificateHash,entry.adoptionHash,entry.rewrapHash,entry.erasureHash]) if (value !== null && !hash(value)) return false;
      if (prior && (entry.sourceSequence < prior.sourceSequence || (entry.sourceSequence === prior.sourceSequence && entry.eventId <= prior.eventId))) return false;
      ids.add(entry.eventId); keys.add(entry.idempotencyKey); prior = entry;
    }
    return true;
  } catch { /* @silent-fallback-ok: malformed supplied inventory is an invalid manifest, never an empty or partial valid inventory */ return false; }
}
export function verifyMembershipActivation(certificate: GraphMembershipActivationCertificate, ownerPublicKey: crypto.KeyLike, witnessPublicKey: crypto.KeyLike): boolean {
  try {
    if (!exactFields(certificate, ['v','agentId','previousMembership','newMembership','ownerAuthorization','stateTransferReceipts','witnessId','activatedAt','signature',...(certificate.memberLoss===undefined?[]:['memberLoss']),...(certificate.activationHolding===undefined?[]:['activationHolding'])])
      || certificate.v !== 1 || certificate.agentId !== certificate.newMembership.agentId || certificate.witnessId !== certificate.newMembership.witnessId
      || !iso(certificate.activatedAt) || !verifyRecoveryAuthorization(certificate.ownerAuthorization, certificate.previousMembership, certificate.newMembership, ownerPublicKey)
      || !Array.isArray(certificate.stateTransferReceipts) || certificate.stateTransferReceipts.length !== certificate.newMembership.members.length) return false;
    const seen = new Set<string>();
    for (const receipt of certificate.stateTransferReceipts) {
      if (seen.has(receipt.machineId) || !verifyMembershipTransferReceipt(receipt, certificate.ownerAuthorization, certificate.newMembership)) return false;
      seen.add(receipt.machineId);
    }
    // Only the signed activatedAt is compared, never the current clock, so a stored certificate verifies forever.
    if(certificate.activationHolding!==undefined){if(certificate.memberLoss===undefined||!verifyGraphMemberLossPlanAuthority(certificate.memberLoss,certificate,ownerPublicKey)||!verifyGraphMemberLossActivationHolding(certificate.activationHolding,certificate.memberLoss,certificate.newMembership,Date.parse(certificate.activatedAt)))return false;}
    else if(certificate.memberLoss!==undefined&&!verifyGraphMemberLossActivationAuthority(certificate.memberLoss,certificate,ownerPublicKey))return false;
    return verifyGraphRecord(certificate.memberLoss?graphMemberLossActivationDomain(certificate.memberLoss):GRAPH_SIGNATURE_DOMAINS.membershipActivation, unsigned(certificate), certificate.signature, witnessPublicKey);
  } catch { /* @silent-fallback-ok: malformed activation or member receipt is rejected, never activates proposed membership */ return false; }
}
export function verifyAdoptionCertificate(certificate: GraphAdoptionCertificate, packet: GraphOperationPacket,
  previous: GraphMembershipEpoch, ownerPublicKey: crypto.KeyLike, witnessPublicKey: crypto.KeyLike): boolean {
  try {
    if (!exactFields(certificate, ['v','agentId','idempotencyKey','operationHash','originalMembershipHash','newMembership','currentLease','originalCurrentLease','ownerAuthorization','revalidation','rewrapHash','membershipChain','disposition','witnessId','adoptedAt','signature', ...(certificate.activation ? ['activation'] : []),...(certificate.erasedControlHash===undefined?[]:['erasedControlHash'])])
      || certificate.v !== 1 || certificate.agentId !== packet.agentId || certificate.idempotencyKey !== packet.idempotencyKey
      || certificate.operationHash !== canonicalHash(packet) || certificate.originalMembershipHash !== canonicalHash(previous)
      || certificate.witnessId !== certificate.newMembership.witnessId || !iso(certificate.adoptedAt)
      || !Array.isArray(certificate.membershipChain) || certificate.membershipChain.length < 1 || certificate.membershipChain.length > 128
      || canonicalHash(certificate.membershipChain[0]) !== canonicalHash(previous)
      || canonicalHash(certificate.membershipChain.at(-1)) !== canonicalHash(certificate.newMembership)
      || !verifyFencedLeaseBridge(certificate.currentLease, certificate.originalCurrentLease, certificate.newMembership)
      || !verifyPendingRevalidation(certificate.revalidation, packet, certificate.newMembership, certificate.currentLease)
      || !hash(certificate.rewrapHash) || certificate.rewrapHash !== certificate.revalidation.rewrapHash) return false;
    for (let i = 0; i < certificate.membershipChain.length; i++) {
      const epoch = certificate.membershipChain[i];
      if (!verifyMembershipEpoch(epoch, ownerPublicKey) || epoch.agentId !== packet.agentId
        || (i > 0 && (epoch.epoch !== certificate.membershipChain[i - 1].epoch + 1 || epoch.previousMembershipHash !== canonicalHash(certificate.membershipChain[i - 1])))) return false;
    }
    const erasedTerminal=certificate.erasedControlHash!==undefined;
    if(erasedTerminal&&(!hash(certificate.erasedControlHash)||certificate.ownerAuthorization!==null||certificate.disposition!=='refused'||certificate.revalidation.decision!=='refuse'||certificate.revalidation.reason!=='erased-source'||certificate.rewrapHash!==canonicalHash(null)))return false;
    if (certificate.ownerAuthorization) {
      if (certificate.membershipChain.length < 2 || certificate.currentLease.leaseEpoch !== certificate.ownerAuthorization.fenceEpoch
        || !verifyRecoveryAuthorization(certificate.ownerAuthorization, certificate.membershipChain.at(-2)!, certificate.newMembership, ownerPublicKey)) return false;
      const outcome = certificate.ownerAuthorization.pendingOutcomes.find((o) => o.idempotencyKey === packet.idempotencyKey);
      if (!outcome || outcome.operationHash !== canonicalHash(packet) || outcome.revalidationHash !== canonicalHash(certificate.revalidation)
        || outcome.decision !== certificate.revalidation.decision) return false;
    }
    if (certificate.membershipChain.length > 1) {
      const activation = certificate.activation;
      if (!activation || !verifyMembershipActivation(activation, ownerPublicKey, witnessPublicKey)
        || canonicalHash(activation.newMembership) !== canonicalHash(certificate.newMembership)
        || canonicalHash(activation.previousMembership) !== canonicalHash(certificate.membershipChain.at(-2))) return false;
      if(activation.memberLoss&&(certificate.disposition!=='refused'||certificate.revalidation.decision!=='refuse'))return false;
      const included = activation.ownerAuthorization.pendingOutcomes.find((o) => o.idempotencyKey === packet.idempotencyKey && o.operationHash === canonicalHash(packet));
      if (!included&&!erasedTerminal) return false;
      if (certificate.ownerAuthorization && canonicalHash(certificate.ownerAuthorization) !== canonicalHash(activation.ownerAuthorization)) return false;
    }
    if (certificate.disposition !== (certificate.revalidation.decision === 'adopt' ? 'adopted' : 'refused')) return false;
    if ((certificate.disposition === 'refused') !== (certificate.rewrapHash === canonicalHash(null))) return false;
    return verifyGraphRecord(GRAPH_SIGNATURE_DOMAINS.adoption, unsigned(certificate), certificate.signature, witnessPublicKey);
  } catch { /* @silent-fallback-ok: malformed adoption evidence is rejected, never makes pending intent canonical */ return false; }
}
export function validatePacket(packet: GraphOperationPacket): boolean {
  return !!packet && Object.keys(packet).sort().join(',') === ['coreType','erasureIdentity','agentId','eventId','idempotencyKey','coreHash','authorizationReceiptHash','controlHash','sourceSequence','predecessorHash','membershipEpoch','leaseEpoch','writerId','sourceBundleHash'].sort().join(',')
    && validateGraphErasureIdentity(packet.erasureIdentity) && opaque(packet.agentId) && validGraphOperationKey(packet.coreType,packet.eventId) && opaque(packet.idempotencyKey)
    && hash(packet.coreHash) && hash(packet.authorizationReceiptHash) && hash(packet.controlHash) && hash(packet.sourceBundleHash)
    && positive(packet.sourceSequence) && positive(packet.membershipEpoch) && packet.membershipEpoch<=GRAPH_REPLICATION_MAX_MEMBERSHIP_EPOCH && positive(packet.leaseEpoch) && packet.leaseEpoch <= GRAPH_REPLICATION_MAX_LEASE_EPOCH
    && opaque(packet.writerId) && (packet.predecessorHash === null || hash(packet.predecessorHash));
}
export function opaque(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(value); }
export function hash(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value); }
export function positive(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }
export function iso(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
}

/** Fresh, challenge-bound full witness inventory; never a cached readiness grant. */
export interface GraphWitnessInventoryCheckpoint {
  v: 1; agentId: string; witnessId: string; challenge: string; activeMembershipHash: string; membershipEpoch: number;
  fenceEpoch: number; manifest: GraphRecoverySourceManifest; manifestHash: string;
  erasures: GraphWitnessErasure[]; erasureInventoryHash: string; issuedAt: string; signature: string;
}
export function verifyWitnessInventory(checkpoint: GraphWitnessInventoryCheckpoint, challenge: string, agentId: string, witnessId: string, publicKey: string, historicalWitnessPublicKeys:Record<string,string> = {}): boolean {
  try {
    if (!exactFields(checkpoint, ['v','agentId','witnessId','challenge','activeMembershipHash','membershipEpoch','fenceEpoch','manifest','manifestHash','erasures','erasureInventoryHash','issuedAt','signature'])
      || checkpoint.v !== 1 || checkpoint.agentId !== agentId || checkpoint.witnessId !== witnessId || checkpoint.challenge !== challenge
      || !/^[A-Za-z0-9_-]{32,128}$/.test(challenge) || !hash(checkpoint.activeMembershipHash) || !positive(checkpoint.membershipEpoch)
      || !Number.isSafeInteger(checkpoint.fenceEpoch) || checkpoint.fenceEpoch < 0 || !iso(checkpoint.issuedAt)
      || !validateRecoverySourceManifest(checkpoint.manifest) || checkpoint.manifest.agentId !== agentId
      || checkpoint.manifest.membershipHash !== checkpoint.activeMembershipHash || canonicalHash(checkpoint.manifest) !== checkpoint.manifestHash
      || !Array.isArray(checkpoint.erasures) || checkpoint.erasures.length > 20000 || canonicalHash(checkpoint.erasures) !== checkpoint.erasureInventoryHash) return false;
    const hashes = checkpoint.erasures.map(e => e.requestId);
    if (new Set(hashes).size !== hashes.length || hashes.some((h,i) => i > 0 && hashes[i-1] >= h)) return false;
    for (const proof of checkpoint.erasures) { const key=proof.witnessId===witnessId?publicKey:historicalWitnessPublicKeys[proof.witnessId]; if (proof.agentId !== agentId || !key || !verifyWitnessErasure(proof, key)) return false; }
    return verifyGraphRecord('graph-inventory-v1', unsigned(checkpoint), checkpoint.signature, publicKey);
  } catch { /* @silent-fallback-ok: malformed signed checkpoint is rejected, never grants restored readiness */ return false; }
}

/** Attested by a separately pinned infrastructure auditor after provider reads.
 * evidenceHash addresses the sealed provider response artifact, not content. */
export interface GraphBackupErasureAttestation {
 v:1; agentId:string; witnessId:string; failureDomain:string; requestId:string; erasureHash:string;
 policy:'no-retained-copies'|'copies-purged'; providerResourceHash:string; evidenceHash:string;
 checkedAt:string; expiresAt:string; signature:string;
}
export function verifyBackupErasureAttestation(proof:GraphBackupErasureAttestation, erasure:GraphWitnessErasure, failureDomain:string, auditorPublicKey:crypto.KeyLike, now:number):boolean {
 try {
  return exactFields(proof,['v','agentId','witnessId','failureDomain','requestId','erasureHash','policy','providerResourceHash','evidenceHash','checkedAt','expiresAt','signature'])
   && proof.v===1 && proof.agentId===erasure.agentId && proof.witnessId===erasure.witnessId && proof.failureDomain===failureDomain
   && proof.requestId===erasure.requestId && proof.erasureHash===canonicalHash(erasure)
   && ['no-retained-copies','copies-purged'].includes(proof.policy) && hash(proof.providerResourceHash) && hash(proof.evidenceHash)
   && iso(proof.checkedAt) && iso(proof.expiresAt) && Date.parse(proof.checkedAt)>=Date.parse(erasure.erasedAt)
   && Date.parse(proof.checkedAt)<=now && Date.parse(proof.expiresAt)>now
   && Date.parse(proof.expiresAt)-Date.parse(proof.checkedAt)<=86400000
   && verifyGraphRecord('graph-backup-erasure-v1',unsigned(proof),proof.signature,auditorPublicKey);
 } catch { /* @silent-fallback-ok: malformed auditor evidence fails verification, never proves backup deletion */ return false; }
}

/** Exact ciphertext-only ingress schema. This proves shape, never decryption. */
export function verifyEncryptedBundle(raw:unknown,membership:Pick<GraphMembershipEpoch,'members'>):raw is GraphEncryptedBundle {
 try {
  const bundle=raw as GraphEncryptedBundle;
  const base64=(value:unknown,max:number,exact?:number)=>typeof value==='string'&&value.length<=max&&/^[A-Za-z0-9_-]*$/.test(value)
   &&Buffer.from(value,'base64url').toString('base64url')===value&&(exact===undefined||Buffer.from(value,'base64url').length===exact);
  if(!exactFields(bundle,['algorithm','ciphertext','envelopes','nonce','tag','v'])||bundle.v!==1||bundle.algorithm!=='aes-256-gcm+x25519-hkdf-sha256'
   ||!base64(bundle.nonce,16,12)||!base64(bundle.tag,22,16)||!base64(bundle.ciphertext,2*1024*1024)||!Array.isArray(bundle.envelopes)||bundle.envelopes.length!==membership.members.length)return false;
  const seen=new Set<string>();
  for(const envelope of bundle.envelopes){
   if(!exactFields(envelope,['ciphertext','ephemeralPublicKey','machineId','nonce','tag'])||!membership.members.some(m=>m.machineId===envelope.machineId)||seen.has(envelope.machineId)
    ||!base64(envelope.nonce,16,12)||!base64(envelope.tag,22,16)||!base64(envelope.ciphertext,43,32)||!canonicalPublicKey(envelope.ephemeralPublicKey,'x25519'))return false;
   seen.add(envelope.machineId);
  }
  return true;
 }catch { /* @silent-fallback-ok: malformed ciphertext envelope is rejected, never substituted with plaintext or empty source */ return false; }
}
