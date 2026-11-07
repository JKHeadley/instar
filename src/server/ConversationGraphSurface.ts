/** Default-off production composition. Enabling this surface is a release
 * action after increment-A acceptance; readiness is still checked per read.
 * Storage initialization alone never mounts a public graph route. */
import {Router} from 'express';
import {SecretStore} from '../core/SecretStore.js';
import type {MachineIdentityManager} from '../core/MachineIdentity.js';
import type {ScopeVerifier} from '../core/ScopeVerifier.js';
import {nodeKey,decodeRouteRef,validateNodeRef,type ProjectionItem} from '../core/conversationGraph.js';
import {ConversationGraphReadModel} from '../core/conversationGraphRead.js';
import type {MobilePairingService} from './mobilePairingRoutes.js';
import type {ConversationGraphReplicationRuntime} from './ConversationGraphReplicationRuntime.js';
import {ConversationGraphHeaderCustody} from './ConversationGraphHeaderCustody.js';
import {ConversationGraphRuntimeReadSource} from './ConversationGraphReadSource.js';
import {ConversationGraphOwnerChanges} from './ConversationGraphOwnerChanges.js';
import {createConversationGraphViewerResolver} from './conversationGraphViewer.js';
import {createConversationGraphOwnerAdmission} from './ConversationGraphOwnerAdmission.js';
import {ConversationGraphOwnerGrantStore} from './ConversationGraphOwnerGrant.js';
import type {ConversationGraphOwnerPolicySnapshot} from '../core/ConversationGraphOwnerPolicy.js';
import {createConversationGraphRouter} from './conversationGraphRoutes.js';
import {createConversationGraphChangeRouter} from './conversationGraphChangeRoutes.js';
import {createConversationGraphHistoryRoutes,type ConversationGraphHistoryDeps} from './conversationGraphHistoryRoutes.js';

export function createConversationGraphSurface(options:{
 stateDir:string;agentId:string;runtime:ConversationGraphReplicationRuntime;
 readEnabled?:boolean;correctionsEnabled?:boolean;identity:MachineIdentityManager;
 scope:ScopeVerifier|null;telegramChatId:string;pairing:MobilePairingService|null;
 verifyDashboardOwner(token:string|undefined):boolean;
 /** Live operator policy; absence preserves the older admitted-only adapter. */
 dashboardPolicy?:()=>ConversationGraphOwnerPolicySnapshot|null;initializeDashboardPolicy?:()=>void;forceFileKey?:boolean;
 history?:Pick<ConversationGraphHistoryDeps,'selfMachineId'|'localBaseUrl'|'peers'|'authToken'|'agentId'|'peerHostAllowlist'|'recordRopeResult'>;
}):Router{
 const router=Router();
 if(options.readEnabled!==true)return router;
 const runtime=options.runtime;
 const resolveViewer=createConversationGraphViewerResolver(options);
 const custody=new ConversationGraphHeaderCustody(options.stateDir,runtime);
 const corrections=options.correctionsEnabled===true&&options.scope!==null;
 const localIntents=corrections&&typeof options.dashboardPolicy==='function';
 const source=new ConversationGraphRuntimeReadSource(runtime,custody,{correctionsEnabled:corrections,erasureEnabled:corrections,localIntentsEnabled:localIntents});
 const model=new ConversationGraphReadModel(source);
 router.use(createConversationGraphRouter({model,resolveViewer}));
 if(options.history)router.use(createConversationGraphHistoryRoutes({...options.history,
  ready:()=>runtime.isReady(),verifyOwner:req=>resolveViewer(req,'dashboard')!==null,
  resolveSource:(routeRef,req)=>{
   const viewer=resolveViewer(req,'dashboard'),ref=decodeRouteRef(routeRef);if(!viewer||!ref||ref.kind!=='conversation')return null;
   const result=model.node(viewer,ref,{});if(result.status!==200)return null;
   const node=result.body.node as ProjectionItem|undefined;
   return node?.source??null;
  }}));
 if(corrections){
  const ownerAdmission=localIntents?createConversationGraphOwnerAdmission({agentId:options.agentId,machineId:runtime.machineId,
   pairing:options.pairing,resolveViewer,initializeDashboardPolicy:options.initializeDashboardPolicy,
   grants:new ConversationGraphOwnerGrantStore({stateDir:options.stateDir,agentId:options.agentId,
    secrets:new SecretStore({stateDir:options.stateDir,forceFileKey:options.forceFileKey}),dashboardPolicy:options.dashboardPolicy!}),
   remoteCurrent:async intent=>{
    const current=await runtime.recordedOwnerIntentCurrent(intent);
    return current===null?{state:'unavailable'}:current?{state:'authorized',viewer:{principalKey:intent.principalKey,
     grantVersion:intent.grantVersion,mayView:ref=>validateNodeRef(ref)!==null}}:{state:'refused'};
   }}):null;
  if(ownerAdmission)runtime.setRecordedOwnerIntentAuthority(intent=>ownerAdmission.currentRecordedIntent(intent));
  const changes=new ConversationGraphOwnerChanges({runtime,identity:options.identity,membership:()=>runtime.installedMembership,
   dropped:runtime.droppedOriginRegistry,scope:options.scope!,telegramChatId:options.telegramChatId,resolveViewer,
   hasConversation:ref=>runtime.inventory().conversations.some(row=>nodeKey(row.ref)===nodeKey(ref)),
   headerVersion:headerId=>{custody.synchronize();return custody.get(headerId);},
   ...(ownerAdmission?{captureOwnerIntent:ownerAdmission.capture,resolveQueuedOwner:ownerAdmission.resolve}:{})});
  router.use(createConversationGraphChangeRouter({changes,resolveViewer}));
 }
 return router;
}
