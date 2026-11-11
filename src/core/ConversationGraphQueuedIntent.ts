/** Sequence-free owner intent custody. This is the pre-admission part of Intake,
 * never a second graph store: no packet, source receipt, journal or canonical
 * effect exists until the actual writer promotes through the existing engine. */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {assertGraphLocalPath,ensureGraphLocalDirectory} from './GraphLocalFiles.js';
import path from 'node:path';
import {MachineIdentityManager,base64ToSigningPem,base64ToEncryptionPem} from './MachineIdentity.js';
import {IdentityStore} from './IdentityStore.js';
import {ConversationGraphLocalErasureFence} from './ConversationGraphLocalErasure.js';
import {SafeFsExecutor} from './SafeFsExecutor.js';
import {parseGraphOwnerChange,type GraphOwnerChange} from './ConversationGraphOwnerIntent.js';
import {newHeaderId,isHeaderId} from './EffortHeaderStore.js';
import {validateNodeRef,type EffortRef,type NodeRef} from './conversationGraph.js';
import {sealGraphBundle,openGraphBundle,rewrapGraphBundle,openRewrappedGraphBundle} from './GraphWitnessCrypto.js';
import {canonicalHash,canonicalJson,exactFields,signGraphRecord,verifyGraphRecord,verifyMembershipEpoch,verifyEncryptedBundle,verifyBundleRewrap,canonicalPublicKey,validateGraphErasureIdentity,type GraphMembershipEpoch,type GraphEncryptedBundle,type GraphBundleRewrap,type GraphErasureIdentity} from './GraphWitnessTypes.js';

const fields=(value:unknown,required:string[],optional:string[]=[]):boolean=>!!value&&typeof value==='object'&&!Array.isArray(value)&&exactFields(value,[...required,...optional.filter(key=>Object.prototype.hasOwnProperty.call(value,key))]);
const ENROLLED_DOMAIN='graph-enrolled-queued-owner-intent-v2';
const DOMAIN='graph-queued-owner-intent-v1',TERMINAL_DOMAIN='graph-queued-owner-outcome-v1';
const MAX_ITEMS=20000,MAX_FILE_BYTES=256*1024,MAX_BODY_BYTES=32*1024,MAX_DISK_BYTES=32*1024*1024;
const hash=(x:unknown):x is string=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const text=(x:unknown,max=300):x is string=>typeof x==='string'&&x.length>0&&x.length<=max&&!/[\x00-\x1f]/.test(x);
const iso=(x:unknown):x is string=>typeof x==='string'&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
const unsigned=<T extends {signature:string}>(value:T)=>{const {signature:_signature,...body}=value;return body;};
export type GraphQueuedRefusal='owner-revoked'|'stale-heads'|'stale-header'|'project-scope'|'erased'|'not-visible'|'invalid-intent'|'profile-changed'|'conflict';
const REFUSALS:readonly string[]=['owner-revoked','stale-heads','stale-header','project-scope','erased','not-visible','invalid-intent','profile-changed','conflict'];
export interface GraphLocalOwnerIntentInput {
 idempotencyKey:string;requestId:string;principalKey:string;grantVersion:string;
 admission:{kind:'owner-device';deviceId:string;identity:{keyHash:string;userId:string|null;role:'owner'}}|{kind:'owner-dashboard';grantId:string};
 surface:'dashboard'|'mobile';change:GraphOwnerChange;headerId?:string;
}
export interface GraphLocalOwnerIntent extends GraphLocalOwnerIntentInput {
 v:1;createdEffort?:{ref:EffortRef;headerId:string};recordedAt:string;recordedMachineId:string;
}
export interface GraphQueuedEnrollmentContext {kind:'enrolled-machine';agentId:string;recorderMachineId:string;signingPublicKey:string;sealingPublicKey:string;keyEpoch:number;enrollmentFingerprint:string}
interface Control {
 v:1|2;agentId:string;idempotencyKey:string;recorderMachineId:string;
 membership?:GraphMembershipEpoch;custodyProfileHash?:string;context?:GraphQueuedEnrollmentContext;recordedAt:string;
 erasureTargets:GraphErasureIdentity[];bundleHash:string;signature:string;
}
export interface GraphQueuedIntentTransfer {control:unknown;bundle:GraphEncryptedBundle;rewrap:GraphBundleRewrap;membership:GraphMembershipEpoch}
export interface GraphQueuedIntentPromotion {eventId:string;packetHash:string}
interface Outcome {
 v:1;controlHash:string;state:'promoted'|'canceled-local'|'refused-local';
 machineId:string;recordedAt:string;membership?:GraphMembershipEpoch;promotion?:GraphQueuedIntentPromotion;refusalCode?:GraphQueuedRefusal;signature:string;
}
export interface GraphQueuedIntentView {
 v:1;operationKey:string;idempotencyKey:string;requestId:string;state:'recorded-local'|'promoted'|'canceled-local'|'refused-local';
 recordedMachineId:string;recordedAt:string;cancelEligible:boolean;details:'available'|'quarantined';change?:GraphOwnerChange;
 createdEffort?:{ref:EffortRef;headerId:string};promotion?:GraphQueuedIntentPromotion;refusalCode?:GraphQueuedRefusal;
 /** Server-only live fence guard. Non-enumerable, not serializable authority. */
 mayServeDetails():boolean;
 visibleTo(mayView:(ref:NodeRef)=>boolean):boolean;
}
export interface GraphQueuedIntentOptions {
 directory:string;stateDir:string;agentId:string;machineId:string;signingPrivateKey:crypto.KeyLike;sealingPrivateKey:crypto.KeyLike;
 ownerPublicKey?:crypto.KeyLike;membership():GraphMembershipEpoch|null;
 enrollment?:{identity:MachineIdentityManager;identities:IdentityStore};
 canServePrivate?():boolean;
 /** Actual persistent local/fleet logical fences, not a user request boolean. */
 isErased(target:GraphErasureIdentity):boolean;
 /** Actual existing Source/Intake binding, used only to suppress/purge copies. */
 promotionTarget?(idempotencyKey:string):GraphErasureIdentity|null;
 now?:()=>Date;
}
/** Owned files are content-addressed by the opaque logical key. Private intent,
 * title, principal and grant snapshot exist only inside the erasable bundle. */
