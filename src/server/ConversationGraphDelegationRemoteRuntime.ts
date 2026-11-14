/** Actual remote launch bridge. Mesh queued means transport custody only;
 * only runtime.delegate's witnessed outcome describes graph persistence. */
import crypto from 'node:crypto';
import {SUPPORTED_FRAMEWORKS} from '../core/TopicFrameworksStore.js';
import {canonicalHash,canonicalJson} from '../core/GraphWitnessTypes.js';
import type {MeshEnvelope} from '../core/MeshRpc.js';
import {ConversationGraphRemoteDelegationSource,ConversationGraphRemoteDelegationIngress,
 type RemoteGraphDelegationRequest} from '../core/ConversationGraphDelegationRemote.js';
import {startCheckedTopicOnMachine,type CheckedTopicStartDeps} from '../core/dashboardMachineChoice.js';
import {createConversationGraphDelegationContext,type ConversationGraphDelegationCompositionOptions} from './ConversationGraphDelegationComposition.js';
import {ConversationGraphDelegationRuntime} from './ConversationGraphDelegationRuntime.js';

export class ConversationGraphDelegationRemoteRuntime {
 private readonly source:ConversationGraphRemoteDelegationSource;
 private readonly bindings:ConversationGraphDelegationRuntime;
 constructor(private readonly options:ConversationGraphDelegationCompositionOptions){
  const o=options;const {project,heads,scope}=createConversationGraphDelegationContext(o);
  const deps={agentId:o.agentId,identity:o.identity,state:o.state,bindAuth:o.bindAuth,conversations:o.conversations,
   telegramChatId:o.telegramChatId,conversationIdsForSession:(name:string)=>{const topic=o.telegram.getTopicForSession(name)??o.telegram.resolveTopicForSessionFromDisk(name);return topic===null?[]:[topic];},
   projectForConversation:project,ownershipForConversation:(ref:import('../core/ConversationGraphDelegation.js').GraphDelegationConversationRef)=>ref.platform==='telegram'&&ref.chatId===o.telegramChatId?o.ownership.read(String(ref.topicId)):null,
   ownerPublicKey:o.ownerPublicKey};
  this.source=new ConversationGraphRemoteDelegationSource(deps);
  this.bindings=new ConversationGraphDelegationRuntime({source:{...deps,admission:o.admission,coordinator:o.coordinator},tmuxPath:o.tmuxPath,verifiedHeadsFor:heads,parentProjectScope:scope});
  const ingress=new ConversationGraphRemoteDelegationIngress({...deps,stateDir:o.state.baseDir,admission:o.admission,coordinator:o.coordinator,
   membership:()=>o.runtime.installedMembership,leaseBridge:()=>o.runtime.actuation().lease,verifiedHeadsFor:heads,parentProjectScope:scope});
  o.runtime.setRemoteDelegationIntake(async(source,token)=>{
   const prepared=ingress.prepare(source);if(prepared.status!=='proposed')throw new Error(`graph-remote-delegation-${prepared.status}`);
   const bytes=Buffer.from(canonicalJson(source));try{return await o.runtime.submitPrepared({coreType:'graph-event',idempotencyKey:prepared.authorizationProof.receipt.idempotencyKey,
    requestHash:canonicalHash({core:prepared.core,source}),core:prepared.core,authorizationProof:prepared.authorizationProof,plaintextSource:bytes},token);}finally{bytes.fill(0);}
  });
 }
 private timer:ReturnType<typeof setInterval>|null=null;
 private ticking=false;
 beforeReceipt(envelope:MeshEnvelope):void {
  if(envelope.command.type!=='deliverMessage')return;
  const payload=envelope.command.payload;
  if(!payload||typeof payload!=='object'||!('graphDelegationRequest' in payload))return;
  const launch=(payload as Record<string,unknown>).graphDelegationLaunch;
  if(!launch||typeof launch!=='object'||Array.isArray(launch))throw new Error('graph-remote-launch-invalid');
  const l=launch as Record<string,unknown>;
  if(Object.keys(l).some(key=>!['name','prompt','model','framework'].includes(key))||typeof l.name!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(l.name)
   ||typeof l.prompt!=='string'||!l.prompt||l.prompt.length>500000||(l.model!==undefined&&(typeof l.model!=='string'||l.model.length>200))
   ||(l.framework!==undefined&&!(SUPPORTED_FRAMEWORKS as readonly unknown[]).includes(l.framework)))throw new Error('graph-remote-launch-invalid');
  this.source.admitDispatch({request:(payload as {graphDelegationRequest:RemoteGraphDelegationRequest}).graphDelegationRequest,membership:this.options.runtime.installedMembership,originalMeshEnvelope:envelope});
 }
 start():void{if(this.timer)return;this.timer=setInterval(()=>{void this.replay();},15000);this.timer.unref();void this.replay();}
 close():void{if(this.timer)clearInterval(this.timer);this.timer=null;}
 async replay():Promise<void>{if(this.ticking)return;this.ticking=true;try{
  for(const request of this.source.pendingRequests(this.options.runtime.installedMembership)){
   if(request.workerRef.platform!=='telegram')continue;
   const tmux=this.options.telegram.getSessionForTopic(request.workerRef.topicId);
   const worker=tmux&&this.options.state.findSessionByTmux(tmux);if(!worker||worker.status!=='running')continue;
   try{await this.afterSuccessfulSpawn(request,undefined,worker.id);}catch{/* durable pending; no worker/proof/Saved invented */}
  }
 }catch{/* malformed bounded dispatch inventory holds; no unverified worker is captured */}finally{this.ticking=false;}}
 private placement:Omit<CheckedTopicStartDeps,'makeDelivery'>|null=null;
 setPlacement(placement:Omit<CheckedTopicStartDeps,'makeDelivery'>):void{if(this.placement)throw new Error('graph-remote-placement-already-installed');this.placement=placement;}
 async dispatch(input:{parentBindToken:unknown;topicId:number;targetMachineId:string;launch:Record<string,unknown>},placement=this.placement){
  if(!placement)throw new Error('graph-remote-placement-unavailable');
  const o=this.options;
  if(typeof input.parentBindToken!=='string'||!Number.isSafeInteger(input.topicId)||input.topicId<=0
   ||input.targetMachineId===o.identity.loadIdentity().machineId||!o.runtime.installedMembership.members.some(member=>member.machineId===input.targetMachineId)
   ||!o.identity.isMachineActive(input.targetMachineId))throw new Error('graph-remote-spawn-target-refused');
  const proof=o.bindAuth.verify(input.parentBindToken);const parent=proof&&o.state.findSessionByTmux(proof.sessionName);const parentRef=proof&&this.bindings.refFor(proof);
  if(!proof||!parent||parent.status!=='running'||!parentRef)throw new Error('graph-remote-spawn-parent-required');
  const parentOwnership=o.ownership.read(parentRef.platform==='telegram'?String(parentRef.topicId):'');
  if(parentOwnership?.status!=='active'||parentOwnership.ownerMachineId!==o.identity.loadIdentity().machineId)throw new Error('graph-remote-spawn-parent-ownership-required');
  const {project}=createConversationGraphDelegationContext(o);project(parentRef);project({kind:'conversation',platform:'telegram',chatId:o.telegramChatId,topicId:input.topicId});
  const lease=o.coordinator.currentLease();if(!lease)throw new Error('graph-remote-spawn-lease-required');
  const sourceId=`remote-spawn-${crypto.randomUUID()}`;
  return startCheckedTopicOnMachine({...placement,makeDelivery:()=>{
   const request=this.source.createRequest({sourceId,parentSessionId:parent.id,parentBindToken:input.parentBindToken as string,parentRef,
    workerRef:{kind:'conversation',platform:'telegram',chatId:o.telegramChatId,topicId:input.topicId},targetMachineId:input.targetMachineId,membership:o.runtime.installedMembership,graphLease:lease});
   return {messageId:sourceId,payload:{graphDelegationRequest:request,graphDelegationLaunch:input.launch}};
  }},String(input.topicId),input.targetMachineId);
 }
 /** Caller must pass the untouched verified MeshEnvelope and the ID returned by
  * the actual successful persisted spawn, after normal topic/ownership binding. */
 async afterSuccessfulSpawn(request:RemoteGraphDelegationRequest,envelope:MeshEnvelope|undefined,workerSessionId:string){
  const worker=this.options.state.getSession(workerSessionId);if(!worker||worker.status!=='running')throw new Error('graph-remote-spawn-worker-required');
  const token=await this.bindings.environment(worker.tmuxSession,'INSTAR_BIND_TOKEN');
  const sessionId=await this.bindings.environment(worker.tmuxSession,'INSTAR_SESSION_ID');
  if(!token||sessionId!==worker.id)throw new Error('graph-remote-spawn-bootstrap-required');
  const source=this.source.attestSuccessfulSpawn({request,membership:this.options.runtime.installedMembership,originalMeshEnvelope:envelope,workerSessionId,workerBindToken:token});
  return this.options.runtime.delegate(source);
 }
}
