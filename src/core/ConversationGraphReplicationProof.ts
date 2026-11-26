/** Historical authorization verification for graph source replication.
 * Spec: conversation-effort-hierarchy-v3 §7.2. This verifies the original
 * installed FencedLease; a new graph lease is never a substitute authority.
 */
import type crypto from 'node:crypto';
import type { LeaseRecord } from './types.js';
import {
  canonicalHash, sameGraphErasureIdentity, iso, opaque, signGraphRecord, unsigned, verifyGraphRecord,
  validatePacket, graphOperationKey, verifyFencedLeaseBridge, verifyMembershipEpoch,
  type GraphMembershipEpoch, type GraphOperationPacket, type GraphWitnessLease,
} from './GraphWitnessTypes.js';
import {deriveGraphErasureIdentity} from './ConversationGraphOperation.js';
import {verifyGraphSourceObservationCoreSource,type SignedGraphSourceOperation} from './ConversationGraphSourceInventory.js';
import { verifyGraphDelegationCoreSource, type SignedGraphDelegationSource } from './ConversationGraphDelegation.js';
import { verifyRemoteGraphDelegationCoreSource, type SignedRemoteGraphDelegationSource } from './ConversationGraphDelegationRemote.js';

export const GRAPH_AUTHORIZATION_DOMAIN = 'graph-authorization-receipt-v1';
export type GraphAuthenticationMethod = 'owner-device' | 'owner-dashboard' | 'owner-callback' | 'dispatch' | 'source-observation';

export interface GraphAuthorizationReceipt {
  v: 1; agentId: string; eventId: string; coreHash: string;
  actorPrincipal: string; authenticationMethod: GraphAuthenticationMethod;
  receiptId: string;
  membershipEpoch: number; leaseEpoch: number; idempotencyKey: string;
  writerId: string; fencedLeaseHash: string; acceptedAt: string; signature: string;
}
export interface GraphAuthorizationProof {
  receipt: GraphAuthorizationReceipt;
  membership: GraphMembershipEpoch;
  lease: GraphWitnessLease;
  originalLease: LeaseRecord;
  sourceObservation?: SignedGraphSourceOperation;
  dispatchSource?: SignedGraphDelegationSource | SignedRemoteGraphDelegationSource;
}
export type GraphProofVerdict = { ok: true } | { ok: false; reason: string };

export function signGraphAuthorizationReceipt(receipt: Omit<GraphAuthorizationReceipt, 'signature'>,
  privateKey: crypto.KeyLike): GraphAuthorizationReceipt {
  return { ...receipt, signature: signGraphRecord(GRAPH_AUTHORIZATION_DOMAIN, receipt, privateKey) };
}

/** Pure historical verification. No current clock/epoch is consulted: a valid
 * delayed old-epoch record remains valid after failover. NEW writes separately
 * require the live WriteAdmission/LeaseCoordinator check at the store seam. */
