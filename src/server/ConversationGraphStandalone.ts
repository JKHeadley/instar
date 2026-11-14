import {DEVICE_KEY_LEDGER_FILE} from '../core/MobileDeviceKeyLedger.js';
import {assertGraphLocalPath} from '../core/GraphLocalFiles.js';
import {DASHBOARD_PIN_GENERATION_HEAD} from '../core/DashboardPinGeneration.js';
import {readConversationGraphOwnerPolicy} from '../core/ConversationGraphOwnerPolicy.js';
/** Real native infrastructure for a genuinely one-member installation.
 * Owner/profile bootstrap and graph custody remain the caller's authorities.
 * This helper never shrinks a roster or treats local custody as an off-device copy.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {MachineIdentityManager,base64ToSigningPem,sign,verify} from '../core/MachineIdentity.js';
import {IdentityStore} from '../core/IdentityStore.js';
import {FencedLease} from '../core/FencedLease.js';
import {LeaseCoordinator,type LeaseStore} from '../core/LeaseCoordinator.js';
import {LocalLeaseStore} from '../core/LocalLeaseStore.js';
import {SingleInstanceLock} from '../core/SingleInstanceLock.js';
import {WriteAdmission} from '../core/WriteAdmission.js';
import {buildWriteDomainRegistry} from '../core/WriteDomainRegistry.js';
import {CoherenceJournal} from '../core/CoherenceJournal.js';
import {ReplicatedKindRegistry} from '../core/ReplicatedRecordEnvelope.js';
import {ReplicatedPeerStreamReader} from '../core/ReplicatedPeerStreamReader.js';
import {HybridLogicalClock} from '../core/HybridLogicalClock.js';
import {DroppedOriginRegistry} from '../core/RollbackUnmerge.js';
import {ConflictStore} from '../core/ConflictStore.js';
import {PeerEndpointResolver} from '../core/PeerEndpointResolver.js';
import {canonicalHash,exactFields,verifyMembershipEpoch,type GraphMembershipEpoch} from '../core/GraphWitnessTypes.js';
import type {MachineIdentity,LeaseRecord} from '../core/types.js';
import type {ConversationGraphReplicationRuntime} from './ConversationGraphReplicationRuntime.js';

export interface ConversationGraphStandaloneEnrollment {
 membership:GraphMembershipEpoch;
 ownerPublicKey:crypto.KeyLike;
}
export interface ConversationGraphStandaloneOptions {
 stateDir:string;
 /** Reuse the server's acquired lifetime lock. The caller retains ownership. */
 instanceLock?:SingleInstanceLock;
 /** The caller alone owns authenticated genesis/profile publication. */
 enrollment:ConversationGraphStandaloneEnrollment|((identity:MachineIdentity)=>Promise<ConversationGraphStandaloneEnrollment>);
}

const LEASE_TTL_MS=60_000;
const RENEW_MS=15_000;

/** LocalLeaseStore is the existing native substrate. Confirm its persistence
 * independently: that class logs write errors rather than throwing them.
 * Failed confirmation permanently fences this composition, never grants an ACK.
 */
