/** Owner-authenticated lazy composition; release gating remains outside storage. */
import crypto from 'node:crypto';
import {Router,type Request,type Response} from 'express';
import {verifiedEntityName} from '../messaging/shared/channelIdentity.js';
import {SecretStore} from '../core/SecretStore.js';
import {canonicalHash,exactFields} from '../core/GraphWitnessTypes.js';
import {parseGraphOwnerChange} from '../core/ConversationGraphOwnerIntent.js';
import type {GraphQueuedIntentView} from '../core/ConversationGraphQueuedIntent.js';
import {ConversationGraphOwnerGrantStore} from './ConversationGraphOwnerGrant.js';
import {createConversationGraphOwnerAdmission} from './ConversationGraphOwnerAdmission.js';
import type {GraphViewer} from '../core/conversationGraphRead.js';
import type {ConversationGraphDefault} from './ConversationGraphDefault.js';
import {createConversationGraphSurface} from './ConversationGraphSurface.js';
import {createConversationGraphViewerResolver} from './conversationGraphViewer.js';
import {ConversationGraphMemberLossSurface} from './ConversationGraphMemberLossSurface.js';
import type {ConversationGraphReplicationRuntime} from './ConversationGraphReplicationRuntime.js';
export function createConversationGraphDefaultSurface(options:Omit<Parameters<typeof createConversationGraphSurface>[0],'agentId'|'runtime'|'identity'> & {manager:ConversationGraphDefault;onRuntime?(runtime:ConversationGraphReplicationRuntime):void}):Router{
 const router=Router();if(options.readEnabled!==true)return router;
 const resolveViewer=createConversationGraphViewerResolver({...options,agentId:options.manager.agentId});let mounted:Router|null=null,mountedRuntime:ConversationGraphReplicationRuntime|null=null;
 const grants=options.dashboardPolicy?new ConversationGraphOwnerGrantStore({stateDir:options.stateDir,agentId:options.manager.agentId,secrets:new SecretStore({stateDir:options.stateDir,forceFileKey:options.forceFileKey}),dashboardPolicy:options.dashboardPolicy}):null;
 const memberLoss=grants&&options.correctionsEnabled===true?new ConversationGraphMemberLossSurface({manager:options.manager,stateDir:options.stateDir,forceFileKey:options.forceFileKey,grants,pairing:options.pairing??null,verifyDashboardOwner:options.verifyDashboardOwner??(()=>false),initializeDashboardPolicy:options.initializeDashboardPolicy}):null;
 const mount=(runtime:ConversationGraphReplicationRuntime)=>{
  if(mounted&&mountedRuntime===runtime)return;
  const identity=options.manager.identity;if(!identity)throw new Error('graph-default-identity-unavailable');
  mounted=createConversationGraphSurface({...options,agentId:options.manager.agentId,runtime,identity,...(options.history?{history:{...options.history,selfMachineId:runtime.machineId,agentId:options.manager.agentId}}:{})});mountedRuntime=runtime;options.onRuntime?.(runtime);
 };
 // Install actual queue/current-owner adapters on the native holder even when
 // only a follower receives HTTP visits. This does not issue any owner grant.
 options.manager.subscribeRuntime(mount);
 async function provisional(req:Request,res:Response,surface:'dashboard'|'mobile',owner:GraphViewer,isCurrent:()=>boolean,localReady:()=>void):Promise<boolean>{
  if(options.correctionsEnabled!==true||!grants)return false;
  const prefix=surface==='mobile'?'/mobile/conversation-graph':'/conversation-graph',path=req.path.slice(prefix.length),id=typeof req.body?.requestId==='string'?req.body.requestId:crypto.randomUUID(),spool=await options.manager.enrolledSpool({principalKey:owner.principalKey,authenticationMethod:surface==='mobile'?'owner-device':'owner-dashboard',requestId:id,isCurrent});
  if(isCurrent())localReady();
  const key=(requestId:string)=>'owner-change:'+canonicalHash({principal:owner.principalKey,requestId});
  const machine=(machineId:string)=>{const row=options.manager.identity?.loadRegistry().machines[machineId];return{machineId,name:verifiedEntityName(machineId,row?.nickname??row?.name)||'Agent machine'};};
  const waiting=()=>Object.entries(options.manager.identity?.loadRegistry().machines??{}).filter(([id,row])=>row.status==='active'&&!row.revokedAt&&id!==options.manager.identity?.loadIdentity().machineId&&!options.manager.unjoinedMachines().includes(id)).map(([id])=>machine(id));
  const reply=(view:GraphQueuedIntentView)=>({wireVersion:2,requestId:view.requestId,operationKey:view.operationKey,state:view.state,recordedAt:view.recordedAt,custody:{kind:'recorded-here',machine:machine(view.recordedMachineId)},cancelEligible:view.cancelEligible,sync:{state:'unavailable'},waitingMachines:waiting(),details:view.details,...(view.change&&view.mayServeDetails()&&view.visibleTo(ref=>owner.mayView(ref))?{localIntent:{v:1,change:view.change,...(view.createdEffort?{createdEffort:view.createdEffort}:{})}}:{}),...(view.refusalCode?{reason:view.refusalCode}:{})});
  let status=200,body:unknown;
  if(req.method==='POST'&&path==='/changes'){
   if(!exactFields(req.body,['requestId','change'])||typeof req.body.requestId!=='string'||!/^[A-Za-z0-9_.:-]{8,160}$/.test(req.body.requestId))return res.status(400).json({code:'invalid-change-request'}),true;
   const change=parseGraphOwnerChange(req.body.change);if(!change)return res.status(400).json({code:'invalid-change'}),true;
   const identity=options.manager.identity;if(!identity)throw new Error('graph-enrollment-unavailable');
   const admission=createConversationGraphOwnerAdmission({agentId:options.manager.agentId,machineId:identity.loadIdentity().machineId,pairing:options.pairing,grants,resolveViewer}).capture(req,surface,key(req.body.requestId));if(!admission||!isCurrent())return res.status(403).json({code:'hierarchy-owner-only'}),true;
   let headerId:string|undefined;if(change.kind==='set-effort-title'){const effortId=change.effort.kind==='effort'?change.effort.id:null;const creation=(await spool.list(owner.principalKey)).find(item=>item.visibleTo(ref=>owner.mayView(ref))&&item.mayServeDetails()&&item.createdEffort?.ref.id===effortId);headerId=creation?.createdEffort?.headerId;if(!headerId)return res.status(503).json({code:'header-target-unverified'}),true;}
   const view=await spool.record({idempotencyKey:key(req.body.requestId),requestId:req.body.requestId,principalKey:owner.principalKey,grantVersion:canonicalHash(admission),admission,surface,change,...(headerId?{headerId}:{})},isCurrent);if(!view.visibleTo(ref=>owner.mayView(ref)))return res.status(404).json({code:'unknown-request'}),true;body=reply(view);status=view.state==='recorded-local'?202:200;
  }else if(req.method==='GET'&&path==='/pending'){
   const offset=Number(req.query.offset??0);if(!Number.isSafeInteger(offset)||offset<0)return res.status(400).json({code:'invalid-pending-offset'}),true;
   const items=(await spool.list(owner.principalKey)).filter(item=>item.visibleTo(ref=>owner.mayView(ref))&&(item.state==='recorded-local'||item.state==='refused-local'));body={items:items.slice(offset,offset+64).map(reply),total:items.length,nextOffset:offset+64<items.length?offset+64:null};
  }else if(req.method==='GET'&&/^\/changes\/[^/]+$/.test(path)){
   const requestId=decodeURIComponent(path.slice('/changes/'.length));if(!/^[A-Za-z0-9_.:-]{8,160}$/.test(requestId))return res.status(400).json({code:'invalid-request-id'}),true;
   const item=await spool.status(key(requestId),owner.principalKey);if(!item||!item.visibleTo(ref=>owner.mayView(ref)))return res.status(404).json({code:'unknown-request'}),true;body=reply(item);status=item.state==='recorded-local'?202:200;
  }else if(req.method==='POST'&&/^\/changes\/[^/]+\/cancel$/.test(path)){
   if(!exactFields(req.body??{},[]))return res.status(400).json({code:'invalid-cancel-request'}),true;const operationKey=decodeURIComponent(path.slice('/changes/'.length,-'/cancel'.length));if(!operationKey.startsWith('queued:'))return false;const before=await spool.status(operationKey.slice('queued:'.length),owner.principalKey);if(!before||!before.visibleTo(ref=>owner.mayView(ref)))return res.status(404).json({code:'unknown-request'}),true;body=reply(await spool.finish(operationKey.slice('queued:'.length),owner.principalKey,{state:'canceled-local'},isCurrent));
  }else return false;
  if(!isCurrent())return res.status(403).json({code:'hierarchy-owner-only'}),true;res.status(status).json(body);return true;
 }
 router.use(async(req,res,next)=>{
  if(!/^\/(?:mobile\/)?conversation-graph(?:\/|$)/.test(req.path))return next();
  const surface=req.path.startsWith('/mobile/')?'mobile':'dashboard',owner=resolveViewer(req,surface);res.setHeader('Cache-Control','no-store');if(!owner)return void res.status(403).json({code:'hierarchy-owner-only'});
  const isCurrent=()=>{const current=resolveViewer(req,surface);return current!==null&&current.principalKey===owner.principalKey&&current.grantVersion===owner.grantVersion;};
  // A configured correction switch is not evidence that local sealing and
  // enrolled intake can actually open for this request.
  let recordLocal=false;
  try{
   if(surface==='dashboard')options.initializeDashboardPolicy?.();if(!isCurrent())return void res.status(403).json({code:'hierarchy-owner-only'});
   const runtime=await options.manager.ensureOwner({principalKey:owner.principalKey,authenticationMethod:surface==='mobile'?'owner-device':'owner-dashboard',requestId:crypto.randomUUID(),isCurrent});
   if(!isCurrent())return void res.status(403).json({code:'hierarchy-owner-only'});const identity=options.manager.identity;if(!identity)throw new Error('graph-default-identity-unavailable');
   mount(runtime);
   if(memberLoss&&ConversationGraphMemberLossSurface.handles(req.path)&&await memberLoss.handle(req,res,surface))return;
   return mounted!(req,res,next);
  }catch{if(!isCurrent())return void res.status(403).json({code:'hierarchy-owner-only'});try{if(await provisional(req,res,surface,owner,isCurrent,()=>{recordLocal=true;}))return;}catch{if(!isCurrent())return void res.status(403).json({code:'hierarchy-owner-only'});}res.status(503).json({code:'conversation-graph-pending',reason:'owned-custody-pending',capabilities:{recordLocal,canonical:false},...(options.manager.awaitingJoin?{awaitingJoin:true}:{})});}
 });return router;
}
