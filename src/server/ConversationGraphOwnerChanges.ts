import {DegradationReporter} from '../monitoring/DegradationReporter.js';
/** Owner changes use the same real mutation queue, frozen intake and witnessed
 * all-member commit path as delegation. No body field supplies owner authority.
 * Spec: conversation-effort-hierarchy-v3 §3.1–3.3, §7.2, §7.5, increment C.
 */
import crypto from 'node:crypto';
import {verifiedEntityName} from '../messaging/shared/channelIdentity.js';
import type {Request} from 'express';
import {canonicalHash,graphOperationKey,signGraphRecord,witnessActionPayload,GRAPH_SIGNATURE_DOMAINS,validateGraphErasureIdentity,type GraphMembershipEpoch,type GraphCoreType} from '../core/GraphWitnessTypes.js';
import {validateNodeRef,validateGraphEvent,reduceGraph,nodeKey,relationFor,moveEligibility,type NodeRef,type GraphEvent} from '../core/conversationGraph.js';
import {newHeaderId,newTitleSalt,titleCommitment,validateHeaderOperation,type HeaderOperation} from '../core/EffortHeaderStore.js';
import {signGraphAuthorizationReceipt,type GraphAuthorizationProof} from '../core/ConversationGraphReplicationProof.js';
import {issueGraphUndo,readGraphUndo} from '../core/ConversationGraphUndo.js';
import type {MachineIdentityManager} from '../core/MachineIdentity.js';
import type {DroppedOriginRegistry} from '../core/RollbackUnmerge.js';
import type {ScopeVerifier} from '../core/ScopeVerifier.js';
import type {GraphViewer} from '../core/conversationGraphRead.js';
import type {ConversationGraphReplicationRuntime} from './ConversationGraphReplicationRuntime.js';
import type {ConversationGraphReplicationRecord} from '../core/ConversationGraphReplication.js';
import type {GraphLocalOwnerIntent,GraphQueuedIntentView,GraphQueuedRefusal} from '../core/ConversationGraphQueuedIntent.js';
import type {GraphCommitOutcome} from '../core/ConversationGraphCommitCoordinator.js';
import {hasSeparateGraphPendingCopy,graphPendingMemberCopy} from '../core/ConversationGraphPendingCustody.js';
import {graphCustodyScope} from '../core/GraphCustodyProfile.js';
import type {GraphQueuedOwnerAdmission,GraphQueuedOwnerResolution} from './ConversationGraphOwnerAdmission.js';
import {parseGraphOwnerChange,type GraphOwnerChange} from '../core/ConversationGraphOwnerIntent.js';
export {parseGraphOwnerChange,type GraphOwnerChange} from '../core/ConversationGraphOwnerIntent.js';

export interface GraphChangeReply {status:number;body:Record<string,unknown>;privateMayServe?:()=>boolean}
export interface GraphOwnerChangeDeps {
 runtime:ConversationGraphReplicationRuntime;identity:MachineIdentityManager;membership():GraphMembershipEpoch;
 dropped:DroppedOriginRegistry;scope:ScopeVerifier;telegramChatId:string;
 resolveViewer(req:Request,surface:'dashboard'|'mobile'):GraphViewer|null;
 /** Current certified source inventory, never a request's claimed destination. */
 hasConversation(ref:NodeRef):boolean;
 headerVersion(headerId:string):{version:number;forgotten:boolean}|null;
 captureOwnerIntent?(req:Request,surface:'dashboard'|'mobile',key:string):GraphQueuedOwnerAdmission|null;
 resolveQueuedOwner?(intent:GraphLocalOwnerIntent):Promise<GraphQueuedOwnerResolution>;
}
const equal=(a:string[],b:string[])=>canonicalHash([...a].sort())===canonicalHash([...b].sort());
const failure=(status:number,code:string,extra:Record<string,unknown>={}):GraphChangeReply=>({status,body:{code,...extra}});