export function verifyGraphAuthorization(packet: GraphOperationPacket, core: unknown,
  proof: GraphAuthorizationProof, ownerPublicKey: crypto.KeyLike, envelopeOrigin: string): GraphProofVerdict {
  try {
    if (!validatePacket(packet) || !core || typeof core !== 'object' || Array.isArray(core)) return denied('malformed-core');
    const c = core as Record<string, unknown>;
    if(!sameGraphErasureIdentity(packet.erasureIdentity,deriveGraphErasureIdentity(packet.coreType,core)))return denied('erasure-identity-core-mismatch');
    if(packet.controlHash!==canonicalHash({v:1,coreType:packet.coreType,core,authorizationProof:proof}))return denied('control-capsule-mismatch');
    const r = proof?.receipt;
    if (!proof || Object.keys(proof).some((key) => !['receipt', 'membership', 'lease', 'originalLease', 'dispatchSource', 'sourceObservation'].includes(key))) return denied('malformed-proof');
    if (!r || r.v !== 1 || !opaque(r.actorPrincipal) || !opaque(r.receiptId) || !iso(r.acceptedAt)
      || !['owner-device', 'owner-dashboard', 'owner-callback', 'dispatch', 'source-observation'].includes(r.authenticationMethod)) return denied('malformed-authorization');
    if (Object.keys(r).sort().join(',') !== ['v', 'agentId', 'eventId', 'coreHash', 'actorPrincipal', 'authenticationMethod',
      'receiptId', 'membershipEpoch', 'leaseEpoch', 'idempotencyKey', 'writerId', 'fencedLeaseHash', 'acceptedAt', 'signature'].sort().join(',')) return denied('malformed-authorization');
    const ref = c.receipt as { kind?: unknown; id?: unknown } | undefined;
    if (packet.coreHash !== canonicalHash(core) || packet.eventId !== graphOperationKey(packet.coreType,(packet.coreType==='header-op'?c.opId:c.eventId) as string)
      || packet.authorizationReceiptHash !== canonicalHash(r) || c.principal !== r.actorPrincipal
      || c.machineId !== r.writerId || ref?.id !== r.receiptId) return denied('core-receipt-mismatch');
    if (r.authenticationMethod === 'dispatch'
      ? packet.coreType!=='graph-event'||c.authority !== 'delegation' || ref?.kind !== 'dispatch-record'
      : r.authenticationMethod==='source-observation'?packet.coreType!=='source-observation'||c.authority!=='source'||ref?.kind!=='source-observation-record'
      : packet.coreType==='source-observation'||c.authority !== 'owner' || ref?.kind !== 'owner-proof') return denied('receipt-authority-mismatch');
    if (r.agentId !== packet.agentId || r.eventId !== packet.eventId || r.coreHash !== packet.coreHash
      || r.idempotencyKey !== packet.idempotencyKey || r.membershipEpoch !== packet.membershipEpoch
      || r.leaseEpoch !== packet.leaseEpoch || r.writerId !== packet.writerId || envelopeOrigin !== packet.writerId) return denied('origin-receipt-mismatch');
    if (!verifyMembershipEpoch(proof.membership, ownerPublicKey) || proof.membership.agentId !== packet.agentId
      || proof.membership.epoch !== packet.membershipEpoch) return denied('membership-invalid');
    const member = proof.membership.members.find((m) => m.machineId === packet.writerId);
    if (!member || proof.lease.writerId !== packet.writerId || proof.lease.leaseEpoch !== packet.leaseEpoch
      || r.fencedLeaseHash !== proof.lease.fencedLeaseHash
      || !verifyFencedLeaseBridge(proof.lease, proof.originalLease, proof.membership)) return denied('historical-lease-invalid');
    const accepted = Date.parse(r.acceptedAt);
    if (accepted < Date.parse(proof.originalLease.acquiredAt) || accepted >= Date.parse(proof.originalLease.expiresAt)) return denied('receipt-outside-lease');
    if (!verifyGraphRecord(GRAPH_AUTHORIZATION_DOMAIN, unsigned(r), r.signature, member.signingPublicKey)) return denied('authorization-signature-invalid');
    if(r.authenticationMethod!=='source-observation'&&proof.sourceObservation!==undefined)return denied('unexpected-source-observation');
    if(r.authenticationMethod==='source-observation'&&(!proof.sourceObservation||!verifyGraphSourceObservationCoreSource(core,proof.sourceObservation,proof.membership,packet.writerId)))return denied('source-observation-invalid');
    if (r.authenticationMethod !== 'dispatch' && proof.dispatchSource !== undefined) return denied('unexpected-dispatch-source');
    if (r.authenticationMethod === 'dispatch') {
      const source = proof.dispatchSource;
      const valid = source?.kind === 'remote-delegation-source'
        ? verifyRemoteGraphDelegationCoreSource(core, source, proof.membership, packet.writerId)
        : !!source && verifyGraphDelegationCoreSource(core, source, member.signingPublicKey, packet.agentId, packet.writerId);
      if (!valid) return denied('dispatch-source-invalid');
    }
    return { ok: true };
  } catch { return denied('malformed-proof'); }
}

function denied(reason: string): GraphProofVerdict { return { ok: false, reason }; }
