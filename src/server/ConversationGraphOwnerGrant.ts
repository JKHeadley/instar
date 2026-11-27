/** Scoped durable admission for one dashboard intent, not a reusable PIN/session.
 * Only the actual PIN-unlocked owner route may issue it. Promotion validates this
 * record after verifying the original recorder's signed, sealed queue envelope.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {SafeFsExecutor} from '../core/SafeFsExecutor.js';
import type {SecretStore} from '../core/SecretStore.js';
import {canonicalHash,canonicalJson,exactFields,iso,opaque} from '../core/GraphWitnessTypes.js';
import {assertGraphLocalPath,ensureGraphLocalDirectory} from '../core/GraphLocalFiles.js';
import type {ConversationGraphOwnerPolicySnapshot} from '../core/ConversationGraphOwnerPolicy.js';

interface StoredGrant {
 v:1;agentId:string;idempotencyKey:string;principalKey:string;grantId:string;policyMarker:string;policyEpoch:number;recordedAt:string;mac:string;
}
// Shared by per-request/store instances. A failed observed policy transition
// must not disappear merely because a later request constructs a new adapter.
const uncertainPolicies=new Set<string>();
export class ConversationGraphOwnerGrantStore {
 private readonly directory:string;
 private readonly stateRoot:string;
 private readonly secretName='conversation_graph_owner_intent_policy_key';
 private durablePolicyKeyHash:string|null=null;
 constructor(private readonly options:{stateDir:string;agentId:string;secrets:SecretStore;
  /** Current actual operator policy, never a body value. Not persisted. */
  dashboardPolicy():ConversationGraphOwnerPolicySnapshot|null}){
  this.stateRoot=fs.realpathSync(options.stateDir);
  this.directory=path.join(this.stateRoot,'conversation-graph','owner-intent-grants');
 }
 /** Canonical backing scope, for actual component binding by native administration. */
 get backingStateRoot():string{return this.stateRoot;}
 private file(key:string){if(!opaque(key))throw new Error('graph-owner-intent-key-invalid');return path.join(this.directory,canonicalHash(key)+'.json');}
 private read(key:string):StoredGrant|null{
  try{
   const file=this.file(key);assertGraphLocalPath(this.stateRoot,file);
   const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096)throw new Error('graph-owner-intent-grant-invalid');
   const value=JSON.parse(fs.readFileSync(file,'utf8')) as StoredGrant;
   if(!exactFields(value,['v','agentId','idempotencyKey','principalKey','grantId','policyMarker','policyEpoch','recordedAt','mac'])||value.v!==1
    ||value.agentId!==this.options.agentId||value.idempotencyKey!==key||value.principalKey!==`owner:${this.options.agentId}`
    ||!Number.isSafeInteger(value.policyEpoch)||value.policyEpoch<1||!opaque(value.grantId)||!/^[a-f0-9]{64}$/.test(value.policyMarker)||!iso(value.recordedAt)||!/^[a-f0-9]{64}$/.test(value.mac))throw new Error('graph-owner-intent-grant-invalid');
   const {mac,...body}=value;if(!crypto.timingSafeEqual(Buffer.from(mac,'hex'),Buffer.from(this.grantMac(body),'hex')))throw new Error('graph-owner-intent-grant-invalid');
   return value;
  }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
 }
 private grantMac(body:Omit<StoredGrant,'mac'>):string{
  const key=this.options.secrets.get(this.secretName);if(typeof key!=='string'||!/^[a-f0-9]{64}$/.test(key))throw new Error('graph-owner-intent-policy-key-missing');
  return crypto.createHmac('sha256',Buffer.from(key,'hex')).update('graph-owner-intent-grant-v1\0').update(canonicalJson(body)).digest('hex');
 }
 private marker(create:boolean):{marker:string;epoch:number;active:boolean}{
  try{return this.advancePolicy(create,uncertainPolicies.has(this.stateRoot));}
  catch(error){uncertainPolicies.add(this.stateRoot);throw error;}
 }
 private advancePolicy(create:boolean,forceAdvance:boolean):{marker:string;epoch:number;active:boolean}{
  const policy=this.options.dashboardPolicy();let key=this.options.secrets.get(this.secretName);
  if(key===undefined){
   if(!create||fs.existsSync(this.directory)&&fs.readdirSync(this.directory).length)throw new Error('graph-owner-intent-policy-key-missing');
   key=crypto.randomBytes(32).toString('hex');this.options.secrets.set(this.secretName,key);this.options.secrets.syncDurably();
  }
  if(typeof key!=='string'||!/^[a-f0-9]{64}$/.test(key))throw new Error('graph-owner-intent-policy-key-invalid');
  if(this.durablePolicyKeyHash!==canonicalHash(key)){
   this.options.secrets.syncDurably();this.durablePolicyKeyHash=canonicalHash(key);
  }
  const authenticate=(body:unknown)=>crypto.createHmac('sha256',Buffer.from(key as string,'hex')).update('graph-owner-intent-policy-state-v1\0').update(canonicalJson(body)).digest('hex');
  if(policy&&(!exactFields(policy,['pin','generation'])||typeof policy.pin!=='string'||!policy.pin
   ||typeof policy.generation!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(policy.generation)))throw new Error('graph-owner-intent-policy-generation-invalid');
  const marker=crypto.createHmac('sha256',Buffer.from(key,'hex')).update('graph-owner-intent-policy-v1\0').update(policy?canonicalJson(policy):'unavailable').digest('hex');
  const file=path.join(this.stateRoot,'conversation-graph','owner-intent-policy.json');assertGraphLocalPath(this.stateRoot,file);
  let prior:{v:1;marker:string;epoch:number;mac:string}|null=null;
  try{
   const stat=fs.lstatSync(file);if(!stat.isFile()||stat.size>4096)throw new Error('graph-owner-intent-policy-invalid');
   prior=JSON.parse(fs.readFileSync(file,'utf8'));
   if(!prior||!exactFields(prior,['v','marker','epoch','mac'])||prior.v!==1||!Number.isSafeInteger(prior.epoch)||prior.epoch<1
    ||!/^[a-f0-9]{64}$/.test(prior.marker)||!/^[a-f0-9]{64}$/.test(prior.mac))throw new Error('graph-owner-intent-policy-invalid');
   const {mac,...body}=prior;if(!crypto.timingSafeEqual(Buffer.from(mac,'hex'),Buffer.from(authenticate(body),'hex')))throw new Error('graph-owner-intent-policy-invalid');
  }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  if(!prior&&!create)throw new Error('graph-owner-intent-policy-missing');
  let epoch=prior?.epoch??0;
  if(!prior||prior.marker!==marker||forceAdvance){
   if(!Number.isSafeInteger(epoch+1))throw new Error('graph-owner-intent-policy-capacity');epoch++;
   ensureGraphLocalDirectory(this.stateRoot,path.dirname(file));const body={v:1,marker,epoch},value={...body,mac:authenticate(body)};
   const scratch=file+'.'+crypto.randomUUID()+'.pending',fd=fs.openSync(scratch,'wx',0o600);
   try{fs.writeFileSync(fd,canonicalJson(value));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
   fs.renameSync(scratch,file);const dir=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
   if(canonicalJson(JSON.parse(fs.readFileSync(file,'utf8')))!==canonicalJson(value))throw new Error('graph-owner-intent-policy-not-durable');
  }
  uncertainPolicies.delete(this.stateRoot);
  return{marker,epoch,active:!!policy};
 }
 /** Notify at the actual PIN-change authority as well as during promotion.
  * Reusing an old PIN must not revive an intent from a retired policy epoch. */
 observePolicy():void{
  if(this.options.secrets.get(this.secretName)===undefined&&!fs.existsSync(this.directory))return;
  this.marker(false);
 }
 /** Called only after actual owner authentication and rechecked after capture. */
 capture(idempotencyKey:string,principalKey:string):{kind:'owner-dashboard';grantId:string}{
  if(principalKey!==`owner:${this.options.agentId}`)throw new Error('graph-owner-intent-owner-invalid');
  const prior=this.read(idempotencyKey),policy=this.marker(!prior);if(!policy.active)throw new Error('graph-owner-intent-owner-unavailable');
  if(prior){if(prior.policyMarker!==policy.marker||prior.policyEpoch!==policy.epoch)throw new Error('graph-owner-intent-owner-revoked');return{kind:'owner-dashboard',grantId:prior.grantId};}
  ensureGraphLocalDirectory(this.stateRoot,this.directory);
  const stat=fs.lstatSync(this.directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('graph-owner-intent-directory-invalid');
  if(fs.readdirSync(this.directory).length>=20000)throw new Error('graph-owner-intent-capacity');
  const body={v:1 as const,agentId:this.options.agentId,idempotencyKey,principalKey,grantId:crypto.randomUUID(),policyMarker:policy.marker,policyEpoch:policy.epoch,recordedAt:new Date().toISOString()};
  const value:StoredGrant={...body,mac:this.grantMac(body)};
  const scratch=this.file(idempotencyKey)+'.'+crypto.randomUUID()+'.pending',fd=fs.openSync(scratch,'wx',0o600);
  try{fs.writeFileSync(fd,canonicalJson(value));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  try{fs.linkSync(scratch,this.file(idempotencyKey));}
  finally{SafeFsExecutor.safeUnlinkSync(scratch,{operation:'graph-owner-intent-grant:publication-scratch'});}
  for(let directory=this.directory;;directory=path.dirname(directory)){
   const handle=fs.openSync(directory,'r');try{fs.fsyncSync(handle);}finally{fs.closeSync(handle);}
   if(path.dirname(directory)===directory)break;
  }
  if(this.read(idempotencyKey)?.grantId!==value.grantId)throw new Error('graph-owner-intent-grant-not-durable');
  return{kind:'owner-dashboard',grantId:value.grantId};
 }
 /** An opaque grant ID never authenticates an HTTP request. Its exact signed
  * queue/request binding is required before this current-policy check is used.
  */
 isCurrent(grantId:string,idempotencyKey:string,principalKey:string):boolean{
  return this.verdict(grantId,idempotencyKey,principalKey)==='current';
 }
 verdict(grantId:string,idempotencyKey:string,principalKey:string):'current'|'revoked'|'unavailable'{
  try{
   const prior=this.read(idempotencyKey);if(!prior)return'unavailable';
   const policy=this.marker(false);if(!policy.active)return'unavailable';return prior.grantId===grantId&&prior.principalKey===principalKey
    &&prior.policyMarker===policy.marker&&prior.policyEpoch===policy.epoch?'current':'revoked';
  }catch{ /* @silent-fallback-ok: unreadable authority holds the intent; it never produces a durable revocation outcome */ return'unavailable'; }
 }
}