export class ConversationGraphOwnerChanges {
 constructor(private readonly options:GraphOwnerChangeDeps){
  if(options.resolveQueuedOwner)options.runtime.setQueuedOwnerIntentPromoter((intent,token)=>this.promoteLocal(intent,token));
 }
 private async promoteLocal(intent:GraphLocalOwnerIntent,token:symbol):Promise<GraphCommitOutcome|{refused:GraphQueuedRefusal}>{
  const resolve=async()=>{
   const result=await this.options.resolveQueuedOwner!(intent);
   if(result.state==='unavailable')throw new Error('graph-queued-owner-authority-unavailable');
   return result.state==='authorized'?result.viewer:null;
  };
  const owner=await resolve();if(!owner)return{refused:'owner-revoked'};
  if(owner.principalKey!==intent.principalKey||owner.grantVersion!==intent.grantVersion)return{refused:'owner-revoked'};
  const result=await this.executeAdmitted(intent.surface,intent.requestId,intent.change,owner,resolve,token,intent.createdEffort);
  if(result.status>=500)throw new Error('graph-queued-promotion-unavailable');
  if(result.status>=400){
   const code=String(result.body.code);
   const refused:GraphQueuedRefusal=result.status===403?'owner-revoked':result.status===404?'not-visible':result.status===410?'erased'
    :code==='header-version-conflict'?'stale-header':code==='placement-conflict'||code==='front-door-conflict'?'stale-heads'
    :code==='project-scope-conflict'?'project-scope':'conflict';
   return{refused};
  }
  const actual=this.options.runtime.source.lookupByIdempotencyKey(intent.idempotencyKey);
  if(!actual||result.body.eventId!==actual.packet.eventId)throw new Error('graph-queued-promotion-source-missing');
  const committed=result.body.state==='committed',saved=result.body.state==='saved-pending';
  return{state:committed?'committed':saved?'saved-pending':result.body.state==='recorded-local'?'recorded-local':'checking-save',idempotencyKey:intent.idempotencyKey,
   eventId:actual.packet.eventId,waitingMachineIds:this.options.runtime.source.status(actual.packet.eventId).missingMembers,
   phase:committed?'committed':saved?'witnessed':'local'};
 }
 private queuedReply(view:GraphQueuedIntentView,owner:GraphViewer):GraphChangeReply{
  if(!view.visibleTo(ref=>owner.mayView(ref)))return failure(404,'not-found');
  const privateMayServe=view.change?()=>view.mayServeDetails()&&view.visibleTo(ref=>owner.mayView(ref)):undefined;
  if(view.state==='promoted'){
   const source=this.options.runtime.source.lookupByIdempotencyKey(view.idempotencyKey);
   if(!source||!this.visibleRecord(source,owner))return failure(503,'conversation-graph-not-current');
   const actualRef=source.coreType==='graph-event'&&source.core.op==='create-effort'?validateNodeRef(source.core.subject):null;
   const createdEffort=actualRef?.kind==='effort'&&typeof source.core.headerId==='string'
    ?{ref:actualRef,headerId:source.core.headerId}:view.createdEffort;
   const localIntent=view.change?{localIntent:{v:1,change:view.change,...(createdEffort?{createdEffort}:{})}}:{};
   const result=this.reply(view.requestId,source.packet.eventId,undefined,owner);
   if(result.body.state==='checking-save')return{status:202,privateMayServe,body:{...result.body,state:'recorded-local',
    custody:{kind:'recorded-here',machine:this.machine(view.recordedMachineId)},details:view.details,
    ...localIntent}};
   return ['committed','canceled','erased'].includes(String(result.body.state))?result:{...result,privateMayServe,body:{...result.body,details:view.details,
    ...localIntent}};
  }
  const machine=this.machine(view.recordedMachineId);
  return{status:view.state==='recorded-local'?202:200,privateMayServe,body:{wireVersion:2,requestId:view.requestId,operationKey:view.operationKey,
   state:view.state,recordedAt:view.recordedAt,custody:{kind:'recorded-here',machine},
   cancelEligible:view.cancelEligible,sync:{state:'unavailable'},
   waitingMachines:this.options.membership().members.filter(row=>row.machineId!==view.recordedMachineId).map(row=>this.machine(row.machineId)),
   details:view.details,...(view.change?{localIntent:{v:1,change:view.change,...(view.createdEffort?{createdEffort:view.createdEffort}:{})}}:{}),
   ...(view.refusalCode?{reason:view.refusalCode}:{})}};
 }
 /** Priority local suppression works on followers and during witness outage.
  * The response deliberately does not certify fleet or backup erasure. */
 async forgetLocal(req:Request,surface:'dashboard'|'mobile',target:unknown):Promise<GraphChangeReply>{
  const owner=this.options.resolveViewer(req,surface);if(!owner)return failure(403,'hierarchy-owner-only');
  if(!validateGraphErasureIdentity(target))return failure(400,'invalid-erasure-target');
  try{
   await this.options.runtime.eraseLocal(target);
   const current=this.options.resolveViewer(req,surface);
   if(!current||current.principalKey!==owner.principalKey||current.grantVersion!==owner.grantVersion)return failure(403,'hierarchy-owner-only');
   return{status:202,body:{operationKey:'forget:'+canonicalHash(target),state:'local-hidden',fleetComplete:false}};
  }catch{return failure(503,'erasure-confirmation-unavailable');}
 }
 /** Resolve the erasable header from verified graph custody; callers never
  * choose an arbitrary storage identity or claim a principal in JSON. */
 async forgetEffortHeader(req:Request,surface:'dashboard'|'mobile',requestId:unknown,rawEffort:unknown):Promise<GraphChangeReply>{
  const owner=this.options.resolveViewer(req,surface);if(!owner)return failure(403,'hierarchy-owner-only');
  const effort=validateNodeRef(rawEffort);
  if(typeof requestId!=='string'||!/^[A-Za-z0-9_-]{8,160}$/.test(requestId)||effort?.kind!=='effort')return failure(400,'invalid-erasure-request');
  if(!owner.mayView(effort))return failure(404,'node-unavailable');
  try{
   const headerId=this.options.runtime.erasureHeaderId(effort);
   if(!headerId)return failure(404,'node-unavailable');
   if(requestId.startsWith('erasev1_')&&requestId!==this.headerErasureId(owner.principalKey,headerId))return failure(400,'invalid-erasure-request');
   const current=this.options.resolveViewer(req,surface);
   if(!current||current.principalKey!==owner.principalKey||current.grantVersion!==owner.grantVersion)return failure(403,'hierarchy-owner-only');
   const view=await this.options.runtime.erasure.acceptOwner({requestId,target:{sourceKind:'header',sourceId:headerId},
    principalKey:owner.principalKey,authenticationMethod:surface==='mobile'?'owner-device':'owner-dashboard'});
   const after=this.options.resolveViewer(req,surface);
   if(!after||after.principalKey!==owner.principalKey||after.grantVersion!==owner.grantVersion)return failure(403,'hierarchy-owner-only');
   return{status:view.fleetComplete?200:202,body:{...view}};
  }catch{return failure(503,'erasure-confirmation-unavailable');}
 }
 async erasureStatus(req:Request,surface:'dashboard'|'mobile',requestId:unknown,offset:unknown):Promise<GraphChangeReply>{
  const owner=this.options.resolveViewer(req,surface);if(!owner)return failure(403,'hierarchy-owner-only');
  if(typeof requestId!=='string'||!/^[A-Za-z0-9_-]{8,160}$/.test(requestId)
   ||(offset!==undefined&&(typeof offset!=='string'||!/^\d{1,4}$/.test(offset)||Number(offset)>8192)))return failure(400,'invalid-erasure-request');
  try{const view=await this.options.runtime.erasure.status(requestId,{offset:offset===undefined?0:Number(offset)});
   const current=this.options.resolveViewer(req,surface);
   if(!current||current.principalKey!==owner.principalKey||current.grantVersion!==owner.grantVersion)return failure(403,'hierarchy-owner-only');
   return{status:200,body:{...view}};
  }catch{return failure(503,'erasure-confirmation-unavailable');}
 }
 private headerErasureId(principalKey:string,headerId:string):string{
  return 'erasev1_'+canonicalHash({agentId:this.options.membership().agentId,principalKey,headerId});
 }
 async discoverHeaderErasure(req:Request,surface:'dashboard'|'mobile',rawEffort:unknown,ensure=false):Promise<GraphChangeReply>{
  const owner=this.options.resolveViewer(req,surface);if(!owner)return failure(403,'hierarchy-owner-only');
  const effort=validateNodeRef(rawEffort);if(effort?.kind!=='effort')return failure(400,'invalid-erasure-request');
  if(!owner.mayView(effort))return failure(404,'node-unavailable');
  let locallyHidden=false;
  try{
   const headerId=this.options.runtime.erasureHeaderId(effort);if(!headerId)return failure(404,'node-unavailable');
   const target={sourceKind:'header' as const,sourceId:headerId};
   // A corrupt or unavailable continuity index must never delay the owner's
   // local privacy restriction. It still cannot fabricate fleet acceptance.
   if(ensure){await this.options.runtime.eraseLocal(target);locallyHidden=true;}
   const existing=await this.options.runtime.erasure.lookupByTarget(target,owner.principalKey);
   const current=this.options.resolveViewer(req,surface);
   if(!current||current.principalKey!==owner.principalKey||current.grantVersion!==owner.grantVersion)return failure(403,'hierarchy-owner-only');
   if(ensure)return this.forgetEffortHeader(req,surface,existing?.requestId??this.headerErasureId(owner.principalKey,headerId),effort);
   if(!existing)return failure(404,'erasure-not-found'); // Never a not-recorded verdict for an unknown old request.
   return{status:200,body:{requestId:existing.requestId,target,continuity:{publication:existing.verification.publication}}};
  }catch{
   DegradationReporter.getInstance().report({feature:'Conversations.erasure-discovery',primary:'Discover durable removal intent',fallback:'Keep local restriction and return unavailable',reason:'erasure-discovery-unavailable',impact:'Removal elsewhere has not been confirmed',internalOnly:true});
   const current=this.options.resolveViewer(req,surface);
   if(!current||current.principalKey!==owner.principalKey||current.grantVersion!==owner.grantVersion)return failure(403,'hierarchy-owner-only');
   return failure(503,'erasure-discovery-unavailable',locallyHidden?{localHidden:true,fleetComplete:false}:{});
  }
 }
 private key(principal:string,requestId:string){return 'owner-change:'+canonicalHash({principal,requestId});}
 private subjectOf(record:ConversationGraphReplicationRecord):NodeRef|null{
  if(record.coreType==='graph-event')return validateNodeRef(record.core.subject);
  if(record.coreType!=='header-op')return null;
  try{
   const subjects=new Map<string,NodeRef>();
   for(const candidate of this.options.runtime.retainedProjection().records){
    if(candidate.coreType!=='graph-event'||candidate.core.op!=='create-effort'||candidate.core.headerId!==record.core.headerId)continue;
    const ref=validateNodeRef(candidate.core.subject);if(ref)subjects.set(nodeKey(ref),ref);
   }
   return subjects.size===1?[...subjects.values()][0]:null;
  }catch{DegradationReporter.getInstance().report({feature:'Conversations.header-subject',primary:'Resolve certified header subject',fallback:'Withhold unverifiable subject',reason:'header-subject-unavailable',impact:'Pending metadata remains unavailable',internalOnly:true});return null;}
 }
 private visibleRecord(record:ConversationGraphReplicationRecord,viewer:GraphViewer):boolean{const ref=this.subjectOf(record);return !!ref&&viewer.mayView(ref);}
 private visibleParent(viewer:GraphViewer,parent:NodeRef|null):NodeRef|null{return parent&&viewer.mayView(parent)?parent:null;}
 private snapshot(){
  const union=this.options.runtime.projection();
  const events=union.records.filter(r=>r.coreType==='graph-event').map(r=>validateGraphEvent(r.core)).filter((e):e is GraphEvent=>e!==null);
  const verified=new Map(union.records.map(r=>[r.packet.eventId,r]));
  const verify=(event:GraphEvent)=>{const record=verified.get(graphOperationKey('graph-event',event.eventId));return !!record&&this.options.runtime.source.verifyHistoricalRecord(record);};
  return{union,events,verify,graph:reduceGraph(events,{verify})};
 }
 private projectOf(ref:NodeRef):string|null|undefined{
  if(ref.kind==='effort')return null;
  if(ref.platform!=='telegram'||ref.chatId!==this.options.telegramChatId)return undefined;
  return this.options.scope.currentTopicBindings()[String(ref.topicId)]?.projectName??null;
 }
 private scopeAllowed(subject:NodeRef,parent:NodeRef|null,graph:ReturnType<typeof reduceGraph>):boolean{
  if(!parent)return true;const project=this.projectOf(subject);let cursor:NodeRef|null=parent;const seen=new Set<string>();
  while(cursor&&!seen.has(nodeKey(cursor))){const key=nodeKey(cursor);seen.add(key);
   if(cursor.kind==='effort'){const effort=graph.efforts.get(key);if(!effort)return false;
    // The nearest effort owns the effective scope. An empty scope is the
    // owner's cross-project organizer, not inheritance from a higher effort.
    return !effort.projectScope.length||project===null||(project!==undefined&&effort.projectScope.includes(project));
   }
   cursor=graph.parentOf.get(key)??null;
  }
  return true;
 }
 preview(req:Request,surface:'dashboard'|'mobile',raw:unknown):GraphChangeReply{
  const owner=this.options.resolveViewer(req,surface);if(!owner)return failure(403,'hierarchy-owner-only');
  const change=parseGraphOwnerChange(raw);if(change?.kind!=='set-primary-placement')return failure(400,'invalid-change');
  try{
   const {graph,events,verify,union}=this.snapshot();
   if(union.missingEventIds.length||graph.partial.eventGap||graph.partial.evidenceMissing)return failure(503,'conversation-graph-not-current');
   const known=(ref:NodeRef)=>owner.mayView(ref)&&(ref.kind==='effort'?graph.efforts.has(nodeKey(ref)):this.options.hasConversation(ref));
   if(!known(change.subject)||(change.parent&&!known(change.parent)))return failure(404,'not-found');
   const heads=graph.placementHeads.get(nodeKey(change.subject))??[];
   if(!equal(heads,change.replacesPlacementEventIds))return failure(409,'placement-conflict',{
    lastAgreedParent:this.visibleParent(owner,graph.parentOf.get(nodeKey(change.subject))??null),
    proposedParents:events.filter(e=>e.op==='set-primary-placement'&&heads.includes(e.eventId))
     .map(e=>e.op==='set-primary-placement'?e.parent:null).filter(parent=>parent===null||owner.mayView(parent))});
   const eligibility=moveEligibility(events,{verify},change.subject,change.parent,new Date().toISOString());
   const allowed=eligibility.eligible&&this.scopeAllowed(change.subject,change.parent,graph);
   const current=this.options.resolveViewer(req,surface);
   if(!current||current.principalKey!==owner.principalKey||current.grantVersion!==owner.grantVersion)return failure(403,'hierarchy-owner-only');
   return{status:200,body:{subject:change.subject,parent:change.parent,replacesPlacementEventIds:heads,
    eligible:allowed,...(!allowed?{reason:eligibility.eligible?'project-scope':eligibility.reason}:{}),revision:graph.revision}};
  }catch{return failure(503,'conversation-graph-unavailable');}
 }
 async submit(req:Request,surface:'dashboard'|'mobile',requestId:unknown,raw:unknown):Promise<GraphChangeReply>{
  const viewer=this.options.resolveViewer(req,surface);if(!viewer)return failure(403,'hierarchy-owner-only');
  if(typeof requestId!=='string'||!/^[A-Za-z0-9_.:-]{8,160}$/.test(requestId))return failure(400,'invalid-request-id');
  const change=parseGraphOwnerChange(raw);if(!change)return failure(400,'invalid-change');
  if(this.options.captureOwnerIntent&&this.options.resolveQueuedOwner){
   try{
    const key=this.key(viewer.principalKey,requestId),admission=this.options.captureOwnerIntent(req,surface,key);
    if(!admission)return failure(403,'hierarchy-owner-only');
    let headerId=change.kind==='set-effort-title'?this.options.runtime.erasureHeaderId(change.effort):null;
    if(change.kind==='set-effort-title'&&!headerId){
     const local=await this.options.runtime.localOwnerIntents(viewer.principalKey);
     headerId=local.find(item=>item.createdEffort&&nodeKey(item.createdEffort.ref)===nodeKey(change.effort)
      &&item.mayServeDetails()&&item.visibleTo(ref=>viewer.mayView(ref)))?.createdEffort?.headerId??null;
    }
    if(change.kind==='set-effort-title'&&!headerId)return failure(503,'conversation-graph-not-current');
    const isCurrent=()=>{const current=this.options.resolveViewer(req,surface);return !!current&&current.principalKey===viewer.principalKey&&current.grantVersion===viewer.grantVersion;};
    let queued=await this.options.runtime.recordLocalOwnerIntent({idempotencyKey:key,requestId,principalKey:viewer.principalKey,
     grantVersion:canonicalHash(admission),admission,surface,change,...(headerId?{headerId}:{})},isCurrent);
    let current=this.options.resolveViewer(req,surface);
    if(!current||current.principalKey!==viewer.principalKey||current.grantVersion!==viewer.grantVersion)return failure(403,'hierarchy-owner-only');
    if(await this.options.runtime.refreshReadiness()){
     try{await this.options.runtime.promoteQueuedOwnerIntent(key,viewer.principalKey,(intent,token)=>this.promoteLocal(intent,token));}
     catch{/* @silent-fallback-ok: a durably recorded local intent stays pending when shared promotion is unavailable; its exact status is returned below */}
     queued=await this.options.runtime.localOwnerIntent(key,viewer.principalKey)??queued;
    }
    current=this.options.resolveViewer(req,surface);
    if(!current||current.principalKey!==viewer.principalKey||current.grantVersion!==viewer.grantVersion)return failure(403,'hierarchy-owner-only');
    return this.queuedReply(queued,current);
   }catch(error){const code=(error as Error).message;return code==='graph-queued-current-owner-required'?failure(403,'hierarchy-owner-only')
    :code==='graph-queued-idempotency-conflict'?failure(409,'idempotency-conflict'):failure(503,'conversation-graph-unavailable');}
  }
  try{return await this.options.runtime.withSourceMutation(token=>this.executeAdmitted(surface,requestId,change,viewer,()=>this.options.resolveViewer(req,surface),token));}catch(error){
   const code=(error as {code?:string}).code;
   return code==='idempotency-conflict'?failure(409,code):failure(503,'conversation-graph-unavailable');
  }
 }
 /** Shared admitted executor. Queued promotion passes the SAME original intent
  * and actual current authority resolver under the runtime's existing token. */
 private async executeAdmitted(surface:'dashboard'|'mobile',requestId:string,change:GraphOwnerChange,viewer:GraphViewer,
  resolveCurrent:()=>GraphViewer|null|Promise<GraphViewer|null>,token:symbol,
  createdEffort?:{ref:Extract<NodeRef,{kind:'effort'}>;headerId:string}):Promise<GraphChangeReply>{
  // Never persist a deterministic title-derived hash outside erasable custody.
  // Frozen title retries are compared against their encrypted original below.
  const key=this.key(viewer.principalKey,requestId),requestHash=canonicalHash(change.kind==='set-effort-title'
   ?{kind:change.kind,effort:change.effort,baseVersion:change.baseVersion}:change);
   const owner=await resolveCurrent();
   if(!owner||owner.principalKey!==viewer.principalKey||owner.grantVersion!==viewer.grantVersion)return failure(403,'hierarchy-owner-only');
   let prior=this.options.runtime.source.lookupByIdempotencyKey(key);
   if(!prior){
    const reserved=(await this.options.runtime.intake.reservations()).find(record=>record.packet.idempotencyKey===key);
    if(reserved){const current=this.options.runtime.actuation();await this.options.runtime.source.appendReserved(reserved,this.options.runtime.intake,current.lease,current.originalLease);prior=this.options.runtime.source.lookupByIdempotencyKey(key);}
   }
   if(prior){
    if(!this.visibleRecord(prior,owner))return failure(404,'not-found');
    let payload:{requestHash?:unknown;title?:unknown};const bytes=this.options.runtime.source.openVerifiedPayload(prior);
    try{payload=JSON.parse(bytes.toString());}finally{bytes.fill(0);}
    if(payload.requestHash!==requestHash||(change.kind==='set-effort-title'&&payload.title!==change.title))return failure(409,'idempotency-conflict');
    return this.reply(requestId,prior.packet.eventId,undefined,owner);
   }
   const {graph,events,verify,union}=this.snapshot();
   if(union.missingEventIds.length||graph.partial.eventGap||graph.partial.evidenceMissing)return failure(503,'conversation-graph-not-current');
   const known=(ref:NodeRef)=>owner.mayView(ref)&&(ref.kind==='effort'?graph.efforts.has(nodeKey(ref)):this.options.hasConversation(ref));
   const actuation=this.options.runtime.actuation();
   // This exact ID has no frozen reservation under the actual admitted
   // writer's serialized check above. These rejections created no operation.
   const reject=(code:string,extra:Record<string,unknown>={},status=409)=>failure(status,code,{...extra,requestState:'not-recorded'});
   const subject=change.kind==='create-effort'?null:change.kind==='set-primary-placement'?change.subject:change.effort;
   if(subject){
    const earlier=new Map((await this.options.runtime.intake.reservations()).map(record=>[record.packet.eventId,record]));
    const sourceRecords=this.options.runtime.source.recordsForRepair(),storedIds=new Set(sourceRecords.map(record=>record.packet.eventId));
    for(const record of sourceRecords)earlier.set(record.packet.eventId,record);
    for(const record of earlier.values()){
     if(record.packet.idempotencyKey===key||record.authorizationProof.receipt.actorPrincipal!==owner.principalKey
       ||!record.authorizationProof.receipt.authenticationMethod.startsWith('owner-')
       ||(storedIds.has(record.packet.eventId)&&this.options.runtime.source.allCommitProofDelivered(record.packet.eventId)))continue;
     const priorSubject=this.subjectOf(record);
     if(priorSubject&&nodeKey(priorSubject)===nodeKey(subject))return reject('subject-change-pending',{operationKey:record.packet.eventId});
    }
   }
   const createdAt=new Date().toISOString(),eventId='change-'+crypto.randomUUID(),receiptId='owner-'+crypto.randomUUID();
   const common={schemaVersion:1 as const,eventId,authority:'owner' as const,principal:owner.principalKey,receipt:{kind:'owner-proof' as const,id:receiptId},machineId:this.options.runtime.machineId,createdAt};
   let core:GraphEvent|HeaderOperation,coreType:GraphCoreType='graph-event',previousParent:NodeRef|null=null;
   let content:Record<string,unknown>={kind:'graph-owner-change',requestHash,requestId};
   if(change.kind==='set-primary-placement'){
    if(!known(change.subject)||(change.parent&&!known(change.parent)))return reject('not-found',{},404);
    const heads=graph.placementHeads.get(nodeKey(change.subject))??[];
    if(!equal(heads,change.replacesPlacementEventIds))return reject('placement-conflict',{
     lastAgreedParent:this.visibleParent(owner,graph.parentOf.get(nodeKey(change.subject))??null),
     proposedParents:events.filter(e=>e.op==='set-primary-placement'&&heads.includes(e.eventId)).map(e=>e.op==='set-primary-placement'?e.parent:null)
      .filter(parent=>parent===null||owner.mayView(parent))});
    const eligible=moveEligibility(events,{verify},change.subject,change.parent,createdAt);
    if(!eligible.eligible)return reject('move-ineligible',{reason:eligible.reason});
    if(!this.scopeAllowed(change.subject,change.parent,graph))return reject('project-scope-conflict');
    previousParent=graph.parentOf.get(nodeKey(change.subject))??null;content={...content,previousParent};
    core={...common,op:'set-primary-placement',subject:change.subject,parent:change.parent,relation:change.parent?relationFor(change.subject,change.parent):null,replacesPlacementEventIds:heads};
   }else if(change.kind==='set-front-door'){
    if(!known(change.effort)||(change.conversation&&!known(change.conversation)))return reject('not-found',{},404);
    const heads=graph.frontDoorHeads.get(nodeKey(change.effort))??[];
    if(!equal(heads,change.replacesFrontDoorEventIds))return reject('front-door-conflict');
    const observed=change.conversation?(graph.placementHeads.get(nodeKey(change.conversation))??[]):[];
    if(!equal(observed,change.observedPlacementEventIds))return reject('placement-conflict');
    core={...common,op:'set-front-door',subject:change.effort as Extract<NodeRef,{kind:'effort'}>,frontDoor:change.conversation as Extract<NodeRef,{kind:'conversation'}>|null,replacesFrontDoorEventIds:heads,observedPlacementEventIds:observed};
    const proposed=core;
    const trial=reduceGraph([...events,proposed],{verify:e=>e.eventId===proposed.eventId||verify(e)});
    if(trial.setAside.some(e=>e.eventId===proposed.eventId))return reject('front-door-ineligible');
   }else if(change.kind==='create-effort'){
    const projects=new Set(Object.values(this.options.scope.currentTopicBindings()).map(binding=>binding.projectName));
    if(change.projectScope.some(project=>!projects.has(project)))return reject('project-scope-conflict');
    core={...common,op:'create-effort',subject:createdEffort?.ref??{kind:'effort',id:crypto.randomUUID()},projectScope:change.projectScope,headerId:createdEffort?.headerId??newHeaderId()};
   }else{
    if(!known(change.effort))return reject('not-found',{},404);
    const headerId=graph.efforts.get(nodeKey(change.effort))!.headerId,current=this.options.headerVersion(headerId);
    if(current?.forgotten)return reject('header-forgotten',{},410);
    if((current?.version??0)!==change.baseVersion)return reject('header-version-conflict',{currentVersion:current?.version??0});
    const salt=newTitleSalt();coreType='header-op';
    const candidate={schemaVersion:1,opId:eventId,headerId,baseVersion:change.baseVersion,authority:'owner',principal:owner.principalKey,
     receipt:{kind:'owner-proof',id:receiptId},machineId:common.machineId,createdAt,kind:'set-effort-title',titleCommitment:titleCommitment(change.title,salt),bundleRef:{kind:'header-source-bundle',id:'bundle-'+crypto.randomUUID()}};
    const parsed=validateHeaderOperation(candidate);if(!parsed)return reject('invalid-header',{},400);core=parsed;
    content={...content,kind:'effort-header-payload',headerId,title:change.title,salt};
   }
   const beforeSign=await resolveCurrent();
   if(!beforeSign||beforeSign.principalKey!==owner.principalKey||beforeSign.grantVersion!==owner.grantVersion)return failure(403,'hierarchy-owner-only');
   if(canonicalHash(this.options.runtime.actuation().originalLease)!==canonicalHash(actuation.originalLease))return failure(503,'conversation-graph-not-current');
   const membership=this.options.membership(),rawId=coreType==='header-op'?(core as HeaderOperation).opId:(core as GraphEvent).eventId;
   const identity=graphOperationKey(coreType,rawId);
   const receipt=signGraphAuthorizationReceipt({v:1,agentId:membership.agentId,eventId:identity,coreHash:canonicalHash(core),actorPrincipal:owner.principalKey,
    authenticationMethod:surface==='mobile'?'owner-device':'owner-dashboard',receiptId,membershipEpoch:membership.epoch,leaseEpoch:actuation.lease.leaseEpoch,
    idempotencyKey:key,writerId:this.options.runtime.machineId,fencedLeaseHash:canonicalHash(actuation.originalLease),acceptedAt:createdAt},this.options.identity.loadSigningKey());
   const proof:GraphAuthorizationProof={receipt,membership,lease:actuation.lease,originalLease:actuation.originalLease};
   const bytes=Buffer.from(JSON.stringify(content));
   try{
    const outcome=await this.options.runtime.submitPrepared({coreType,idempotencyKey:key,requestHash,core:core as unknown as Record<string,unknown>,authorizationProof:proof,plaintextSource:bytes},token);
    const current=await resolveCurrent();
    if(!current||current.principalKey!==owner.principalKey||current.grantVersion!==owner.grantVersion)return failure(403,'hierarchy-owner-only');
    return this.reply(requestId,identity,outcome,current);
   }finally{bytes.fill(0);}

 }