function confirmedLocalLeaseStore(filePath:string,identity:MachineIdentity,signingKey:string):LeaseStore&{fence():void} {
 const local=new LocalLeaseStore({filePath});let failed=false;
 const readDisk=():LeaseRecord|null=>{
  let stat:fs.Stats;try{stat=fs.lstatSync(filePath);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536)throw new Error('graph-standalone-lease-invalid');
  const body=JSON.parse(fs.readFileSync(filePath,'utf8')) as {lease?:LeaseRecord};const lease=body.lease;
  if(!lease||!exactFields(body,['lease'])||!exactFields(lease,['holder','epoch','acquiredAt','expiresAt','nonce','signature',...(lease.released===undefined?[]:['released'])])||lease.holder!==identity.machineId||!Number.isSafeInteger(lease.epoch)||lease.epoch<1
   ||!Number.isSafeInteger(lease.nonce)||lease.nonce<0||!Number.isFinite(Date.parse(lease.acquiredAt))||!Number.isFinite(Date.parse(lease.expiresAt))
   ||(lease.released!==undefined&&typeof lease.released!=='boolean')||(lease.released!==true&&Date.parse(lease.expiresAt)<=Date.parse(lease.acquiredAt))
   ||typeof lease.signature!=='string'||Buffer.from(lease.signature,'base64').toString('base64')!==lease.signature
   ||!verify(FencedLease.canonicalize(lease),lease.signature,base64ToSigningPem(identity.signingPublicKey)))throw new Error('graph-standalone-lease-invalid');
  return lease;
 };
 readDisk();
 const confirm=(candidate:LeaseRecord)=>{
  try{const file=fs.openSync(filePath,'r');try{fs.fsyncSync(file);}finally{fs.closeSync(file);}
   const directory=fs.openSync(path.dirname(filePath),'r');try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}
   if(canonicalHash(readDisk())!==canonicalHash(candidate))throw new Error('graph-standalone-lease-not-persisted');
  }catch(error){failed=true;throw error;}
 };
 return {
  fence:()=>{failed=true;},
  read:()=>{if(failed)throw new Error('graph-standalone-lease-fenced');return local.read();},
  casWrite:candidate=>{if(failed)throw new Error('graph-standalone-lease-fenced');const result=local.casWrite(candidate);if(result.ok)confirm(candidate);return result;},
  refresh:candidate=>{if(failed)return false;try{if(!local.refresh(candidate))return false;confirm(candidate);return true;}catch{failed=true;return false;}},
  forceLocalExpiry:()=>{
   if(failed)throw new Error('graph-standalone-lease-fenced');try{const previous=local.read().lease;if(!previous)return;
   // The base store's forceLocalExpiry changes expiry without re-signing. Keep
   // the same native epoch floor but persist an actual signed released fact.
   const raw={...previous,expiresAt:new Date().toISOString(),nonce:Math.max(previous.nonce+1,Date.now()),released:true};
   const released={...raw,signature:sign(FencedLease.canonicalize(raw),signingKey)};
   if(!local.refresh(released))throw new Error('graph-standalone-lease-release-failed');confirm(released);
   }catch(error){failed=true;throw error;}
  },
 };
}

/** Classification only: the real owner gate/enrollment remains outside this
 * helper. A current managed PIN HEAD contains no graph custody or machine key. */
function isManagedOwnerPolicyMetadata(stateDir:string,directory:string,name:string):boolean{
 if(directory!==stateDir||name!==DASHBOARD_PIN_GENERATION_HEAD)return false;
 try{const config=JSON.parse(fs.readFileSync(path.join(stateDir,'config.json'),'utf8')),policy=readConversationGraphOwnerPolicy({stateDir,forceFileKey:config?.secrets?.forceFileKey===true});if(!policy)return false;const file=path.join(stateDir,DASHBOARD_PIN_GENERATION_HEAD),before=fs.lstatSync(file);if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1)return false;const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));try{const opened=fs.fstatSync(fd);if(opened.dev!==before.dev||opened.ino!==before.ino)return false;const bytes=fs.readFileSync(fd,'utf8'),after=fs.lstatSync(file);return after.dev===before.dev&&after.ino===before.ino&&after.nlink===1&&bytes===JSON.stringify({version:1,generation:policy.generation})+'\n';}finally{fs.closeSync(fd);}}catch{/* @silent-fallback-ok: unreadable or mismatched metadata remains prior state and refuses identity creation; this never grants enrollment. */return false;}
}
/** A retained SecretStore master is private but is not a native identity.
 * Never read, rewrite, delete or treat it as enrollment/erasure authority. */
