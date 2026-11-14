/** Conversations v3 §7.2: current native writer revalidates a previously
 * accepted source observation. Historical producer membership stays frozen;
 * this operation never enters the placement reducer or grants owner authority.
 */
import crypto from 'node:crypto';
import {canonicalHash,signGraphRecord,GRAPH_SIGNATURE_DOMAINS as D,verifyMembershipEpoch,verifyFencedLeaseBridge,verifyWitnessLease,
 type GraphMembershipEpoch,type GraphWitnessLease,type GraphPendingRevalidation,type GraphBundleRewrap} from './GraphWitnessTypes.js';
import {validateGraphSourceOperationCore,validateGraphSourceObservationCore,verifyGraphSourceObservationCoreSource,validateGraphSourceObservationPlaintext,graphSourceObservationIsErased} from './ConversationGraphSourceInventory.js';
import {validateGraphSourceSweepCore,verifyGraphSourceSweepCoreSource,validateGraphSourceSweepPlaintext,validateGraphSourceSweepPayload} from './ConversationGraphSourceSweep.js';
import {nodeKey} from './conversationGraph.js';
import type {ConversationGraphReplication,ConversationGraphReplicationRecord,GraphLiveAdmission} from './ConversationGraphReplication.js';
import type {ReplicatedStoreReader} from './ReplicatedStoreReader.js';
import type {DroppedOriginRegistry} from './RollbackUnmerge.js';
import type {WriteAdmission} from './WriteAdmission.js';
import type {LeaseRecord} from './types.js';
export interface GraphSourceObservationRecoveryOptions {
 source:ConversationGraphReplication;reader:ReplicatedStoreReader;dropped:DroppedOriginRegistry;stateDir:string;
 machineId:string;signingPrivateKey:crypto.KeyLike;ownerPublicKey:crypto.KeyLike;writeAdmission:WriteAdmission;
 legacyReadOnly():boolean;liveAdmission():GraphLiveAdmission;
 actuation():{membership:GraphMembershipEpoch;lease:GraphWitnessLease;originalLease:LeaseRecord};now?:()=>number;
}
export type GraphSourceObservationRevalidation={state:'held';reason:string}|{state:'validated';proof:GraphPendingRevalidation;rewrap:GraphBundleRewrap|null};
export class GraphSourceObservationRecoveryCoordinator {
 constructor(private readonly options:GraphSourceObservationRecoveryOptions){}
 revalidate(eventId:string):GraphSourceObservationRevalidation {
  try{return this.validate(eventId);}catch{return {state:'held',reason:'observation-source-verification-unavailable'};}
 }
 private validate(eventId:string):GraphSourceObservationRevalidation {
  const o=this.options,now=o.now?.()??Date.now(),guard=o.writeAdmission.guardStoreWrite('conversationGraph.append');
  if(guard.enforce==='refuse'||(guard.enforce==='legacy'&&o.legacyReadOnly())||!o.writeAdmission.evaluate('cluster-shared').admit)return {state:'held',reason:'write-admission-refused'};
  const {membership,lease,originalLease}=o.actuation(),live=o.liveAdmission();
  if(!verifyMembershipEpoch(membership,o.ownerPublicKey)||lease.writerId!==o.machineId||!verifyFencedLeaseBridge(lease,originalLease,membership)||!verifyWitnessLease(lease,membership,now)
   ||!live.admitted||live.writerId!==o.machineId||live.leaseEpoch!==lease.leaseEpoch||live.membershipEpoch!==membership.epoch||live.fencedLeaseHash!==lease.fencedLeaseHash)return {state:'held',reason:'current-native-admission-invalid'};
  const member=membership.members.find(m=>m.machineId===o.machineId);const key=o.signingPrivateKey instanceof crypto.KeyObject?o.signingPrivateKey:crypto.createPrivateKey(o.signingPrivateKey);
  if(!member||crypto.createPublicKey(key).export({type:'spki',format:'pem'}).toString()!==member.signingPublicKey)return {state:'held',reason:'current-writer-key-mismatch'};
  const record=o.source.repairRecord(eventId);
  if(!record||record.coreType!=='source-observation'||!o.source.verifyHistoricalRecord(record))return {state:'held',reason:'verified-original-observation-unavailable'};
  if(record.certificate||record.cancellationCertificate)return {state:'held',reason:'terminal-operation-requires-repair'};
  if(record.erasure||record.cancellation||record.adoption?.disposition==='refused'){
   const operation=validateGraphSourceOperationCore(record.core),original=record.authorizationProof.sourceObservation;
   if(!operation||!original||!verifyGraphSourceObservationCoreSource(operation,original,record.authorizationProof.membership,record.packet.writerId))return {state:'held',reason:'original-source-control-invalid'};
   return this.proof(record,membership,lease,record.erasure?'erased-source':'operator-refused',[],{originalControlHash:record.packet.controlHash,previousDisposition:record.adoption?.disposition??null,erasureHash:record.erasure?canonicalHash(record.erasure):null,cancellationHash:record.cancellation?canonicalHash(record.cancellation):null},null,now);
  }
  if(record.authorizationProof.sourceObservation?.kind==='source-inventory-sweep')return this.sweep(record,membership,lease,now);
  const core=validateGraphSourceObservationCore(record.core),capture=record.authorizationProof.sourceObservation;
  if(!core||!capture||capture.kind!=='conversation-source-observation'||canonicalHash(core)!==record.packet.coreHash
   ||!verifyGraphSourceObservationCoreSource(core,capture,record.authorizationProof.membership,record.packet.writerId))return {state:'held',reason:'historical-source-observation-invalid'};
  // A current roster cannot revoke the historical fact that a now-decommissioned
  // producer supplied this already accepted source. Original proof verification
  // above uses its original owner-signed membership, not the current member list.
  if(record.erasure||graphSourceObservationIsErased(o.stateDir,record.packet.agentId,core.subject))return this.proof(record,membership,lease,'erased-source',[],{erasureHash:record.erasure?canonicalHash(record.erasure):null,localDenialFence:true},null,now);
  let bytes:Buffer;
  try{bytes=o.source.openVerifiedPayload(record);}catch{return {state:'held',reason:'original-observation-payload-unavailable'};}
  try{if(!validateGraphSourceObservationPlaintext(JSON.parse(bytes.toString('utf8')),capture))return {state:'held',reason:'original-observation-payload-invalid'};}
  finally{bytes.fill(0);}
  const expectedPending=new Set<string>();
  for(const pending of o.source.recordsForRepair())if(o.source.verifyHistoricalRecord(pending)&&!pending.certificate&&!pending.cancellationCertificate&&!pending.cancellation&&!pending.erasure)expectedPending.add(pending.packet.eventId);
  const union=o.source.certifiedUnion(o.reader,o.dropped,expectedPending);
  if(union.partial||union.quarantined.length)return {state:'held',reason:'certified-source-inventory-incomplete'};
  const references:Array<{eventId:string;coreHash:string;payloadHash:string;capturedAt:string;erased:boolean}>=[];
  let reason:GraphPendingRevalidation['reason']='ok';
  for(const known of union.records){
   if(known.coreType!=='source-observation')continue;
   const k=validateGraphSourceObservationCore(known.core),c=known.authorizationProof.sourceObservation;
   if(!k)continue;
   if(!c||c.kind!=='conversation-source-observation'||!o.source.verifyHistoricalRecord(known))return {state:'held',reason:'certified-source-observation-invalid'};
   if(nodeKey(k.subject)!==nodeKey(core.subject)||c.producerMachineId!==capture.producerMachineId)continue;
   if(c.producerSequence===capture.producerSequence&&(c.sourceId!==capture.sourceId||c.payloadHash!==capture.payloadHash))return this.proof(record,membership,lease,'source-invalid',[],{equivocation:true},null,now);
   references.push({eventId:known.packet.eventId,coreHash:known.packet.coreHash,payloadHash:c.payloadHash,capturedAt:c.capturedAt,erased:!!known.erasure});
   if(known.erasure)reason='erased-source';
   else if(c.producerMachineId===capture.producerMachineId&&c.producerSequence>capture.producerSequence&&reason==='ok')reason='stale-heads';
  }
  references.sort((a,b)=>a.eventId<b.eventId?-1:a.eventId>b.eventId?1:0);
  const heads=references.map(r=>r.eventId);
  if(reason!=='ok')return this.proof(record,membership,lease,reason,heads,{references},null,now);
  let rewrap:GraphBundleRewrap;
  try{rewrap=o.source.rewrapVerifiedPayload(record,membership,o.machineId,o.signingPrivateKey,new Date(now).toISOString());}
  catch{return {state:'held',reason:'original-observation-rewrap-unavailable'};}
  return this.proof(record,membership,lease,'ok',heads,{references},rewrap,now);
 }
 private sweep(record:ConversationGraphReplicationRecord,membership:GraphMembershipEpoch,lease:GraphWitnessLease,now:number):GraphSourceObservationRevalidation {
  const o=this.options,core=validateGraphSourceSweepCore(record.core),capture=record.authorizationProof.sourceObservation;
  if(!core||capture?.kind!=='source-inventory-sweep'||!verifyGraphSourceSweepCoreSource(core,capture,record.authorizationProof.membership,record.packet.writerId))return {state:'held',reason:'historical-checkpoint-invalid'};
  if(record.erasure)return this.proof(record,membership,lease,'erased-source',[],{erasureHash:canonicalHash(record.erasure)},null,now);
  let payload:ReturnType<typeof validateGraphSourceSweepPayload>=null;
  try{const bytes=o.source.openVerifiedPayload(record);try{const body=JSON.parse(bytes.toString('utf8'));if(validateGraphSourceSweepPlaintext(body,capture))payload=validateGraphSourceSweepPayload(body.payload);}finally{bytes.fill(0);}}catch{return {state:'held',reason:'checkpoint-payload-unavailable'};}
  if(!payload)return {state:'held',reason:'checkpoint-payload-invalid'};
  const pending=new Set(o.source.recordsForRepair().filter(r=>o.source.verifyHistoricalRecord(r)&&!r.certificate&&!r.cancellationCertificate&&!r.erasure).map(r=>r.packet.eventId));
  const union=o.source.certifiedUnion(o.reader,o.dropped,pending);if(union.partial||union.quarantined.length)return {state:'held',reason:'certified-checkpoint-dependencies-incomplete'};
  const heads:string[]=[];let reason:GraphPendingRevalidation['reason']='ok';
  for(const known of union.records){const c=known.authorizationProof.sourceObservation;if(known.coreType!=='source-observation'||!c)continue;
   if(c.kind==='source-inventory-sweep'&&c.producerMachineId===capture.producerMachineId&&Date.parse(c.completedAt)>Date.parse(capture.completedAt)){heads.push(known.packet.eventId);reason='stale-heads';}
  }
  for(const entry of payload.entries){if(entry.state!=='observed')continue;
   const known=union.records.find(r=>r.authorizationProof.sourceObservation?.sourceId===entry.sourceId),c=known?.authorizationProof.sourceObservation;
   if(graphSourceObservationIsErased(o.stateDir,record.packet.agentId,entry.ref)||known?.erasure){reason='erased-source';continue;}
   if(!known||c?.kind!=='conversation-source-observation'||c.producerMachineId!==capture.producerMachineId||c.payloadHash!==entry.payloadHash||nodeKey(c.subject)!==nodeKey(entry.ref)||!o.source.verifyHistoricalRecord(known))return {state:'held',reason:'certified-checkpoint-row-unavailable'};
   heads.push(known.packet.eventId);try{const bytes=o.source.openVerifiedPayload(known);bytes.fill(0);}catch{return {state:'held',reason:'certified-checkpoint-row-unreadable'};}
   if(union.records.some(r=>{const newer=r.authorizationProof.sourceObservation;return newer?.kind==='conversation-source-observation'&&newer.producerMachineId===capture.producerMachineId&&nodeKey(newer.subject)===nodeKey(entry.ref)&&newer.producerSequence>c.producerSequence;}))reason='stale-heads';
  }
  heads.sort();if(reason!=='ok')return this.proof(record,membership,lease,reason,heads,{inventoryHash:capture.inventoryHash,heads},null,now);
  let rewrap:GraphBundleRewrap;try{rewrap=o.source.rewrapVerifiedPayload(record,membership,o.machineId,o.signingPrivateKey,new Date(now).toISOString());}catch{return {state:'held',reason:'checkpoint-rewrap-unavailable'};}
  return this.proof(record,membership,lease,'ok',heads,{inventoryHash:capture.inventoryHash,heads},rewrap,now);
 }
 private proof(record:ConversationGraphReplicationRecord,membership:GraphMembershipEpoch,lease:GraphWitnessLease,reason:GraphPendingRevalidation['reason'],heads:string[],dependencies:unknown,rewrap:GraphBundleRewrap|null,now:number):GraphSourceObservationRevalidation {
  const {coreType,packet,packetSignature,core,authorizationProof}=record;
  const value={v:1 as const,agentId:packet.agentId,idempotencyKey:packet.idempotencyKey,operationHash:canonicalHash(packet),coreHash:packet.coreHash,
   sourceProofHash:canonicalHash({coreType,packet,packetSignature,core,authorizationProof}),subjectHeadsHash:canonicalHash(heads),dependenciesHash:canonicalHash(dependencies),
   rewrapHash:canonicalHash(rewrap),newMembershipHash:canonicalHash(membership),currentLeaseHash:canonicalHash(lease),writerId:this.options.machineId,
   decision:reason==='ok'?'adopt' as const:'refuse' as const,reason,validatedAt:new Date(now).toISOString()};
  return {state:'validated',proof:{...value,signature:signGraphRecord(D.revalidation,value,this.options.signingPrivateKey)},rewrap};
 }
}
