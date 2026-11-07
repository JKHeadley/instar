/** Owner route for removing a permanently lost machine. Every step reuses the action,
 * preflight, native and execution components, so this file grants no permission of its
 * own: it only runs them in order and reports where they got to. */
import type {Request,Response} from 'express';
import {verifiedEntityName} from '../messaging/shared/channelIdentity.js';
import {SecretStore} from '../core/SecretStore.js';
import {GraphMemberLossHeldPreflight} from '../core/GraphMemberLossHeldPreflight.js';
import {GraphNativeMemberLossStore,type GraphNativeMemberLossProgress} from '../core/GraphNativeMemberLossStore.js';
import type {GraphOwnerMemberLossContext} from '../core/GraphOwnerMemberLoss.js';
import type {MobilePairingService} from './mobilePairingRoutes.js';
import type {ConversationGraphDefault} from './ConversationGraphDefault.js';
import type {ConversationGraphOwnerGrantStore} from './ConversationGraphOwnerGrant.js';
import {GraphOwnerMemberLossActionService,type GraphOwnerMemberLossAction,type GraphOwnerMemberLossIntent} from './GraphOwnerMemberLossAction.js';
import {GraphOwnerMemberLossExecution} from './GraphOwnerMemberLossExecution.js';
import {applyOwnerMemberLossNativeAdministration} from './GraphOwnerMemberLossNativeAdministration.js';
import {GraphOwnerMemberLossPlanning} from './GraphOwnerMemberLossPlanning.js';

type Surface='dashboard'|'mobile';
type Job={state:'running'|'failed'|'done';removed:string[];failure:string|null};
const ROUTE=/^\/(?:mobile\/)?conversation-graph\/member-loss\/(prepare|confirm|cancel|status)$/;
const opaqueFailure=(error:unknown)=>error instanceof Error&&/^[a-z0-9-]{1,96}$/.test(error.message)?error.message:'member-loss-failed';

/** The whole removal in order. The route and the historical proof both run this, so a
 * missing step fails a test instead of freezing a real graph. */
export async function removeLostMachine(options:{manager:ConversationGraphDefault;stateDir:string;intent:GraphOwnerMemberLossIntent;resumed:GraphOwnerMemberLossAction|null;progress:GraphNativeMemberLossProgress|null}){
 const {manager,stateDir,intent,resumed,progress}=options,actual=manager.memberLossPlanningComponents(),native=manager.nativeDelegationDependencies,runtime=manager.runtime;
 if(!actual||!native||!runtime)throw new Error('member-loss-planning-runtime-unavailable');
 const {authority}=actual,scope=intent.scope,context:GraphOwnerMemberLossContext={ownerPublicKey:authority.ownerPublicKey,previousPublicationHash:scope.previousPublicationHash,previousMembership:scope.previousMembership,newMembership:scope.newMembership,nativeIdentities:scope.nativeIdentities};
 const existing=heldRemoval(manager),holds=existing?.row.holds.length?existing.row.holds:[authority.beginMemberLossHold(intent.intentProof,context,runtime.machineId,native.identity.loadSigningKey())];
 const snapshot=await runtime.source.verifyMemberLossInventory(runtime.reader,runtime.droppedOriginRegistry,runtime.intake,authority,intent.intentProof);
 let preflight:GraphMemberLossHeldPreflight;
 try{preflight=progress&&resumed?GraphMemberLossHeldPreflight.resume({authority,snapshot,context,intent:intent.intentProof,holds,consent:resumed.consent,progress}):GraphMemberLossHeldPreflight.collect({authority,snapshot,context,intent:intent.intentProof,holds});}catch(error){snapshot.close();throw error;}
 try{
  const action=resumed??await intent.finalizeConsent(preflight),nativeStore=new GraphNativeMemberLossStore({stateDir,identity:native.identity,identities:native.identities,instanceLock:native.instanceLock,authority}),executor=new GraphOwnerMemberLossExecution(manager);
  // Everything that can refuse runs before the native step, which cannot be undone.
  await executor.prepareHistoricalArchive(preflight);executor.assertSupportedPreflight(preflight);
  const administered=await applyOwnerMemberLossNativeAdministration({action,intent,preflight,store:nativeStore,identity:native.identity,identities:native.identities,coordinator:native.leaseCoordinator});
  const result=await executor.execute({intent,action,preflight,snapshot,nativeStore,native:administered});
  // The removal itself is complete here. A restart loads the new membership if this step fails.
  try{await manager.installCompletedMemberLoss(result.activation,result.custody);}catch{throw new Error('member-loss-restart-needed');}
  return result;
 }finally{preflight.close();}
}
/** A removal still in progress. Completed ones stay on disk as history, so only the next epoch counts. */
function heldRemoval(manager:ConversationGraphDefault){
 const actual=manager.memberLossPlanningComponents();if(!actual)return null;
 const lineage=actual.authority.verifiedNegativeRoleLineage(),row=lineage.memberLossIntents.find(value=>value.newMembership.epoch===lineage.positiveCurrent.epoch+1);if(!row)return null;
 const context:GraphOwnerMemberLossContext={ownerPublicKey:actual.authority.ownerPublicKey,previousPublicationHash:actual.authority.publicationHash,previousMembership:row.previousMembership,newMembership:row.newMembership,nativeIdentities:row.nativeIdentities};
 return {row,context,authority:actual.authority};
}

