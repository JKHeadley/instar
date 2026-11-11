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

/** The one answer every graph route gives while Conversations is configured
 * off here: 503 `conversation-graph-off`, the code the history route already
 * uses for not-ready, so the dashboard says it is not switched on rather than
 * reading Express's HTML 404 as an unavailable conversation. Mounted after the
 * auth middleware, so an unauthenticated request is still refused first.
 *
 * It is a fallback only: it answers a graph request that nothing else handles.
 * AgentServer mounts it last, just before the error handler, and it steps aside
 * (next()) for any non-error layer added to the same app after it, so a graph
 * route registered later is never shadowed. */
export const CONVERSATION_GRAPH_PATH=/^\/(?:mobile\/)?conversation-graph(?:\/|$)/;
export function createConversationGraphOffRouter():Router{
 const router=Router();
 router.all(CONVERSATION_GRAPH_PATH,(req,res,next)=>{
  if(laterLayerMayHandle(req,router))return next();
  res.setHeader('Cache-Control','no-store');res.status(503).json({code:'conversation-graph-off'});
 });
 return router;
}

/** Express 4 app stack layer, as far as this check reads it. */
type AppLayer={handle:unknown;route?:{_handles_method?(method:string):boolean};match(path:string):boolean};
/** True when a non-error layer registered after `self` in the request's app
 * matches this request: a route for this path and method, or a middleware or
 * router mounted on a matching path. A later pathless middleware matches every
 * path, so it also makes the fallback step aside. Error handlers (four
 * arguments) do not count. An unreadable stack counts as nothing later. */
function laterLayerMayHandle(req:import('express').Request,self:Router):boolean{
 const stack=(req.app as unknown as {_router?:{stack?:AppLayer[]}})._router?.stack;
 if(!Array.isArray(stack))return false;
 const at=stack.findIndex(layer=>layer.handle===self);if(at<0)return false;
 // The path as this app's own stack matches it: no absolute-form origin, no query,
 // and without the prefix this app is mounted under when it is a sub-app.
 const full=req.originalUrl.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i,'').split('?')[0]||'/';
 const mount=req.app.path();
 const pathname=mount&&full.startsWith(mount)?full.slice(mount.length)||'/':full;
 for(const layer of stack.slice(at+1)){
  if(typeof layer.handle==='function'&&(layer.handle as (...args:unknown[])=>unknown).length===4)continue;
  if(!layer.match(pathname))continue;
  if(layer.route&&!(layer.route._handles_method?.(req.method)??true))continue;
  return true;
 }
 return false;
}

export function createConversationGraphSurface(options:{
 stateDir:string;agentId:string;runtime:ConversationGraphReplicationRuntime;
 readEnabled?:boolean;correctionsEnabled?:boolean;identity:MachineIdentityManager;
 scope:ScopeVerifier|null;telegramChatId:string;pairing:MobilePairingService|null;
 verifyDashboardOwner(token:string|undefined):boolean;
 /** Live operator policy; absence preserves the older admitted-only adapter. */
 dashboardPolicy?:()=>ConversationGraphOwnerPolicySnapshot|null;initializeDashboardPolicy?:()=>void;forceFileKey?:boolean;
 history?:Pick<ConversationGraphHistoryDeps,'selfMachineId'|'localBaseUrl'|'peers'|'authToken'|'agentId'|'peerHostAllowlist'|'recordRopeResult'>;
}):Router{
 if(options.readEnabled!==true)return createConversationGraphOffRouter();
 const router=Router();
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
