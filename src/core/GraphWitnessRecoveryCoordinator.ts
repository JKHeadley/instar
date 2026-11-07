/** Actual-source pending revalidation. No wire-supplied heads, dependencies or
 * success booleans can authorize adoption. Spec v3 §7.2 recovery ceremony. */
import crypto from 'node:crypto';
import {type ConversationGraphReplication,type ConversationGraphReplicationRecord,type GraphLiveAdmission} from './ConversationGraphReplication.js';
import type {ReplicatedStoreReader} from './ReplicatedStoreReader.js';
import type {DroppedOriginRegistry} from './RollbackUnmerge.js';
import type {WriteAdmission} from './WriteAdmission.js';
import type {ScopeVerifier} from './ScopeVerifier.js';
import type {LeaseRecord} from './types.js';
import {validateGraphEvent,reduceGraph,nodeKey,type GraphEvent,type NodeRef} from './conversationGraph.js';
import {validateHeaderOperation,deriveCertifiedHeaderMetadata,type HeaderOperation} from './EffortHeaderStore.js';
import {rewrapGraphBundle} from './GraphWitnessCrypto.js';
import {canonicalHash,signGraphRecord,GRAPH_SIGNATURE_DOMAINS as D,verifyMembershipEpoch,verifyFencedLeaseBridge,verifyWitnessLease,
 type GraphMembershipEpoch,type GraphWitnessLease,type GraphPendingRevalidation,type GraphBundleRewrap} from './GraphWitnessTypes.js';