export class ConversationGraphQueuedIntentSpool {
 private queue:Promise<unknown>=Promise.resolve();
 private stopped=false;
 private readonly visibleHere=new Set<string>();
 private readonly privateBlocked=new Set<string>();
 private readonly durableFiles=new Map<string,string>();
 private ancestrySynced=false;
 private readonly stateRoot:string;private readonly directory:string;
 constructor(private readonly options:GraphQueuedIntentOptions){this.stateRoot=realpathSync(options.stateDir);const relative=path.relative(path.resolve(options.stateDir),path.resolve(options.directory));this.directory=path.join(this.stateRoot,relative);assertGraphLocalPath(this.stateRoot,this.directory);}
 private stem(key:string):string{if(!text(key,200))throw new Error('graph-queued-key-invalid');return canonicalHash(key);}
 private file(key:string,suffix:string):string{return path.join(this.directory,`${this.stem(key)}.${suffix}.json`);}
 private now():string{return (this.options.now?.()??new Date()).toISOString();}
 private serial<T>(work:()=>Promise<T>):Promise<T>{if(this.stopped)return Promise.reject(new Error('graph-queued-closed'));const next=this.queue.then(work);this.queue=next.catch(()=>undefined);return next;}
 private async sync():Promise<void>{const handle=await fs.open(this.directory,'r');try{await handle.sync();}finally{await handle.close();}}
 private async read(file:string):Promise<unknown|null>{assertGraphLocalPath(this.stateRoot,file);try{const entry=await fs.lstat(file);if(!entry.isFile()||entry.isSymbolicLink())throw new Error('graph-queued-file-invalid');const handle=await fs.open(file,'r');try{const stat=await handle.stat();if(!stat.isFile()||stat.size>MAX_FILE_BYTES)throw new Error('graph-queued-file-invalid');return JSON.parse(await handle.readFile('utf8'));}finally{await handle.close();}}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}}
 private async publish(file:string,value:unknown,immutable=true):Promise<void>{
  const bytes=canonicalJson(value);if(Buffer.byteLength(bytes)>MAX_FILE_BYTES)throw new Error('graph-queued-file-capacity');
  assertGraphLocalPath(this.stateRoot,file);ensureGraphLocalDirectory(this.stateRoot,this.directory);
  for(const directory of [path.dirname(this.directory),path.dirname(path.dirname(this.directory))]){const parent=await fs.open(directory,'r');try{await parent.sync();}finally{await parent.close();}}
  const temporary=`${file}.${crypto.randomUUID()}.pending`,handle=await fs.open(temporary,'wx',0o600);
  try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
  try{if(immutable){try{await fs.link(temporary,file);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST'||canonicalJson(await this.read(file))!==bytes)throw new Error('graph-queued-publication-conflict');}}else await fs.rename(temporary,file);}
  finally{try{await SafeFsExecutor.safeUnlink(temporary,{operation:'graph-queued-intent:publication-scratch'});}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
  await this.sync();
 }
 /** Replaying a readable prior slot is not proof its earlier fsync completed. */
 private async retainedBarrier(key:string):Promise<void>{
  for(const suffix of ['control','bundle','rewrap','outcome','forward','visibility']){const file=this.file(key,suffix),raw=await this.read(file);if(raw===null)continue;const hash=canonicalHash(raw);if(this.durableFiles.get(file)===hash)continue;
   assertGraphLocalPath(this.stateRoot,file);const before=await fs.lstat(file),fd=await fs.open(file,'r');try{const opened=await fd.stat();if(!opened.isFile()||opened.ino!==before.ino||opened.dev!==before.dev)throw new Error('graph-queued-retained-file-changed');await fd.sync();}finally{await fd.close();}
   await this.sync();if(!this.ancestrySynced){for(let parent=this.directory;;parent=path.dirname(parent)){const dir=await fs.open(parent,'r');try{await dir.sync();}finally{await dir.close();}if(parent===this.stateRoot)break;}this.ancestrySynced=true;}
   if(canonicalHash(await this.read(file))!==hash)throw new Error('graph-queued-retained-readback-changed');this.durableFiles.set(file,hash);
  }
 }
 private targets(key:string,body:GraphLocalOwnerIntent):GraphErasureIdentity[]{
  const targets:GraphErasureIdentity[]=[{sourceKind:'graph-intent',sourceId:`queued:${canonicalHash(key)}`}];
  const change=body.change;
  if(change.kind==='set-effort-title'){if(!isHeaderId(body.headerId))throw new Error('graph-queued-header-missing');targets.push({sourceKind:'header',sourceId:body.headerId});}
  if(body.createdEffort)targets.push({sourceKind:'header',sourceId:body.createdEffort.headerId});
  const refs=change.kind==='set-primary-placement'?[change.subject,change.parent]:change.kind==='set-front-door'?[change.effort,change.conversation]:[];
  for(const ref of refs)if(ref?.kind==='conversation')targets.push({sourceKind:'conversation-metadata',sourceId:canonicalHash(ref)});
  const unique=new Map(targets.map(target=>[canonicalHash(target),target]));return [...unique].sort(([a],[b])=>a.localeCompare(b)).map(([,target])=>target);
 }
 private body(raw:unknown,key:string):GraphLocalOwnerIntent{
  const b=raw as GraphLocalOwnerIntent;
  if(!fields(b,['v','idempotencyKey','requestId','principalKey','grantVersion','admission','surface','change','recordedAt','recordedMachineId'],['headerId','createdEffort'])||b.v!==1||b.idempotencyKey!==key||!text(b.requestId,160)||!text(b.principalKey)||!text(b.grantVersion)||!text(b.recordedMachineId,200)||!['dashboard','mobile'].includes(b.surface)||!iso(b.recordedAt))throw new Error('graph-queued-body-invalid');
  const a=b.admission;if(!a||!(a.kind==='owner-device'&&b.surface==='mobile'&&exactFields(a,['kind','deviceId','identity'])&&text(a.deviceId,200)&&exactFields(a.identity,['keyHash','userId','role'])&&hash(a.identity.keyHash)&&a.identity.role==='owner'&&(a.identity.userId===null||text(a.identity.userId,200))
   ||a.kind==='owner-dashboard'&&b.surface==='dashboard'&&exactFields(a,['kind','grantId'])&&text(a.grantId,200)))throw new Error('graph-queued-admission-invalid');
  const change=parseGraphOwnerChange(b.change);if(!change||canonicalHash(change)!==canonicalHash(b.change))throw new Error('graph-queued-change-invalid');
  if(b.createdEffort){if(change.kind!=='create-effort'||!exactFields(b.createdEffort,['ref','headerId'])||validateNodeRef(b.createdEffort.ref)?.kind!=='effort'||!isHeaderId(b.createdEffort.headerId))throw new Error('graph-queued-created-effort-invalid');}
  if(change.kind==='create-effort'&&!b.createdEffort)throw new Error('graph-queued-created-effort-missing');
  if(change.kind==='set-effort-title'&&!isHeaderId(b.headerId))throw new Error('graph-queued-header-required');
  if(b.headerId!==undefined&&(change.kind!=='set-effort-title'||!isHeaderId(b.headerId)))throw new Error('graph-queued-header-invalid');
  this.targets(key,b);return b;
 }
 private members(control:Control){return control.v===1?control.membership!.members:[{machineId:control.context!.recorderMachineId,signingPublicKey:control.context!.signingPublicKey,sealingPublicKey:control.context!.sealingPublicKey}];}
 private enrollment():GraphQueuedEnrollmentContext{
  const e=this.options.enrollment;if(!e||!(e.identity instanceof MachineIdentityManager)||!(e.identities instanceof IdentityStore)||path.resolve(e.identities.epochPath)!==path.resolve(e.identity.baseDir,'state','identity-epochs.json'))throw new Error('graph-queued-enrollment-unavailable');
  const identity=e.identity.loadIdentity(),epoch=e.identities.getEpoch(identity.machineId);if(epoch.revokedAt||identity.machineId!==this.options.machineId)throw new Error('graph-queued-enrollment-revoked');
  const body={kind:'enrolled-machine' as const,agentId:this.options.agentId,recorderMachineId:identity.machineId,signingPublicKey:base64ToSigningPem(identity.signingPublicKey),sealingPublicKey:base64ToEncryptionPem(identity.encryptionPublicKey),keyEpoch:identity.keyEpoch??epoch.keyEpoch};
  return {...body,enrollmentFingerprint:canonicalHash(body)};
 }
 private control(raw:unknown,key:string):Control{
  const c=raw as Control,common=['v','agentId','idempotencyKey','recorderMachineId','recordedAt','erasureTargets','bundleHash','signature'];
  if(!c||!exactFields(c,[...common,...(c.v===1?['membership','custodyProfileHash']:['context'])])||![1,2].includes(c.v)||c.agentId!==this.options.agentId||c.idempotencyKey!==key||!iso(c.recordedAt)||!hash(c.bundleHash)||!Array.isArray(c.erasureTargets)||c.erasureTargets.length<1||c.erasureTargets.length>8||!c.erasureTargets.every(validateGraphErasureIdentity))throw new Error('graph-queued-control-invalid');
  if(c.v===1){if(!c.membership||!this.options.ownerPublicKey||!hash(c.custodyProfileHash)||!verifyMembershipEpoch(c.membership,this.options.ownerPublicKey)||c.membership.agentId!==c.agentId||c.custodyProfileHash!==canonicalHash(c.membership.custodyProfile??null))throw new Error('graph-queued-profile-invalid');}
  else {const x=c.context,e=this.options.enrollment;
   if(!x||!e||!(e.identity instanceof MachineIdentityManager)||!(e.identities instanceof IdentityStore)||path.resolve(e.identities.epochPath)!==path.resolve(e.identity.baseDir,'state','identity-epochs.json')||!exactFields(x,['kind','agentId','recorderMachineId','signingPublicKey','sealingPublicKey','keyEpoch','enrollmentFingerprint'])||x.kind!=='enrolled-machine'||x.agentId!==c.agentId||x.recorderMachineId!==c.recorderMachineId||!Number.isSafeInteger(x.keyEpoch)||x.keyEpoch<0||!canonicalPublicKey(x.signingPublicKey,'ed25519')||!canonicalPublicKey(x.sealingPublicKey,'x25519'))throw new Error('graph-queued-enrollment-invalid');
   const {enrollmentFingerprint,...snapshot}=x;if(enrollmentFingerprint!==canonicalHash(snapshot))throw new Error('graph-queued-enrollment-fingerprint-invalid');
   const local=e.identity.loadIdentity(),identity=x.recorderMachineId===local.machineId?local:e.identities.loadIdentity(x.recorderMachineId,'remote');
   const current=identity&&base64ToSigningPem(identity.signingPublicKey)===x.signingPublicKey;
   if(!current&&!e.identities.signingKeyHistory(x.recorderMachineId).some(row=>base64ToSigningPem(row.publicKey)===x.signingPublicKey))throw new Error('graph-queued-recorder-untrusted');
  }
  const member=this.members(c).find(member=>member.machineId===c.recorderMachineId);
  if(!member||!verifyGraphRecord(c.v===1?DOMAIN:ENROLLED_DOMAIN,unsigned(c),c.signature,member.signingPublicKey))throw new Error('graph-queued-signature-invalid');return c;
 }
 private denied(control:Control):boolean{const promoted=this.options.promotionTarget?.(control.idempotencyKey);return control.erasureTargets.some(target=>this.options.isErased(target))||!!promoted&&this.options.isErased(promoted);}
 private async load(key:string):Promise<{control:Control;body:GraphLocalOwnerIntent;outcome:Outcome|null}|null>{
  const raw=await this.read(this.file(key,'control'));if(raw===null)return null;const control=this.control(raw,key);
  if(this.denied(control))throw new Error('graph-queued-intent-erased');
  const bundle=await this.read(this.file(key,'bundle')) as GraphEncryptedBundle|null;
  if(!bundle||canonicalHash(bundle)!==control.bundleHash||!verifyEncryptedBundle(bundle,{members:this.members(control)}))throw new Error('graph-queued-bundle-unavailable');
  const sidecar=await this.read(this.file(key,'rewrap')) as {membership:GraphMembershipEpoch;rewrap:GraphBundleRewrap}|null;
  if(sidecar&&(!exactFields(sidecar,['membership','rewrap'])||!this.options.ownerPublicKey||!verifyMembershipEpoch(sidecar.membership,this.options.ownerPublicKey)||sidecar.membership.agentId!==control.agentId||sidecar.rewrap.writerId!==control.recorderMachineId||!verifyBundleRewrap(sidecar.rewrap,bundle,sidecar.membership)))throw new Error('graph-queued-forward-rewrap-invalid');
  const bytes=sidecar?openRewrappedGraphBundle(bundle,sidecar.rewrap,this.options.machineId,this.options.sealingPrivateKey,sidecar.membership,{agentId:control.agentId,eventId:`queued:${key}`}):openGraphBundle(bundle,this.options.machineId,this.options.sealingPrivateKey,{agentId:control.agentId,eventId:`queued:${key}`});let body:GraphLocalOwnerIntent;
  try{if(bytes.length>MAX_BODY_BYTES)throw new Error('graph-queued-body-capacity');body=this.body(JSON.parse(bytes.toString()),key);}finally{bytes.fill(0);}
  if(body.recordedAt!==control.recordedAt||body.recordedMachineId!==control.recorderMachineId||canonicalHash(this.targets(key,body))!==canonicalHash(control.erasureTargets)||this.denied(control))throw new Error('graph-queued-intent-erased');
  if(await this.read(this.file(key,'visibility'))!==null)this.privateBlocked.add(key);
  const attempt=await this.read(this.file(key,'forward')) as {v:1;controlHash:string;machineId:string;recordedAt:string;signature:string}|null;if(attempt){const recorder=this.members(control).find(member=>member.machineId===control.recorderMachineId);if(!exactFields(attempt,['v','controlHash','machineId','recordedAt','signature'])||attempt.v!==1||attempt.controlHash!==canonicalHash(control)||attempt.machineId!==control.recorderMachineId||!iso(attempt.recordedAt)||!recorder||!verifyGraphRecord('graph-queued-forward-attempt-v1',unsigned(attempt),attempt.signature,recorder.signingPublicKey))throw new Error('graph-queued-forward-attempt-invalid');this.forwardedKeys.add(key);}
  const outcome=await this.read(this.file(key,'outcome')) as Outcome|null;
  if(outcome){if(outcome.membership&&(!this.options.ownerPublicKey||!verifyMembershipEpoch(outcome.membership,this.options.ownerPublicKey)||outcome.membership.agentId!==control.agentId))throw new Error('graph-queued-outcome-membership-invalid');const member=(outcome.membership?.members??this.members(control)).find(member=>member.machineId===outcome.machineId);
   if(!fields(outcome,['v','controlHash','state','machineId','recordedAt','signature'],['promotion','refusalCode','membership'])||outcome.v!==1||outcome.controlHash!==canonicalHash(control)||!member||!iso(outcome.recordedAt)||!verifyGraphRecord(TERMINAL_DOMAIN,unsigned(outcome),outcome.signature,member.signingPublicKey)||!['promoted','canceled-local','refused-local'].includes(outcome.state))throw new Error('graph-queued-outcome-invalid');
   if(outcome.state==='promoted'?(!outcome.promotion||!exactFields(outcome.promotion,['eventId','packetHash'])||!text(outcome.promotion.eventId,300)||!hash(outcome.promotion.packetHash)||outcome.refusalCode!==undefined):outcome.promotion!==undefined)throw new Error('graph-queued-promotion-invalid');
   if(outcome.state==='refused-local'?!REFUSALS.includes(outcome.refusalCode??''):outcome.refusalCode!==undefined)throw new Error('graph-queued-refusal-invalid');
  }return {control,body,outcome};
 }
 private readonly forwardedKeys=new Set<string>();
 private view(item:{control:Control;body:GraphLocalOwnerIntent;outcome:Outcome|null}):GraphQueuedIntentView{
  const key=item.control.idempotencyKey,mayServeDetails=()=>!this.denied(item.control)&&!this.privateBlocked.has(key)&&(this.visibleHere.has(key)||this.options.canServePrivate?.()===true),available=mayServeDetails();
  const change=item.body.change;const refs:NodeRef[]=change.kind==='set-primary-placement'?[change.subject,...(change.parent?[change.parent]:[])]:change.kind==='set-front-door'?[change.effort,...(change.conversation?[change.conversation]:[])]:change.kind==='set-effort-title'?[change.effort]:item.body.createdEffort?[item.body.createdEffort.ref]:[];
  const visibleTo=(mayView:(ref:NodeRef)=>boolean)=>refs.every(ref=>mayView(structuredClone(ref)));
  const view:GraphQueuedIntentView={v:1,operationKey:`queued:${key}`,idempotencyKey:key,requestId:item.body.requestId,state:item.outcome?.state??'recorded-local',recordedMachineId:item.control.recorderMachineId,recordedAt:item.control.recordedAt,cancelEligible:!item.outcome&&!this.forwardedKeys.has(key)&&item.control.recorderMachineId===this.options.machineId,details:available?'available':'quarantined',...(available?{change:structuredClone(item.body.change)}:{}),...(item.body.createdEffort?{createdEffort:structuredClone(item.body.createdEffort)}:{}),...(item.outcome?.promotion?{promotion:{...item.outcome.promotion}}:{}),...(item.outcome?.refusalCode?{refusalCode:item.outcome.refusalCode}:{}),mayServeDetails,visibleTo};
  Object.defineProperty(view,'mayServeDetails',{value:mayServeDetails,enumerable:false,writable:false,configurable:false});Object.defineProperty(view,'visibleTo',{value:visibleTo,enumerable:false,writable:false,configurable:false});return view;
 }
 private logical(input:GraphLocalOwnerIntentInput){return {idempotencyKey:input.idempotencyKey,requestId:input.requestId,principalKey:input.principalKey,change:input.change,...(input.headerId===undefined?{}:{headerId:input.headerId})};}
 private async quarantineInside(key:string):Promise<void>{this.privateBlocked.add(key);this.visibleHere.delete(key);const control=await this.read(this.file(key,'control'));if(control)await this.publish(this.file(key,'visibility'),{v:1,controlHash:canonicalHash(control),details:'quarantined'},false);}
 async quarantine(key:string):Promise<void>{this.privateBlocked.add(key);this.visibleHere.delete(key);return this.serial(()=>this.quarantineInside(key));}
 private async exposeFresh(key:string):Promise<void>{
  const file=this.file(key,'visibility');if(await this.read(file)!==null){await SafeFsExecutor.safeUnlink(file,{operation:'graph-queued-intent:fresh-owner-body-visibility'});await this.sync();}
  this.privateBlocked.delete(key);this.visibleHere.add(key);
 }
 private async authorizedView(key:string,item:{control:Control;body:GraphLocalOwnerIntent;outcome:Outcome|null},authorize:()=>boolean):Promise<GraphQueuedIntentView>{if(!authorize()){await this.quarantineInside(key);throw new Error('graph-queued-current-owner-required');}await this.exposeFresh(key);if(!authorize()){await this.quarantineInside(key);throw new Error('graph-queued-current-owner-required');}return this.view(item);}
 async record(input:GraphLocalOwnerIntentInput,authorize:()=>boolean):Promise<GraphQueuedIntentView>{return this.serial(async()=>{
  if(!authorize())throw new Error('graph-queued-current-owner-required');
  const key=input.idempotencyKey,prior=await this.load(key);
  if(!prior&&key.length>193)throw new Error('graph-queued-forward-binding-capacity');
  if(prior){if(canonicalHash(this.logical(prior.body))!==canonicalHash(this.logical(input)))throw new Error('graph-queued-idempotency-conflict');await this.retainedBarrier(key);const durable=await this.load(key);if(!durable)throw new Error('graph-queued-durability-missing');return this.authorizedView(key,durable,authorize);}
  const membership=this.options.membership();if(membership&&(!this.options.ownerPublicKey||!verifyMembershipEpoch(membership,this.options.ownerPublicKey)||membership.agentId!==this.options.agentId||!membership.members.some(member=>member.machineId===this.options.machineId)))throw new Error('graph-queued-membership-invalid');const context=membership?null:this.enrollment();
  const names=await this.names();if(names.filter(name=>name.endsWith('.control.json')).length>=MAX_ITEMS)throw new Error('graph-queued-item-capacity');
  let diskBytes=0;for(const name of names){const stat=await fs.lstat(path.join(this.directory,name));if(!stat.isFile()||stat.isSymbolicLink())throw new Error('graph-queued-unclassified-copy');diskBytes+=stat.size;}
  const body=this.body({...input,v:1,recordedAt:this.now(),recordedMachineId:this.options.machineId,...(input.change.kind==='create-effort'?{createdEffort:{ref:{kind:'effort',id:crypto.randomUUID()},headerId:newHeaderId()}}:{})},key);
  const targets=this.targets(key,body);if(targets.some(target=>this.options.isErased(target)))throw new Error('graph-queued-intent-erased');
  const bytes=Buffer.from(canonicalJson(body));if(bytes.length>MAX_BODY_BYTES)throw new Error('graph-queued-body-capacity');let bundle:GraphEncryptedBundle;
  try{bundle=sealGraphBundle(bytes,membership?.members??[{machineId:context!.recorderMachineId,signingPublicKey:context!.signingPublicKey,sealingPublicKey:context!.sealingPublicKey}],{agentId:this.options.agentId,eventId:`queued:${key}`});}finally{bytes.fill(0);}
  const profile=membership?.custodyProfile??null;
  const unsignedControl={v:membership?1 as const:2 as const,agentId:this.options.agentId,idempotencyKey:key,recorderMachineId:this.options.machineId,...(membership?{membership,custodyProfileHash:canonicalHash(profile)}:{context:context!}),recordedAt:body.recordedAt,erasureTargets:targets,bundleHash:canonicalHash(bundle)};
  const control:Control={...unsignedControl,signature:signGraphRecord(membership?DOMAIN:ENROLLED_DOMAIN,unsignedControl,this.options.signingPrivateKey)};
  // Reserve bounded terminal metadata as well. Existing terminal transitions,
  // exact retries and priority erase never consume a new admission slot.
  if(diskBytes+Buffer.byteLength(canonicalJson(control))+Buffer.byteLength(canonicalJson(bundle))+2048>MAX_DISK_BYTES)throw new Error('graph-queued-disk-capacity');
  // Attribute every possible body/scratch copy BEFORE publishing private bytes.
  await this.publish(this.file(key,'control'),control);
  if(this.denied(control))throw new Error('graph-queued-intent-erased');
  await this.publish(this.file(key,'bundle'),bundle);
  if(this.denied(control)){await this.purgeControl(control);throw new Error('graph-queued-intent-erased');}
  const durable=await this.load(key);if(!durable)throw new Error('graph-queued-durability-missing');return this.authorizedView(key,durable,authorize);
 });}
 async readIntent(key:string,principalKey:string):Promise<GraphLocalOwnerIntent|null>{const item=await this.load(key);if(!item||item.body.principalKey!==principalKey)return null;return structuredClone(item.body);}
 /** Internal authority lookup: the only peer response is a fresh permission
  * result, never this sealed private body or its title/change hash. */
 async readRecordedIntent(key:string):Promise<GraphLocalOwnerIntent|null>{const item=await this.load(key);return item?structuredClone(item.body):null;}
 /** A historical key can verify opaque continuity, but cannot regain current
  * admission merely by backdating a capture after its enrollment was retired. */
 async recorderIsCurrent(key:string):Promise<boolean>{
  const raw=await this.read(this.file(key,'control'));if(!raw)return false;const control=this.control(raw,key),membership=this.options.membership();
  if(!membership||!this.options.ownerPublicKey||!verifyMembershipEpoch(membership,this.options.ownerPublicKey))return false;
  const previous=this.members(control).find(member=>member.machineId===control.recorderMachineId),current=membership.members.find(member=>member.machineId===control.recorderMachineId);
  return !!previous&&!!current&&previous.signingPublicKey===current.signingPublicKey&&previous.sealingPublicKey===current.sealingPublicKey;
 }
 async status(key:string,principalKey:string):Promise<GraphQueuedIntentView|null>{const item=await this.load(key);if(!item||item.body.principalKey!==principalKey)return null;await this.retainedBarrier(key);return this.view(item);}
 private async names():Promise<string[]>{assertGraphLocalPath(this.stateRoot,this.directory);try{return await fs.readdir(this.directory);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}}
 async list(principalKey:string):Promise<GraphQueuedIntentView[]>{const result:GraphQueuedIntentView[]=[];for(const name of (await this.names()).filter(name=>name.endsWith('.control.json')).sort()){
  const raw=await this.read(path.join(this.directory,name)) as Control;const key=raw?.idempotencyKey;if(!text(key,200)||name!==`${this.stem(key)}.control.json`)throw new Error('graph-queued-inventory-invalid');
  const control=this.control(raw,key);if(this.denied(control))continue;const item=await this.load(key);if(item?.body.principalKey===principalKey){await this.retainedBarrier(key);result.push(this.view(item));}
 }return result;}
 /** Internal promotion scan, never a wire response. Bounded disk work per tick
  * keeps old terminal history from creating an unbounded background task. */
 async pendingPage(cursor:string|null=null):Promise<{intents:GraphLocalOwnerIntent[];nextCursor:string|null}>{
  if(cursor!==null&&!/^[a-f0-9]{64}\.control\.json$/.test(cursor))throw new Error('graph-queued-cursor-invalid');
  const names=(await this.names()).filter(name=>name.endsWith('.control.json')&&(cursor===null||name>cursor)).sort(),intents:GraphLocalOwnerIntent[]=[];let scanned=0,last:string|null=null;
  for(const name of names){last=name;scanned++;const raw=await this.read(path.join(this.directory,name)) as Control,control=this.control(raw,raw.idempotencyKey);if(!this.denied(control)){
   const outcome=await this.read(this.file(control.idempotencyKey,'outcome'));
   // load validates every terminal too: malformed metadata cannot suppress an
   // unresolved intent by pretending that promotion already finished.
   const item=await this.load(control.idempotencyKey);if(item&&!outcome)intents.push(structuredClone(item.body));
  }if(scanned>=128||intents.length>=32)break;}
  return {intents,nextCursor:scanned<names.length?last:null};
 }
 async finish(key:string,principalKey:string,result:{state:'canceled-local'}|{state:'refused-local';refusalCode:GraphQueuedRefusal}|{state:'promoted';promotion:GraphQueuedIntentPromotion},authorize?:()=>boolean):Promise<GraphQueuedIntentView>{return this.serial(async()=>{
  const item=await this.load(key);if(!item||item.body.principalKey!==principalKey)throw new Error('graph-queued-owner-unavailable');
  await this.retainedBarrier(key);
  if(authorize&&!authorize())throw new Error('graph-queued-current-owner-required');
  if(item.outcome){if(item.outcome.state!==result.state||canonicalHash(item.outcome.promotion??null)!==canonicalHash('promotion'in result?result.promotion:null)||item.outcome.refusalCode!==('refusalCode'in result?result.refusalCode:undefined))throw new Error('graph-queued-terminal-conflict');return this.view(item);}
  if(result.state==='canceled-local'&&(this.forwardedKeys.has(key)||item.control.recorderMachineId!==this.options.machineId))throw new Error('graph-queued-remote-admission-unknown');
  const current=this.options.membership();const outcomeMembership=!this.members(item.control).some(member=>member.machineId===this.options.machineId)?current:null;if(!this.members(item.control).some(member=>member.machineId===this.options.machineId)&&!outcomeMembership)throw new Error('graph-queued-outcome-membership-unavailable');
  // Local cancellation linearizes at the final synchronous current-owner check
  // and signature. Later revocation suppresses the reply, not this accepted act.
  if(authorize&&!authorize())throw new Error('graph-queued-current-owner-required');
  const unsignedOutcome={v:1 as const,controlHash:canonicalHash(item.control),...result,machineId:this.options.machineId,recordedAt:this.now(),...(outcomeMembership?{membership:outcomeMembership}:{})};
  const outcome:Outcome={...unsignedOutcome,signature:signGraphRecord(TERMINAL_DOMAIN,unsignedOutcome,this.options.signingPrivateKey)};
  await this.publish(this.file(key,'outcome'),outcome);const durable=await this.load(key);if(!durable)throw new Error('graph-queued-outcome-missing');return this.view(durable);
 });}
 /** Transfer only a live in-process capability, never a persisted fresh bit.
  * Both objects independently verify the exact original control and bundle. */
 async inheritLiveVisibility(original:ConversationGraphQueuedIntentSpool):Promise<void>{return this.serial(async()=>{
  if(!(original instanceof ConversationGraphQueuedIntentSpool)||original===this||original.directory!==this.directory||original.options.agentId!==this.options.agentId||original.options.machineId!==this.options.machineId)throw new Error('graph-queued-live-custody-mismatch');
  for(const key of original.visibleHere){const old=await original.load(key),current=await this.load(key);if(!old||!current||!original.visibleHere.has(key)||original.privateBlocked.has(key)||original.denied(old.control)||this.denied(current.control)||canonicalHash(old.control)!==canonicalHash(current.control))continue;
   if(old.control.bundleHash!==current.control.bundleHash||old.body.recordedMachineId!==this.options.machineId)throw new Error('graph-queued-live-custody-mismatch');this.visibleHere.add(key);
  }
 });}
 async exportForForward(key:string,principalKey:string):Promise<GraphQueuedIntentTransfer>{return this.serial(async()=>{
  const item=await this.load(key),membership=this.options.membership();if(!item||!this.view(item).mayServeDetails()||item.body.principalKey!==principalKey||item.control.recorderMachineId!==this.options.machineId||item.outcome||!membership||!this.options.ownerPublicKey||!verifyMembershipEpoch(membership,this.options.ownerPublicKey))throw new Error('graph-queued-forward-unavailable');
  const original=this.members(item.control).find(member=>member.machineId===this.options.machineId),current=membership.members.find(member=>member.machineId===this.options.machineId);if(!original||!current||original.signingPublicKey!==current.signingPublicKey||original.sealingPublicKey!==current.sealingPublicKey)throw new Error('graph-queued-recorder-retired');
  const bundle=await this.read(this.file(key,'bundle')) as GraphEncryptedBundle,rewrap=rewrapGraphBundle(bundle,this.options.machineId,this.options.sealingPrivateKey,membership,this.options.machineId,this.options.signingPrivateKey,{agentId:this.options.agentId,eventId:`queued:${key}`});
  const previous=await this.read(this.file(key,'forward'));if(!previous){const value={v:1 as const,controlHash:canonicalHash(item.control),machineId:this.options.machineId,recordedAt:this.now()};await this.publish(this.file(key,'forward'),{...value,signature:signGraphRecord('graph-queued-forward-attempt-v1',value,this.options.signingPrivateKey)});}this.forwardedKeys.add(key);
  if(this.denied(item.control))throw new Error('graph-queued-intent-erased');return {control:structuredClone(item.control),bundle,rewrap,membership:structuredClone(membership)};
 });}
 async importForwarded(raw:GraphQueuedIntentTransfer,sender:string):Promise<GraphLocalOwnerIntent>{return this.serial(async()=>{
  if(!exactFields(raw,['control','bundle','rewrap','membership']))throw new Error('graph-queued-forward-invalid');const candidate=raw.control as Control,key=candidate?.idempotencyKey,control=this.control(candidate,key),membership=this.options.membership();
  if(!membership||!this.options.ownerPublicKey||canonicalHash(raw.membership)!==canonicalHash(membership)||!verifyMembershipEpoch(membership,this.options.ownerPublicKey)||sender!==control.recorderMachineId||this.denied(control)||canonicalHash(raw.bundle)!==control.bundleHash||!verifyEncryptedBundle(raw.bundle,{members:this.members(control)})||raw.rewrap.writerId!==sender||!verifyBundleRewrap(raw.rewrap,raw.bundle,membership))throw new Error('graph-queued-forward-authority-invalid');
  const original=this.members(control).find(member=>member.machineId===sender),current=membership.members.find(member=>member.machineId===sender);if(!original||!current||original.signingPublicKey!==current.signingPublicKey||original.sealingPublicKey!==current.sealingPublicKey)throw new Error('graph-queued-recorder-retired');
  const bytes=openRewrappedGraphBundle(raw.bundle,raw.rewrap,this.options.machineId,this.options.sealingPrivateKey,membership,{agentId:this.options.agentId,eventId:`queued:${key}`});try{const body=this.body(JSON.parse(bytes.toString()),key);if(body.recordedMachineId!==sender||body.recordedAt!==control.recordedAt||canonicalHash(this.targets(key,body))!==canonicalHash(control.erasureTargets))throw new Error('graph-queued-forward-body-mismatch');}finally{bytes.fill(0);}
  const prior=await this.read(this.file(key,'control'));if(prior&&canonicalHash(prior)!==canonicalHash(control))throw new Error('graph-queued-idempotency-conflict');
  if(!prior){const names=await this.names();if(names.filter(name=>name.endsWith('.control.json')).length>=MAX_ITEMS)throw new Error('graph-queued-item-capacity');let size=0;for(const name of names)size+=(await fs.lstat(path.join(this.directory,name))).size;if(size+Buffer.byteLength(canonicalJson(raw))+2048>MAX_DISK_BYTES)throw new Error('graph-queued-disk-capacity');}
  await this.publish(this.file(key,'control'),control);if(this.denied(control))throw new Error('graph-queued-intent-erased');await this.publish(this.file(key,'bundle'),raw.bundle);await this.publish(this.file(key,'rewrap'),{membership,rewrap:raw.rewrap},false);if(this.denied(control)){await this.purgeControl(control);throw new Error('graph-queued-intent-erased');}
  const loaded=await this.load(key);if(!loaded)throw new Error('graph-queued-forward-durability-missing');return structuredClone(loaded.body);
 });}
 private async purgeControl(control:Control):Promise<void>{for(const name of await this.names()){
  const file=path.join(this.directory,name);let remove=name.startsWith(`${this.stem(control.idempotencyKey)}.bundle.json`)||name.startsWith(`${this.stem(control.idempotencyKey)}.rewrap.json`);
  if(!remove){const raw=await this.read(file);remove=raw!==null&&(canonicalHash(raw)===control.bundleHash||(raw as {rewrap?:GraphBundleRewrap}).rewrap?.originalBundleHash===control.bundleHash||(raw as GraphBundleRewrap).originalBundleHash===control.bundleHash);}
  if(remove)await SafeFsExecutor.safeUnlink(file,{operation:'graph-queued-intent:erase-private-copy'});
 }await this.sync();}
 /** Caller first persists the actual local/fleet deny; no network or ordinary
  * mutation queue may delay this physical purge. */
 async purge(target:GraphErasureIdentity):Promise<void>{if(!validateGraphErasureIdentity(target)||!this.options.isErased(target))throw new Error('graph-queued-erasure-authority-missing');
  for(const name of (await this.names()).filter(name=>name.endsWith('.control.json'))){const raw=await this.read(path.join(this.directory,name)) as Control;const control=this.control(raw,raw.idempotencyKey);if(this.denied(control))await this.purgeControl(control);}
 }
 async assertPurged(target:GraphErasureIdentity):Promise<string>{
  if(!validateGraphErasureIdentity(target)||!this.options.isErased(target))throw new Error('graph-queued-erasure-authority-missing');
  const names=await this.names(),deniedHashes=new Set<string>(),retained:string[]=[];
  for(const name of names.filter(name=>name.endsWith('.control.json'))){const raw=await this.read(path.join(this.directory,name)) as Control;const control=this.control(raw,raw.idempotencyKey);if(this.denied(control))deniedHashes.add(control.bundleHash);}
  for(const name of names){const raw=await this.read(path.join(this.directory,name));if(raw===null)continue;{const row=raw as {rewrap?:GraphBundleRewrap;originalBundleHash?:string};if(row.rewrap&&deniedHashes.has(row.rewrap.originalBundleHash)||row.originalBundleHash&&deniedHashes.has(row.originalBundleHash))throw new Error('graph-queued-erasure-envelope-remains');}
   if(deniedHashes.has(canonicalHash(raw)))throw new Error('graph-queued-erasure-body-remains');retained.push(canonicalHash(raw));}
  return canonicalHash({v:1,scope:'graph-queued-owner-intents',target,retained:retained.sort(),matchingBodyCopies:[]});
 }
 async close():Promise<void>{this.stopped=true;await this.queue;}
}

/** The pre-profile path has real enrolled identity and self-only sealing; it
 * cannot mint a membership, allocate a source sequence or infer a blank genesis. */
export function createEnrolledGraphOwnerIntentSpool(options:{stateDir:string;agentId:string;identity:MachineIdentityManager;identities:IdentityStore;localErasure:ConversationGraphLocalErasureFence}):ConversationGraphQueuedIntentSpool{
 if(!(options.identity instanceof MachineIdentityManager)||!(options.identities instanceof IdentityStore)||!(options.localErasure instanceof ConversationGraphLocalErasureFence)||path.resolve(options.stateDir)!==path.resolve(options.identity.baseDir)||path.resolve(options.identities.epochPath)!==path.resolve(options.stateDir,'state','identity-epochs.json'))throw new Error('graph-queued-enrollment-components-required');
 const local=options.identity.loadIdentity();
 return new ConversationGraphQueuedIntentSpool({directory:path.join(options.stateDir,'state','conversation-graph-intake','queued-owner-intents'),stateDir:options.stateDir,agentId:options.agentId,machineId:local.machineId,signingPrivateKey:options.identity.loadSigningKey(),sealingPrivateKey:options.identity.loadEncryptionKey(),membership:()=>null,enrollment:{identity:options.identity,identities:options.identities},isErased:target=>options.localErasure.isDenied(target),canServePrivate:()=>false});
}