export class ConversationGraphMemberLossSurface {
 private job:Job|null=null;private serviceValue:GraphOwnerMemberLossActionService|null=null;private serviceIdentity:unknown=null;
 constructor(private readonly options:{manager:ConversationGraphDefault;stateDir:string;forceFileKey?:boolean;grants:ConversationGraphOwnerGrantStore;pairing:MobilePairingService|null;verifyDashboardOwner(token:string|undefined):boolean;initializeDashboardPolicy?():void}){}
 static handles(path:string):boolean{return ROUTE.test(path);}
 private service():GraphOwnerMemberLossActionService{
  const {manager,stateDir,forceFileKey,grants,pairing,verifyDashboardOwner,initializeDashboardPolicy}=this.options,native=manager.nativeDelegationDependencies;
  if(!native)throw new Error('member-loss-planning-runtime-unavailable');
  if(!this.serviceValue||this.serviceIdentity!==native.identities){
   this.serviceValue=new GraphOwnerMemberLossActionService({stateDir,agentId:manager.agentId,identity:native.identity,identities:native.identities,secrets:new SecretStore({stateDir,forceFileKey}),grants,pairing,verifyDashboardOwner,initializeDashboardPolicy,signingContext:(ids,id,plan)=>new GraphOwnerMemberLossPlanning(manager).context(ids,id,plan)});
   this.serviceIdentity=native.identities;
  }
  return this.serviceValue;
 }
 /** A removal already held from an earlier attempt or before a restart. */
 private held(){return heldRemoval(this.options.manager);}
 private store(){
  const actual=this.options.manager.memberLossPlanningComponents(),native=this.options.manager.nativeDelegationDependencies;if(!actual||!native)throw new Error('member-loss-planning-runtime-unavailable');
  return new GraphNativeMemberLossStore({stateDir:this.options.stateDir,identity:native.identity,identities:native.identities,instanceLock:native.instanceLock,authority:actual.authority});
 }
 /** The execution path finishes only with exactly one survivor, so anything else is refused before a hold exists. */
 private assertOneSurvivor(removed:unknown):void{
  const actual=this.options.manager.memberLossPlanningComponents();if(!actual)throw new Error('member-loss-planning-runtime-unavailable');
  const ids=Array.isArray(removed)?new Set(removed):new Set(),left=actual.authority.currentMembership().members.filter(member=>!ids.has(member.machineId));
  if(left.length!==1)throw new Error('member-loss-one-survivor-only');
 }
 private resumeRequest(){const row=this.held()?.row;if(!row)return null;return{requestId:row.intent.payload.requestId,removedMachineIds:row.intent.payload.removed.map(member=>member.machineId)};}
 /** Nothing irreversible has started, so the owner can still keep the machine. */
 private cancellable():boolean{try{const held=this.held();return !!held&&!held.authority.memberLossDisclosed()&&this.store().readProgressForIntent(held.row.intent,held.context)===null;}catch{/* @silent-fallback-ok: unknown state is reported as not cancellable, which is the safe answer */return false;}}
 private status(){
  let held=false;try{held=this.held()!==null;}catch{/* @silent-fallback-ok: status read only; every action re-reads and refuses */held=false;}
  const removed=this.job?.removed??[],actual=this.options.manager.memberLossPlanningComponents(),identity=this.options.manager.identity,self=identity?.loadIdentity().machineId,registry=identity?.loadRegistry().machines??{};
  let current:ReturnType<NonNullable<typeof actual>['authority']['currentMembership']>|null=null;try{current=actual?actual.authority.currentMembership():null;}catch{/* @silent-fallback-ok: status read only; an unreadable roster shows no machines */current=null;}
  const members=current?current.members.map(member=>{const row=registry[member.machineId];return{machineId:member.machineId,name:verifiedEntityName(member.machineId,row?.nickname??row?.name)||'Agent machine',self:member.machineId===self};}):[];
  return {state:this.job?.state??(held?'interrupted':'none'),held,removed,failure:this.job?.state==='failed'?this.job.failure:null,members,resume:held?this.resumeRequest():null,cancellable:this.job?.state!=='running'&&this.cancellable()};
 }
 /** Returns false when this is not one of its routes. */
 async handle(req:Request,res:Response,surface:Surface):Promise<boolean>{
  const match=ROUTE.exec(req.path);if(!match)return false;const action=match[1];
  if(action==='status'){if(req.method!=='GET')return res.status(405).json({code:'method-not-allowed'}),true;res.json(this.status());return true;}
  if(req.method!=='POST')return res.status(405).json({code:'method-not-allowed'}),true;
  if(this.job?.state==='running')return res.status(409).json({code:'member-loss-running'}),true;
  try{
   if(action==='cancel'){
    const held=this.held();if(!held)return res.status(409).json({code:'member-loss-not-held'}),true;
    if(!this.cancellable())return res.status(409).json({code:'member-loss-must-finish'}),true;
    held.authority.withdrawMemberLossHold(held.row.intent);this.job=null;void this.options.manager.runtime?.refreshReadiness().catch(()=>{});res.json({state:'none'});return true;
   }
   if(action==='prepare'){
    const held=this.held();if(!held)this.assertOneSurvivor(req.body?.removedMachineIds);
    res.json(await this.service().prepare(req,surface,req.body));return true;
   }
  }catch(error){/* @silent-fallback-ok: the refusal is the answer, returned to the owner as a code */res.status(409).json({code:opaqueFailure(error)});return true;}
  // Claimed before the first await, so two devices cannot both start a removal.
  const prior=this.job,job:Job={state:'running',removed:[],failure:null};this.job=job;
  try{
   const held=this.held();if(!held)this.assertOneSurvivor(req.body?.confirmedMachineIds);
   const progress=held?this.store().readProgressForIntent(held.row.intent,held.context):null;
   let intent:GraphOwnerMemberLossIntent,resumed:GraphOwnerMemberLossAction|null=null;
   if(progress){const capabilities=await this.service().resume(req,surface,req.body,progress);intent=capabilities.intent;resumed=capabilities.action;}
   else intent=await this.service().confirm(req,surface,req.body);
   job.removed=intent.scope.removed.map(row=>row.machineId);
   void removeLostMachine({manager:this.options.manager,stateDir:this.options.stateDir,intent,resumed,progress}).then(()=>{job.state='done';},error=>{job.state='failed';job.failure=opaqueFailure(error);console.warn(`[conversation-graph] machine removal stopped: ${job.failure}`);});
   res.status(202).json({state:'running',removed:job.removed});return true;
  // The owner was already checked by the surface. 403 here would make the dashboard forget its session for a refusal that has nothing to do with it.
  }catch(error){/* @silent-fallback-ok: the refusal is the answer, returned to the owner as a code */this.job=prior;res.status(409).json({code:opaqueFailure(error)});return true;}
 }
}