 status(req:Request,surface:'dashboard'|'mobile',requestId:unknown):GraphChangeReply{
  const owner=this.options.resolveViewer(req,surface);if(!owner)return failure(403,'hierarchy-owner-only');
  if(typeof requestId!=='string'||!/^[A-Za-z0-9_.:-]{8,160}$/.test(requestId))return failure(400,'invalid-request-id');
  const record=this.options.runtime.source.lookupByIdempotencyKey(this.key(owner.principalKey,requestId));
  if(!record||!this.visibleRecord(record,owner))return failure(404,'not-found');
  return {...this.reply(requestId,record.packet.eventId,undefined,owner),
   privateMayServe:()=>this.visibleRecord(record,owner)
    &&this.options.runtime.source.status(record.packet.eventId).state!=='quarantined'};
 }
 async statusWithLocal(req:Request,surface:'dashboard'|'mobile',requestId:unknown):Promise<GraphChangeReply>{
  const canonical=this.status(req,surface,requestId);
  if(!this.options.captureOwnerIntent||(canonical.status!==404&&canonical.status!==202))return canonical;
  const owner=this.options.resolveViewer(req,surface);if(!owner)return failure(403,'hierarchy-owner-only');
  const view=await this.options.runtime.localOwnerIntent(this.key(owner.principalKey,String(requestId)),owner.principalKey);
  const current=this.options.resolveViewer(req,surface);
  if(!current||current.principalKey!==owner.principalKey||current.grantVersion!==owner.grantVersion)return failure(403,'hierarchy-owner-only');
  return view?this.queuedReply(view,current):canonical;
 }
 async pending(req:Request,surface:'dashboard'|'mobile'):Promise<GraphChangeReply>{
  const owner=this.options.resolveViewer(req,surface);if(!owner)return failure(403,'hierarchy-owner-only');
  const offset=Number(req.query?.offset??0);
  if(!Number.isSafeInteger(offset)||offset<0)return failure(400,'invalid-pending-offset');
  const items:Array<Record<string,unknown>>=[];
  const privateGuards:Array<()=>boolean>=[];
  const sourceRecords=this.options.runtime.source.recordsForRepair();
  const records=new Map((await this.options.runtime.intake.reservations()).map(record=>[record.packet.eventId,record]));
  for(const record of sourceRecords)records.set(record.packet.eventId,record);
  const stored=new Set(sourceRecords.map(record=>record.packet.eventId));
  for(const record of records.values()){
   if(record.coreType==='source-observation'||!this.options.runtime.source.verifyHistoricalRecord(record)||!this.visibleRecord(record,owner))continue;
   // The local-intent reads below can yield. Recheck every retained subject at
   // the response boundary, not merely when this row was first assembled.
   privateGuards.push(()=>this.visibleRecord(record,owner)
    &&this.options.runtime.source.status(record.packet.eventId).state!=='quarantined');
   if(!stored.has(record.packet.eventId)){
    items.push({requestId:null,operationKey:record.packet.eventId,eventId:record.packet.eventId,state:'checking-save',
     subject:this.subjectOf(record),kind:record.core.op??record.core.kind,cancelEligible:false,waitingMachines:[]});
    continue;
   }
   if(this.options.runtime.source.allCommitProofDelivered(record.packet.eventId)
    ||this.options.runtime.source.historicalTerminalProof(record.packet.eventId))continue;
   const status=this.options.runtime.source.status(record.packet.eventId);if(status.state==='quarantined')continue;
   let requestId:string|null=null;
   try{const bytes=this.options.runtime.source.openVerifiedPayload(record);let body:{requestId?:unknown};
    try{body=JSON.parse(bytes.toString());}finally{bytes.fill(0);}if(typeof body.requestId==='string')requestId=body.requestId;
   }catch{/* A removed application source cannot be recovered from its graph pointer. */}
   const {certificate: _certificate,...pendingStatus}=this.reply(requestId??'',record.packet.eventId,undefined,owner).body;
   items.push({...pendingStatus,requestId,operationKey:record.packet.eventId,
    subject:this.subjectOf(record),kind:record.core.op??record.core.kind});
  }
  if(this.options.captureOwnerIntent){
   const queued=await this.options.runtime.localOwnerIntents(owner.principalKey);
   for(const view of queued){
    if(!view.visibleTo(ref=>owner.mayView(ref)))continue;
    if(view.state==='canceled-local')continue;
    if(view.state==='promoted'){
     const index=items.findIndex(item=>item.requestId===view.requestId||item.operationKey===view.promotion?.eventId);
     if(index>=0){const reply=this.queuedReply(view,owner);if(reply.status===202){items[index]={...items[index],...reply.body};if(reply.privateMayServe)privateGuards.push(reply.privateMayServe);}}
     continue;
    }
    const reply=this.queuedReply(view,owner);
    if(reply.status>=400)continue;
    items.push(reply.body);if(reply.privateMayServe)privateGuards.push(reply.privateMayServe);
   }
  }
  const current=this.options.resolveViewer(req,surface);
  if(!current||current.principalKey!==owner.principalKey||current.grantVersion!==owner.grantVersion)return failure(403,'hierarchy-owner-only');
  return{status:200,privateMayServe:privateGuards.length?()=>privateGuards.every(guard=>guard()):undefined,
   body:{items:items.slice(offset,offset+64),total:items.length,nextOffset:offset+64<items.length?offset+64:null}};
 }
 async cancel(req:Request,surface:'dashboard'|'mobile',operationKey:unknown):Promise<GraphChangeReply>{
  const owner=this.options.resolveViewer(req,surface);if(!owner)return failure(403,'hierarchy-owner-only');
  if(this.options.captureOwnerIntent&&typeof operationKey==='string'&&operationKey.startsWith('queued:')){
   if(operationKey.length>240)return failure(404,'not-found');
   const isCurrent=()=>{const current=this.options.resolveViewer(req,surface);return !!current&&current.principalKey===owner.principalKey&&current.grantVersion===owner.grantVersion;};
   try{
    const canceled=await this.options.runtime.cancelLocalOwnerIntent(operationKey.slice('queued:'.length),owner.principalKey,isCurrent);
    if(!isCurrent())return failure(403,'hierarchy-owner-only');
    return this.queuedReply(canceled,owner);
   }catch(error){return (error as Error).message==='graph-queued-already-admitted'?failure(409,'cancel-unavailable'):failure(503,'conversation-graph-unavailable');}
  }
  if(typeof operationKey!=='string'||operationKey.length>240||!/^(graph-event|header-op):[A-Za-z0-9_-]{8,80}$/.test(operationKey))return failure(404,'not-found');
  try{return await this.options.runtime.withMutation(async()=>{
   const current=this.options.resolveViewer(req,surface);if(!current||current.principalKey!==owner.principalKey||current.grantVersion!==owner.grantVersion)return failure(403,'hierarchy-owner-only');
   const record=this.options.runtime.source.repairRecord(operationKey);if(!record||!this.options.runtime.source.verifyHistoricalRecord(record)||!this.visibleRecord(record,current))return failure(404,'not-found');
   const outcome=await this.options.runtime.coordinator.cancel(record,lease=>signGraphRecord(GRAPH_SIGNATURE_DOMAINS.action,
    witnessActionPayload('cancel',{idempotencyKey:record.packet.idempotencyKey},lease),this.options.identity.loadSigningKey()));
   const after=this.options.resolveViewer(req,surface);
   if(!after||after.principalKey!==owner.principalKey||after.grantVersion!==owner.grantVersion)return failure(403,'hierarchy-owner-only');
   let requestId:string|undefined;
   try{const bytes=this.options.runtime.source.openVerifiedPayload(record);
    try{const body=JSON.parse(bytes.toString());if(typeof body.requestId==='string'&&/^[A-Za-z0-9_.:-]{8,160}$/.test(body.requestId))requestId=body.requestId;}
    finally{bytes.fill(0);}
   }catch{/* A removed private body cannot be reconstructed to supply a UUID. */}
   return{status:outcome.state==='canceled'||outcome.state==='commit-won'?200:202,
    privateMayServe:()=>this.visibleRecord(record,owner),body:{...(requestId?{requestId}:{}),operationKey,...outcome,
    waitingMachines:outcome.waitingMachineIds.map(machineId=>this.machine(machineId))}};
  });}catch{return failure(503,'conversation-graph-unavailable');}
 }
 async undo(req:Request,surface:'dashboard'|'mobile',requestId:unknown,token:unknown):Promise<GraphChangeReply>{
  const owner=this.options.resolveViewer(req,surface);if(!owner)return failure(403,'hierarchy-owner-only');
  const member=this.options.membership().members.find(member=>member.machineId===this.options.runtime.machineId);
  const claim=member?readGraphUndo(token,member.signingPublicKey):null;
  if(!claim||claim.machineId!==this.options.runtime.machineId||claim.principal!==owner.principalKey)return failure(409,'undo-unavailable');
  try{
   const record=this.options.runtime.source.repairRecord(claim.operationKey);
   const core=record?.coreType==='graph-event'?validateGraphEvent(record.core):null;
   if(!record||!core||core.op!=='set-primary-placement'||!record.certificate
    ||!this.options.runtime.source.allCommitProofDelivered(claim.operationKey)
    ||nodeKey(core.subject)!==nodeKey(claim.subject)||!this.options.runtime.source.verifyHistoricalRecord(record))return failure(409,'undo-unavailable');
   const bytes=this.options.runtime.source.openVerifiedPayload(record);
   let previous:unknown;try{previous=JSON.parse(bytes.toString('utf8')).previousParent;}finally{bytes.fill(0);}
   if(canonicalHash(previous)!==canonicalHash(claim.parent))return failure(409,'undo-unavailable');
   // submit rechecks the exact current heads inside the real mutation queue;
   // another placement cannot be silently overwritten by this old action.
   return this.submit(req,surface,requestId,{kind:'set-primary-placement',subject:claim.subject,parent:claim.parent,replacesPlacementEventIds:[core.eventId]});
  }catch{return failure(409,'undo-unavailable');}
 }
 private machine(machineId:string):{machineId:string;name:string}{
  const entry=this.options.identity.loadRegistry().machines[machineId];
  const name=verifiedEntityName(machineId,entry?.nickname??entry?.name);return{machineId,name:name?.slice(0,120)||'Another machine'};
 }
 private reply(requestId:string,identity:string,outcome?:{state:string;waitingMachineIds:string[]},viewer?:GraphViewer):GraphChangeReply{
  const record=this.options.runtime.source.repairRecord(identity);if(!record)return failure(503,'save-outcome-unknown');
  const status=this.options.runtime.source.status(identity);
  const historical=this.options.runtime.source.historicalTerminalProof(identity);
  // A verified transfer can preserve an OLD terminal outcome. It supplies no
  // new-operation delivery acknowledgement and never changes that threshold.
  const delivered=this.options.runtime.source.allCommitProofDelivered(identity)||historical!==null;
  const rawState=historical?.state??(record.erasure?(status.state==='committed'&&delivered?'committed':status.state==='erased'&&delivered?'erased':'erase-pending')
   :outcome?.state??(status.state==='committed'&&delivered?'committed'
   :status.state==='canceled'&&delivered?'canceled'
   :record.cancellationCertificate?'cancel-pending':record.preparationProof||record.certificate?'saved-pending':'checking-save'));
  const context=this.options.runtime.source.effectiveContext(identity);
  const state=rawState==='saved-pending'&&!hasSeparateGraphPendingCopy(record,{membership:context.membership,leaseEpoch:context.lease.leaseEpoch})?'recorded-local':rawState;
  // A deployment profile names an intended custody location, not a receipt.
  // Failed preparation may leave only the actual local Source admission.
  // Only verified retained custody/terminal/transfer facts justify the stronger
  // copy label. The source class verifies these facts before exposing a record.
  const custody=record.preparationProof||record.certificate||record.cancellationCertificate||record.adoption||record.materialization
   ?graphCustodyScope(context.membership,record.packet.writerId)
   :{kind:'recorded-here' as const,hostMachineId:record.packet.writerId,failureDomain:'owned-machine:'+record.packet.writerId,profileHash:null};
  const memberCopy=custody.kind==='recorded-here'?graphPendingMemberCopy(record,{membership:context.membership,leaseEpoch:context.lease.leaseEpoch}):null;
  const wireCustody=memberCopy
   ?{kind:'copied-on-owned-machine',machine:this.machine(memberCopy),copyEvidence:'verified-member-source',recordedMachine:this.machine(record.packet.writerId)}
   :{...custody,...(custody.hostMachineId?{machine:this.machine(custody.hostMachineId)}:{})};
  let undoToken:string|undefined;
  if(state==='committed'&&record.coreType==='graph-event'&&record.core.op==='set-primary-placement'){
   try{
    const bytes=this.options.runtime.source.openVerifiedPayload(record);
    let previous:unknown;try{previous=JSON.parse(bytes.toString('utf8')).previousParent;}finally{bytes.fill(0);}
    const parent=previous===null?null:validateNodeRef(previous);
    if(previous===null||(parent&&viewer?.mayView(parent)))undoToken=issueGraphUndo({v:1,principal:record.authorizationProof.receipt.actorPrincipal,
     machineId:this.options.runtime.machineId,operationKey:identity,subject:record.core.subject as NodeRef,parent,
     expiresAt:Date.now()+600000},this.options.identity.loadSigningKey());
   }catch{/* Erased or unavailable custody cannot yield an undo action. */}
  }
  return{status:['committed','canceled','erased'].includes(state)?200:202,body:{wireVersion:2,requestId,operationKey:identity,eventId:identity,state,
   ...(historical?{historicalTransfer:{activationHash:historical.activationHash,manifestHash:historical.manifestHash}}:{}),
   custody:wireCustody,
   sync:{state:this.options.runtime.isReady()?'ready':'unavailable'},
   waitingMachines:(outcome?.waitingMachineIds??status.missingMembers).map(machineId=>this.machine(machineId)),coreType:record.coreType,
   ...(record.coreType==='graph-event'&&record.core.op==='create-effort'?{effort:record.core.subject,headerId:record.core.headerId}:{}),
   ...(state==='committed'?{certificate:record.certificate}:{}),...(undoToken?{undoToken}:{}),cancelEligible:!record.certificate&&!record.cancellationCertificate}};
 }
}