export interface GraphRecoveryCoordinatorOptions {
 source:ConversationGraphReplication; reader:ReplicatedStoreReader; dropped: DroppedOriginRegistry;
 machineId:string; signingPrivateKey:crypto.KeyLike; sealingPrivateKey:crypto.KeyLike; ownerPublicKey:crypto.KeyLike;
 writeAdmission:WriteAdmission; legacyReadOnly():boolean; liveAdmission():GraphLiveAdmission;
 actuation():{membership:GraphMembershipEpoch;lease:GraphWitnessLease;originalLease:LeaseRecord};
 scopeVerifier:ScopeVerifier; telegramChatId:string; now?:()=>number;
}
export type GraphPendingValidationResult={state:'held';reason:string}|{state:'validated';proof:GraphPendingRevalidation;rewrap:GraphBundleRewrap|null};
function equalIds(a:string[],b:string[]):boolean{return canonicalHash([...a].sort())===canonicalHash([...b].sort());}
export class GraphWitnessRecoveryCoordinator {
 constructor(private readonly options:GraphRecoveryCoordinatorOptions){}
 revalidate(eventId:string):GraphPendingValidationResult {
  const o=this.options,now=o.now?.()??Date.now();const guard=o.writeAdmission.guardStoreWrite('conversationGraph.append');
  if(guard.enforce==='refuse'||(guard.enforce==='legacy'&&o.legacyReadOnly()))return {state:'held',reason:'write-admission-refused'};
  const {membership,lease,originalLease}=o.actuation();const live=o.liveAdmission();
  if(!verifyMembershipEpoch(membership,o.ownerPublicKey)||lease.writerId!==o.machineId||!verifyFencedLeaseBridge(lease,originalLease,membership)||!verifyWitnessLease(lease,membership,now)
   ||!live.admitted||live.writerId!==o.machineId||live.leaseEpoch!==lease.leaseEpoch||live.membershipEpoch!==membership.epoch||live.fencedLeaseHash!==lease.fencedLeaseHash)return {state:'held',reason:'current-native-admission-invalid'};
  const member=membership.members.find(m=>m.machineId===o.machineId);const key=o.signingPrivateKey instanceof crypto.KeyObject?o.signingPrivateKey:crypto.createPrivateKey(o.signingPrivateKey);
  if(!member||crypto.createPublicKey(key).export({type:'spki',format:'pem'}).toString()!==member.signingPublicKey)return {state:'held',reason:'current-writer-key-mismatch'};
  const record=o.source.repairRecord(eventId);
  if(!record||!o.source.verifyHistoricalRecord(record))return {state:'held',reason:'verified-original-source-unavailable'};
  if(record.certificate||record.cancellationCertificate)return {state:'held',reason:'terminal-operation-requires-repair'};
  if(record.erasure||record.cancellation||record.adoption?.disposition==='refused'){
   const decision=record.cancellation??record.erasure??record.adoption;
   return this.complete(record,{membership,lease,originalLease},now,record.erasure?'erased-source':'operator-refused',[],canonicalHash({terminalDecision:decision}));
  }
  // Expected Saving records are not certified graph state. Derive the exact
  // exclusion set from actual durable, verified local source inventory; never
  // accept a wire list that could hide a lost certificate or a malformed peer.
  // This also permits sequential recovery of several pending operations.
  const pendingIds=new Set<string>();
  for(const pending of o.source.recordsForRepair()){
    if(pending.packet.sourceSequence<record.packet.sourceSequence&&!pending.certificate&&!pending.cancellationCertificate)return {state:'held',reason:'earlier-source-intent-pending'};
    if(pending&&o.source.verifyHistoricalRecord(pending)&&!pending.certificate&&!pending.cancellationCertificate&&!pending.cancellation&&!pending.erasure)pendingIds.add(pending.packet.eventId);
  }
  const union=o.source.certifiedUnion(o.reader,o.dropped,pendingIds);
  const events:GraphEvent[]=[];
  for(const r of union.records){if(r.packet.coreType!=='graph-event')continue;const e=validateGraphEvent(r.core);if(!e||!o.source.verifyHistoricalRecord(r))return {state:'held',reason:'certified-core-invalid'};events.push(e);}
  if(union.partial||union.quarantined.length)return {state:'held',reason:'certified-dependency-inventory-incomplete'};
  const byId=new Map(events.map(e=>[e.eventId,e]));
  const reduced=reduceGraph(events,{verify:e=>{const r=union.records.find(r=>r.packet.coreType==='graph-event'&&r.core.eventId===e.eventId&&r.packet.coreHash===canonicalHash(e));return !!r&&o.source.verifyHistoricalRecord(r);}});
  if(reduced.partial.eventGap||reduced.partial.evidenceMissing)return {state:'held',reason:'certified-reducer-incomplete'};
  if(record.packet.coreType==='header-op'){
    const header=validateHeaderOperation(record.core);if(!header||canonicalHash(header)!==record.packet.coreHash)return {state:'held',reason:'actual-header-core-invalid'};
    const creators=events.filter(event=>event.op==='create-effort'&&event.headerId===header.headerId&&reduced.efforts.get(nodeKey(event.subject))?.headerId===header.headerId);
    if(creators.length!==1)return {state:'held',reason:creators.length?'header-creator-ambiguous':'header-creator-evidence-missing'};
    const headers:HeaderOperation[]=[];for(const entry of union.records){if(entry.packet.coreType!=='header-op')continue;const op=validateHeaderOperation(entry.core);if(!op)return {state:'held',reason:'certified-header-core-invalid'};if(op.headerId===header.headerId)headers.push(op);}
    let state:ReturnType<typeof deriveCertifiedHeaderMetadata>;try{state=deriveCertifiedHeaderMetadata(headers);}catch{return {state:'held',reason:'certified-header-state-conflict'};}
    if(state?.held.length)return {state:'held',reason:'header-version-evidence-incomplete'};
    const reason:GraphPendingRevalidation['reason']=record.erasure||state?.forgotten||!record.encryptedSourceBundle?'erased-source':header.kind==='set-effort-title'&&header.baseVersion!==(state?.version??0)?'stale-heads':'ok';
    const heads=headers.filter(op=>state?.forgotten?op.kind==='forget-header':op.kind==='set-effort-title'&&op.baseVersion===(state?.version??0)-1).map(op=>op.opId).sort();
    return this.complete(record,{membership,lease,originalLease},now,reason,heads,canonicalHash({creatorHash:canonicalHash(creators[0]),headerMetadata:state,operations:headers.map(op=>({opId:op.opId,hash:canonicalHash(op)})).sort((a,b)=>a.opId<b.opId?-1:a.opId>b.opId?1:0),graphRevision:reduced.revision}));
  }
  if(record.packet.coreType!=='graph-event')return {state:'held',reason:'core-type-revalidation-not-implemented'};
  const core=validateGraphEvent(record.core);if(!core||canonicalHash(core)!==record.packet.coreHash)return {state:'held',reason:'actual-core-invalid'};
  const heads=core.op==='create-effort'?events.filter(e=>e.op==='create-effort'&&nodeKey(e.subject)===nodeKey(core.subject)).map(e=>e.eventId).sort():((core.op==='set-primary-placement'?reduced.placementHeads:reduced.frontDoorHeads).get(nodeKey(core.subject))??[]);
  const dependencyIds=core.op==='set-primary-placement'?core.replacesPlacementEventIds:core.op==='set-front-door'?[...core.replacesFrontDoorEventIds,...core.observedPlacementEventIds]:[];
  let reason:GraphPendingRevalidation['reason']='ok';
  if(dependencyIds.some(id=>!byId.has(id)))reason='dependency-refused';
  if(core.op==='create-effort'&&heads.length)reason='stale-heads';
  if(core.op==='set-primary-placement'&&!equalIds(heads,core.replacesPlacementEventIds))reason='stale-heads';
  if(core.op==='set-front-door'&&(!equalIds(heads,core.replacesFrontDoorEventIds)||(core.frontDoor&&!equalIds((reduced.placementHeads.get(nodeKey(core.frontDoor))??[]),core.observedPlacementEventIds))))reason='stale-heads';
  // Resolve effort existence and nearest explicit project scope through the
  // actual certified tree, never through a proposed conversation binding.
  const dependencies=dependencyIds.map(id=>({eventId:id,hash:byId.has(id)?canonicalHash(byId.get(id)):null}));
  const bindingSnapshot=o.scopeVerifier.currentTopicBindings();
  let chatNeeded=false;const project=(ref:NodeRef):string|null|undefined=>{if(ref.kind==='effort')return null;if(!o.telegramChatId){chatNeeded=true;return undefined;}return ref.platform==='telegram'&&ref.chatId===o.telegramChatId?(bindingSnapshot[String(ref.topicId)]?.projectName??null):undefined;};
  const subjectProject=project(core.subject);
  if(subjectProject===undefined)reason='dependency-refused';
  const requireEffort=(ref:NodeRef)=>{if(ref.kind==='effort'&&!reduced.efforts.has(nodeKey(ref)))reason='dependency-refused';};
  if(core.op!=='create-effort')requireEffort(core.subject);
  if(core.op==='set-primary-placement'&&core.parent){
   requireEffort(core.parent);let cursor:NodeRef|null=core.parent;const seen=new Set<string>();
   while(cursor&&!seen.has(nodeKey(cursor))){const k=nodeKey(cursor);seen.add(k);
    if(cursor.kind==='effort'){const effort=reduced.efforts.get(k);if(!effort){reason='dependency-refused';break;}
     dependencies.push({eventId:`effort:${cursor.id}`,hash:canonicalHash(effort)});
     if(subjectProject!==undefined&&effort.projectScope.length&&((subjectProject===null&&core.authority!=='owner')||(subjectProject!==null&&!effort.projectScope.includes(subjectProject))))reason='dependency-refused';break;}
    if(project(cursor)===undefined)reason='dependency-refused';cursor=reduced.parentOf.get(k)??null;
   }
  }
  if(core.op==='set-front-door'&&core.frontDoor&&project(core.frontDoor)===undefined)reason='dependency-refused';
  const candidate=reduceGraph([...events,core],{verify:e=>e.eventId===core.eventId?o.source.verifyHistoricalRecord(record):byId.has(e.eventId)});
  if(candidate.setAside.some(e=>e.eventId===core.eventId)||candidate.conflicts.some(c=>c.heads.includes(core.eventId)))reason=reason==='ok'?'dependency-refused':reason;
  // With no chat configured a conversation cannot be checked. That may only be a config problem, and refusing would cancel the change for good, so it waits.
  if(chatNeeded)return {state:'held',reason:'telegram-scope-unavailable'};
  return this.complete(record,{membership,lease,originalLease},now,reason,heads,canonicalHash({dependencies,bindingSnapshotHash:canonicalHash(bindingSnapshot),graphRevision:reduced.revision}));
 }
 private complete(record:ConversationGraphReplicationRecord,actuation:ReturnType<GraphRecoveryCoordinatorOptions['actuation']>,now:number,reason:GraphPendingRevalidation['reason'],heads:string[],dependenciesHash:string):GraphPendingValidationResult {
  const o=this.options,{membership,lease}=actuation;
  let rewrap:GraphBundleRewrap|null=null;
  if(record.erasure||!record.encryptedSourceBundle)reason='erased-source';
  else if(reason==='ok'){
   try{const plain=o.source.openVerifiedPayload(record);plain.fill(0);
    if(reason==='ok')rewrap=rewrapGraphBundle(record.encryptedSourceBundle,o.machineId,o.sealingPrivateKey,membership,o.machineId,o.signingPrivateKey,record.packet,new Date(now).toISOString(),record.rewrap&&record.adoption?{rewrap:record.rewrap,membership:record.adoption.newMembership}:undefined);
   }catch(error){if(error instanceof Error&&['graph-source-locally-erased','graph-source-payload-erased'].includes(error.message))reason='erased-source';else return {state:'held',reason:'source-decryption-or-rewrap-invalid'};}
  }
  const {packet,packetSignature,authorizationProof}=record;
  const payload={v:1 as const,agentId:packet.agentId,idempotencyKey:packet.idempotencyKey,operationHash:canonicalHash(packet),coreHash:packet.coreHash,
   sourceProofHash:canonicalHash({coreType:record.coreType,packet,packetSignature,core:record.core,authorizationProof}),subjectHeadsHash:canonicalHash(heads),dependenciesHash,
   rewrapHash:canonicalHash(rewrap),newMembershipHash:canonicalHash(membership),currentLeaseHash:canonicalHash(lease),writerId:o.machineId,decision:reason==='ok'?'adopt' as const:'refuse' as const,reason,validatedAt:new Date(now).toISOString()};
  return {state:'validated',proof:{...payload,signature:signGraphRecord(D.revalidation,payload,o.signingPrivateKey)},rewrap};
 }
}
