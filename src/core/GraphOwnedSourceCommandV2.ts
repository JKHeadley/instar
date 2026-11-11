/** Explicitly NEW ephemeral transport identity. Never reinterpret a v1 hash.
 * Source/owner/ACT authority still comes from the unchanged signed originals
 * and actual held locator capability, not this metadata codec. */
import {canonicalHash,exactFields,hash,opaque,positive} from './GraphWitnessTypes.js';
import {GRAPH_REPLICATION_MAX_LEASE_EPOCH} from './ConversationGraphReplicationLimits.js';
import {GRAPH_CONTEXT_MAX_BYTES} from './ConversationGraphMaterializationContexts.js';
import {assertGraphOwnedOpaqueMetadata} from './GraphOwnedControlMetadataFrames.js';
export const GRAPH_OWNED_SOURCE_COMMAND_V2='graph-owned-source-command-v2';
export const GRAPH_OWNED_SOURCE_WORK_V2='graph-owned-source-work-v2';
export interface GraphOwnedSourceRowRefV2 {eventId:string;sourceSequence:number;packetHash:string;sourceProofHash:string;recordTransportHash:string;newRewrapHash:string;contextHash:string|null}
export interface GraphOwnedSourceContextRefV2 {contextHash:string;bytes:number}
export interface GraphOwnedSourceCommandV2 {
 v:2;kind:typeof GRAPH_OWNED_SOURCE_COMMAND_V2;agentId:string;sender:string;target:string;
 action:'stage'|'pin'|'recover'|'bootstrap';membershipHash:string;nativeHolder:string;nativeEpoch:number;
 ownerIntentHash:string;sourceManifestHash:string;rewrapInventoryHash:string;
 body:Record<string,unknown>;rows:GraphOwnedSourceRowRefV2[];contexts:GraphOwnedSourceContextRefV2[];
}
export function validateGraphOwnedSourceCommandV2(raw:unknown):raw is GraphOwnedSourceCommandV2{
 try{const c=raw as GraphOwnedSourceCommandV2;if(!c||!exactFields(c,['v','kind','agentId','sender','target','action','membershipHash','nativeHolder','nativeEpoch','ownerIntentHash','sourceManifestHash','rewrapInventoryHash','body','rows','contexts'])||c.v!==2||c.kind!==GRAPH_OWNED_SOURCE_COMMAND_V2||![c.agentId,c.sender,c.target,c.nativeHolder].every(opaque)||c.sender!==c.nativeHolder||!['stage','pin','recover','bootstrap'].includes(c.action)||![c.membershipHash,c.ownerIntentHash,c.sourceManifestHash,c.rewrapInventoryHash].every(hash)||!positive(c.nativeEpoch)||c.nativeEpoch>GRAPH_REPLICATION_MAX_LEASE_EPOCH||!c.body||typeof c.body!=='object'||Array.isArray(c.body)||c.body.kind!==c.action||!Array.isArray(c.rows)||c.rows.length>20000||!Array.isArray(c.contexts)||c.contexts.length>128)return false;
  const contexts=new Set<string>();for(const ref of c.contexts){if(!exactFields(ref,['contextHash','bytes'])||!hash(ref.contextHash)||!Number.isSafeInteger(ref.bytes)||ref.bytes<1||ref.bytes>GRAPH_CONTEXT_MAX_BYTES||contexts.has(ref.contextHash))return false;contexts.add(ref.contextHash);}
  const ids=new Set<string>();let sequence=0;for(const row of c.rows){if(!exactFields(row,['eventId','sourceSequence','packetHash','sourceProofHash','recordTransportHash','newRewrapHash','contextHash'])||!opaque(row.eventId)||ids.has(row.eventId)||!positive(row.sourceSequence)||row.sourceSequence<=sequence||![row.packetHash,row.sourceProofHash,row.recordTransportHash,row.newRewrapHash].every(hash)||row.contextHash!==null&&(!hash(row.contextHash)||!contexts.has(row.contextHash)))return false;ids.add(row.eventId);sequence=row.sourceSequence;}
  assertGraphOwnedOpaqueMetadata(c.body);return true;
 }catch{return false;}
}
export function graphOwnedSourceCommandHashV2(command:GraphOwnedSourceCommandV2):string{if(!validateGraphOwnedSourceCommandV2(command))throw new Error('graph-owned-source-v2-invalid');return canonicalHash({domain:GRAPH_OWNED_SOURCE_COMMAND_V2,command});}
export function graphOwnedSourceWorkIdV2(command:GraphOwnedSourceCommandV2):string{return canonicalHash({domain:GRAPH_OWNED_SOURCE_WORK_V2,agentId:command.agentId,sender:command.sender,target:command.target,action:command.action,requestHash:graphOwnedSourceCommandHashV2(command)});}