function hasPriorNativeFiles(stateDir:string,directory:string):boolean{
 let stat:fs.Stats;try{stat=fs.lstatSync(directory);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}
 if(!stat.isDirectory()||stat.isSymbolicLink())return true;assertGraphLocalPath(stateDir,directory);
 return fs.readdirSync(directory).some(name=>{if(directory!==path.join(stateDir,'machine')||name!=='secrets-master.key')return true;const file=path.join(directory,name);assertGraphLocalPath(stateDir,file);const key=fs.lstatSync(file);return !key.isFile()||key.isSymbolicLink()||key.nlink!==1||key.size!==64||(key.mode&0o077)!==0;});
}
export async function openConversationGraphStandalone(options:ConversationGraphStandaloneOptions){
 const stateDir=path.resolve(options.stateDir);fs.mkdirSync(stateDir,{recursive:true,mode:0o700});
 const instanceLock=options.instanceLock??new SingleInstanceLock({stateDir});const ownsLock=!options.instanceLock;
 if(!(instanceLock instanceof SingleInstanceLock)||path.resolve(instanceLock.lockPath())!==path.join(stateDir,'local','server-instance.lock'))throw new Error('graph-standalone-instance-lock-required');
 let journal:CoherenceJournal|undefined,writeAdmission:WriteAdmission|undefined;
 let closed=false,timer:NodeJS.Timeout|undefined,pending:Promise<void>|undefined;
 try{
  // acquire() implements the debug override by replacing a lock record. Refuse
  // it before that side effect, including when another caller owns the lock.
  if(ownsLock&&process.env.INSTAR_ALLOW_SECOND_INSTANCE==='1')throw new Error('graph-standalone-instance-lock-required');
  if(ownsLock){const acquired=await instanceLock.acquire();if(!acquired.acquired||acquired.overridden)throw new Error('graph-standalone-instance-lock-required');}
  if(!instanceLock.revalidate())throw new Error('graph-standalone-instance-lock-required');
  const identity=new MachineIdentityManager(stateDir),identities=new IdentityStore({stateDir});
  if(!identity.hasIdentity()){
   // A missing local identity alongside existing trust/key material is recovery,
   // never permission to bootstrap a second independent machine identity.
   const priorGraphState=[stateDir,path.join(stateDir,'state'),path.join(stateDir,'local')].some(directory=>fs.existsSync(directory)&&fs.readdirSync(directory).some(entry=>entry.startsWith('conversation-graph')&&!isManagedOwnerPolicyMetadata(stateDir,directory,entry)));
   const priorNativeMetadata=[identities.epochPath,identities.unacknowledgedPath,identities.transactionPath,path.join(stateDir,DEVICE_KEY_LEDGER_FILE)].some(file=>{try{fs.lstatSync(file);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}});
   if(typeof options.enrollment!=='function'||priorGraphState||priorNativeMetadata||Object.keys(identity.loadRegistry().machines).length||[path.join(stateDir,'machine'),path.join(stateDir,'machines')].some(directory=>hasPriorNativeFiles(stateDir,directory)))throw new Error('graph-standalone-identity-recovery-required');
   await identity.generateIdentity();
  }
  const local=identity.loadIdentity(),signingKey=identity.loadSigningKey();
  const enrollment=typeof options.enrollment==='function'?await options.enrollment(local):options.enrollment;
  if(!enrollment||!verifyMembershipEpoch(enrollment.membership,enrollment.ownerPublicKey)||enrollment.membership.members.length!==1||enrollment.membership.members[0].machineId!==local.machineId)throw new Error('graph-standalone-single-member-enrollment-required');
  const member=enrollment.membership.members[0];
  const publicDer=(key:string)=>crypto.createPublicKey(key.includes('BEGIN PUBLIC KEY')?key:{key:Buffer.from(key,'base64'),format:'der',type:'spki'}).export({format:'der',type:'spki'});
  if(!publicDer(member.signingPublicKey).equals(publicDer(local.signingPublicKey))||!publicDer(member.sealingPublicKey).equals(publicDer(local.encryptionPublicKey)))throw new Error('graph-standalone-enrollment-key-mismatch');
  const solo=()=>{
   try{if(closed||!instanceLock.revalidate())return false;const registry=identity.loadRegistry();const entries=Object.entries(registry.machines);
    if(entries.length!==1||entries[0][0]!==local.machineId||entries[0][1].status!=='active'||entries[0][1].revokedAt)return false;
    const current=identity.loadIdentity(),epoch=identities.getEpoch(local.machineId);
    return !epoch.revokedAt&&current.machineId===local.machineId&&current.signingPublicKey===local.signingPublicKey&&current.encryptionPublicKey===local.encryptionPublicKey;
   }catch{return false;}
  };
  if(!solo())throw new Error('graph-standalone-existing-roster-obligations');
  const leaseStore=confirmedLocalLeaseStore(path.join(stateDir,'local','conversation-graph-native-lease.json'),local,signingKey);
  const nativeLease=new FencedLease({selfMachineId:local.machineId,sign:data=>sign(data,signingKey),verify:(data,signature,holder)=>holder===local.machineId&&verify(data,signature,base64ToSigningPem(local.signingPublicKey))},{leaseTtlMs:LEASE_TTL_MS,failoverThresholdMs:LEASE_TTL_MS*2});
  const leaseCoordinator=new LeaseCoordinator({lease:nativeLease,store:leaseStore,presumedDeadHolders:()=>new Set(),isLeaseEligible:solo});
  if(!await leaseCoordinator.acquireIfEligible()||!leaseCoordinator.holdsLease())throw new Error('graph-standalone-native-lease-unavailable');
  const writeDomainRegistry=buildWriteDomainRegistry({machineId:local.machineId});
  writeAdmission=new WriteAdmission({thisMachineId:local.machineId,isReadOnly:()=>!solo()||!leaseCoordinator.holdsLease(),isPoolActive:()=>true,
   registry:writeDomainRegistry,dryRun:false,leaseHolder:()=>leaseCoordinator.currentHolder()});
  const registry=new ReplicatedKindRegistry();let runtime:Pick<ConversationGraphReplicationRuntime,'onJournalCommit'>|undefined;
  journal=new CoherenceJournal({stateDir,machineId:local.machineId,guardWrite:()=>{if(!solo()||!leaseCoordinator.holdsLease())throw new Error('graph-standalone-journal-not-admitted');},
   onReplicatedRecordsCommitted:(kind,entries)=>runtime?.onJournalCommit(kind,entries)});
  journal.setReplicatedKindRegistry(registry);journal.open();
  const endpointResolver=new PeerEndpointResolver({config:{enabled:true,hedgeDelayMs:0,priorityLan:20,priorityTailscale:10,priorityCloudflare:30,tailscaleEnabled:true,lanSubnetGate:true,unhealthyAfterFailures:2,endpointEvictionMs:60000,maxProbeBackoffMs:60000,requestTimeoutMs:5000}});
  const peerStreams=new ReplicatedPeerStreamReader({stateDir,registry,selfMachineId:local.machineId});
  const clock=new HybridLogicalClock({node:local.machineId,now:Date.now});
  const droppedOrigins=new DroppedOriginRegistry({stateDir}),conflictStore=new ConflictStore({stateDir,now:()=>new Date()});
  const tick=()=>{if(closed||pending)return;pending=(async()=>{try{if(!solo()){leaseStore.fence();closed=true;return;}await leaseCoordinator.acquireIfEligible();}catch{leaseStore.fence();closed=true;}})().finally(()=>{pending=undefined;});};
  return {identity,identities,instanceLock,enrollment,nativeLease,leaseStore,leaseCoordinator,writeAdmission,writeDomainRegistry,journal,registry,endpointResolver,peerStreams,clock,droppedOrigins,conflictStore,
   bindRuntime(value:Pick<ConversationGraphReplicationRuntime,'onJournalCommit'>){if(closed||runtime)throw new Error('graph-standalone-runtime-already-bound');runtime=value;},
   start(){if(closed)throw new Error('graph-standalone-closed');if(timer)return;timer=setInterval(tick,RENEW_MS);timer.unref();},
   async close(){closed=true;if(timer)clearInterval(timer);await pending;leaseStore.fence();try{journal!.close();}finally{try{writeAdmission!.stop();}finally{if(ownsLock)instanceLock.release();}}},
  };
 }catch(error){closed=true;if(timer)clearInterval(timer);try{journal?.close();}finally{try{writeAdmission?.stop();}finally{if(ownsLock)instanceLock.release();}}throw error;}
}
export type ConversationGraphStandalone=Awaited<ReturnType<typeof openConversationGraphStandalone>>;
