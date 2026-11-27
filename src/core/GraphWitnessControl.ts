/** Permanent opaque semantic custody. Application bytes and all key material
 * belong exclusively to erasable ciphertext, never this signed control. */
import type crypto from 'node:crypto';
import {canonicalHash,canonicalJson,exactFields,erasureCoversPacket,positive,unsigned,iso,verifyGraphRecord,GRAPH_SIGNATURE_DOMAINS as D,type GraphWitnessPrepareProof,type GraphWitnessErasedControlProof,type GraphWitnessErasure,type GraphCoreType,type GraphOperationPacket} from './GraphWitnessTypes.js';
import {validateGraphOperationCore} from './ConversationGraphOperation.js';
import {verifyGraphAuthorization,type GraphAuthorizationProof} from './ConversationGraphReplicationProof.js';
export interface GraphControlCapsule {v:1;coreType:GraphCoreType;core:Record<string,unknown>;authorizationProof:GraphAuthorizationProof}
export const GRAPH_CONTROL_MAX_BYTES=65536;
export function createGraphControlCapsule(coreType:GraphCoreType,core:Record<string,unknown>,authorizationProof:GraphAuthorizationProof):GraphControlCapsule{
 const value:GraphControlCapsule={v:1,coreType,core,authorizationProof};
 if(!validateGraphOperationCore(coreType,core)||Buffer.byteLength(canonicalJson(value))>GRAPH_CONTROL_MAX_BYTES)throw new Error('graph-control-schema-invalid');
 return structuredClone(value);
}
/** Historical authority verifiers enforce exact recursive schemas for receipt,
 * owner membership/native lease, and typed local/remote dispatch/source proofs.
 * A correctly signed extra transcript/key field is still rejected. */
export function verifyGraphControlCapsule(raw:unknown,packet:GraphOperationPacket,ownerPublicKey:crypto.KeyLike):raw is GraphControlCapsule{
 try{if(!raw||typeof raw!=='object'||Array.isArray(raw)||!exactFields(raw,['v','coreType','core','authorizationProof']))return false;
 const value=raw as GraphControlCapsule;
 return value.v===1&&value.coreType===packet.coreType&&Buffer.byteLength(canonicalJson(value))<=GRAPH_CONTROL_MAX_BYTES
  &&canonicalHash(value)===packet.controlHash&&!!validateGraphOperationCore(value.coreType,value.core)
  &&verifyGraphAuthorization(packet,value.core,value.authorizationProof,ownerPublicKey,packet.writerId).ok;
 }catch{/* @silent-fallback-ok — malformed or mismatched signed control/custody evidence is rejected, never substituted as authority. */return false;}
}

export function verifyGraphWitnessCustody(prepared:GraphWitnessPrepareProof|null,erased:GraphWitnessErasedControlProof|null,packet:GraphOperationPacket,witnessId:string,key:crypto.KeyLike,erasure:GraphWitnessErasure|null):boolean {
 try{
  if(!!prepared===!!erased)return false;
  if(prepared)return exactFields(prepared,['v','agentId','eventId','operationHash','membershipEpoch','leaseEpoch','witnessId','preparedAt','signature'])&&prepared.v===1&&prepared.agentId===packet.agentId&&prepared.eventId===packet.eventId&&prepared.operationHash===canonicalHash(packet)&&prepared.membershipEpoch===packet.membershipEpoch&&prepared.leaseEpoch===packet.leaseEpoch&&prepared.witnessId===witnessId&&iso(prepared.preparedAt)&&verifyGraphRecord(D.prepare,unsigned(prepared),prepared.signature,key);
  return !!erased&&!!erasure&&erasureCoversPacket(erasure,packet)&&exactFields(erased,['v','agentId','eventId','operationHash','membershipEpoch','custodyMembershipEpoch','leaseEpoch','witnessId','targetHash','recordedAt','signature'])&&erased.v===1&&erased.agentId===packet.agentId&&erased.eventId===packet.eventId&&erased.operationHash===canonicalHash(packet)&&erased.membershipEpoch===packet.membershipEpoch&&positive(erased.custodyMembershipEpoch)&&erased.custodyMembershipEpoch>=packet.membershipEpoch&&erased.leaseEpoch===packet.leaseEpoch&&erased.witnessId===witnessId&&erased.targetHash===canonicalHash(packet.erasureIdentity)&&iso(erased.recordedAt)&&verifyGraphRecord(D.erasedControl,unsigned(erased),erased.signature,key);
 }catch{/* @silent-fallback-ok — malformed or mismatched signed control/custody evidence is rejected, never substituted as authority. */return false;}
}
