import {GRAPH_NATIVE_TAIL_DOMAIN} from '../../src/core/ConversationGraphNativeTail.js';
import {signGraphCustodyActivationPin,signGraphCustodyImportedState,type GraphCustodyActivationPin} from '../../src/core/GraphCustodyActivationPinTypes.js';
import {GraphCustodyProfileAuthority,GRAPH_CUSTODY_STAGE_DOMAIN,GRAPH_CUSTODY_INTENT_DOMAIN} from '../../src/core/GraphCustodyProfileAuthority.js';
import {createGraphOwnerRecoveryEnvelope,recoverGraphOwnerControl} from '../../src/core/GraphOwnerRecovery.js';
import {GRAPH_OWNER_RECOVERY_RECEIPT_DOMAIN} from '../../src/core/GraphOwnerRecoveryStore.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {SafeFsExecutor} from '../../src/core/SafeFsExecutor.js';
import {GraphCustodyBootstrapStore,GRAPH_CUSTODY_BOOTSTRAP_DOMAIN,verifyGraphCustodyBootstrapPublication,
 type GraphCustodyBootstrapPublication} from '../../src/core/GraphCustodyBootstrap.js';
import {createGraphCustodyProfile} from '../../src/core/GraphCustodyProfile.js';
import {GraphWitnessService} from '../../src/core/GraphWitnessService.js';
import {canonicalHash,GRAPH_SIGNATURE_DOMAINS as D,signGraphRecord,unsigned} from '../../src/core/GraphWitnessTypes.js';
import {witnessFixture,pem} from './graph-witness-fixtures.js';

const directories:string[]=[],services:GraphWitnessService[]=[];
afterEach(()=>{vi.restoreAllMocks();for(const service of services.splice(0))service.close();for(const dir of directories.splice(0))SafeFsExecutor.safeRmSync(dir,{recursive:true,force:true,operation:'graph-bootstrap-test:teardown'});});
function fixture(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'graph-bootstrap-'));directories.push(dir);
 const f=witnessFixture(dir),raw={...f.membership,failureDomain:'owned-machine-a'};
 const profile=createGraphCustodyProfile(raw,{mode:'owned-machine',witnessPublicKey:pem(f.witness.publicKey),hostMachineId:f.machines[0].machineId},f.owner.privateKey);
 const membership={...raw,custodyProfile:profile,signature:''};membership.signature=signGraphRecord(D.membership,unsigned(membership),f.owner.privateKey);
 const envelope=createGraphOwnerRecoveryEnvelope(f.owner.privateKey,membership);
 const recoveryReceipt=(machineId:string)=>{const machine=f.machines.find(row=>row.machineId===machineId)!;recoverGraphOwnerControl(envelope,membership,pem(f.owner.publicKey),machineId,machine.sealing.privateKey);const raw={v:1 as const,agentId:membership.agentId,envelopeHash:canonicalHash(envelope),membershipHash:canonicalHash(membership),profileHash:canonicalHash(profile),ownerPublicKeyHash:canonicalHash(pem(f.owner.publicKey)),machineId,storedAt:new Date().toISOString()};return{...raw,signature:signGraphRecord(GRAPH_OWNER_RECOVERY_RECEIPT_DOMAIN,raw,machine.signing.privateKey)};};
 const proof=f.leaseFor(),admission={v:1 as const,ownerRecoveryHash:canonicalHash(envelope),agentId:membership.agentId,principalKey:`owner:${membership.agentId}`,admissionId:'actual-owner-admission',authenticationMethod:'owner-device' as const,requestId:'bootstrap-request',profileHash:canonicalHash(profile),membershipHash:canonicalHash(membership),nativeLeaseHash:canonicalHash(proof.originalLease),machineId:f.machines[0].machineId,acceptedAt:new Date().toISOString()};
 const publication:GraphCustodyBootstrapPublication={v:1,ownerPublicKey:pem(f.owner.publicKey),membership,...proof,admission:{...admission,signature:signGraphRecord(GRAPH_CUSTODY_BOOTSTRAP_DOMAIN,admission,f.machines[0].signing.privateKey)}};
 const store=new GraphCustodyBootstrapStore(dir,membership.agentId);
 const pinAll=()=>{for(const m of f.machines)store.pin(publication,membership.members,m.machineId,m.signing.privateKey,recoveryReceipt(m.machineId));};
 return{...f,dir,membership,publication,store,pinAll,recoveryReceipt};
}
// Exercise the disk durability primitive on a genuinely constructed authority.
// Probe JSON is not signed authority and never enters the role lineage.
function readDurabilityFixture(){
 const f=fixture();f.pinAll();const authority=new GraphCustodyProfileAuthority({stateDir:f.dir,agentId:f.membership.agentId,publication:f.publication});
 const directory=path.join(f.dir,'conversation-graph','active-custody',canonicalHash(f.membership.agentId));fs.mkdirSync(directory,{recursive:true});
 const value={v:1,probe:'opaque'},file=path.join(directory,'durability-probe.json');fs.writeFileSync(file,JSON.stringify(value));
 const io=authority as unknown as {syncRetainedRead(name:string,value:unknown):void;persist(name:string,value:unknown):void};
 return{...f,authority,directory,value,file,io};
}
describe('bounded synchronous read durability',()=>{
 it('does not re-flush an unchanged file on later reads and preserves explicit publication barriers',()=>{
  const f=readDurabilityFixture(),real=fs.fsyncSync;let fileFlushes=0;const flush=vi.spyOn(fs,'fsyncSync').mockImplementation(fd=>{if(fs.fstatSync(fd).isFile())fileFlushes++;return real(fd);});let initial=0;
  {f.io.syncRetainedRead('durability-probe',f.value);initial=flush.mock.calls.length;expect(initial).toBeGreaterThan(1);expect(fileFlushes).toBe(1);f.io.syncRetainedRead('durability-probe',f.value);expect(flush).toHaveBeenCalledTimes(initial);f.io.persist('durability-probe',f.value);expect(flush.mock.calls.length).toBeGreaterThan(initial);expect(fileFlushes).toBeGreaterThan(1);}
  f.io.syncRetainedRead('durability-probe',f.value);const settled=flush.mock.calls.length;f.io.syncRetainedRead('durability-probe',f.value);expect(flush).toHaveBeenCalledTimes(settled);expect(f.authority.currentMembership()).toEqual(f.membership);
  // One changed parent re-flushes the file and every parent (the file stamp includes them), so a swap underneath cannot leave the holding directory unflushed.
  fs.utimesSync(f.dir,new Date(1000),new Date(1000));f.io.syncRetainedRead('durability-probe',f.value);expect(flush.mock.calls.length-settled).toBe(initial);const reflushed=flush.mock.calls.length;f.io.syncRetainedRead('durability-probe',f.value);expect(flush).toHaveBeenCalledTimes(reflushed);
  // A fresh instance has no memory of earlier flushes, which is what a restart looks like.
  (new GraphCustodyProfileAuthority({stateDir:f.dir,agentId:f.membership.agentId,publication:f.publication}) as unknown as typeof f.io).syncRetainedRead('durability-probe',f.value);expect(flush.mock.calls.length).toBeGreaterThan(reflushed);
 });
 it('flushes every new file while sharing only unchanged parent barriers',()=>{
  const f=readDurabilityFixture(),other={v:1,probe:'other'};fs.writeFileSync(path.join(f.directory,'other-probe.json'),JSON.stringify(other));const flush=vi.spyOn(fs,'fsyncSync');
  {f.io.syncRetainedRead('durability-probe',f.value);const before=flush.mock.calls.length;f.io.syncRetainedRead('other-probe',other);expect(flush.mock.calls.length-before).toBe(1);}
 });
 it('reflushes a same-content inode replacement and refuses changed bytes',()=>{
  const f=readDurabilityFixture(),flush=vi.spyOn(fs,'fsyncSync');
  {f.io.syncRetainedRead('durability-probe',f.value);const before=flush.mock.calls.length;const replacement=f.file+'.replacement';fs.writeFileSync(replacement,JSON.stringify(f.value));fs.renameSync(replacement,f.file);f.io.syncRetainedRead('durability-probe',f.value);expect(flush.mock.calls.length).toBeGreaterThan(before);fs.writeFileSync(f.file,JSON.stringify({v:1,probe:'changed'}));expect(()=>f.io.syncRetainedRead('durability-probe',f.value)).toThrow('readback-invalid');}
 });
 it('binds parent identity and refuses a missing retained file',()=>{
  const f=readDurabilityFixture(),flush=vi.spyOn(fs,'fsyncSync');
  {f.io.syncRetainedRead('durability-probe',f.value);const before=flush.mock.calls.length;fs.renameSync(f.directory,f.directory+'.old');fs.mkdirSync(f.directory);fs.writeFileSync(f.file,JSON.stringify(f.value));f.io.syncRetainedRead('durability-probe',f.value);expect(flush.mock.calls.length).toBeGreaterThan(before);SafeFsExecutor.safeUnlinkSync(f.file,{operation:'graph-read-durability-test:missing-file'});expect(()=>f.io.syncRetainedRead('durability-probe',f.value)).toThrow();}
 });
 it('forgets every earlier flush after a failed barrier',()=>{
  const f=readDurabilityFixture(),real=fs.fsyncSync,flush=vi.spyOn(fs,'fsyncSync').mockImplementation(real);
  f.io.syncRetainedRead('durability-probe',f.value);const settled=flush.mock.calls.length;f.io.syncRetainedRead('durability-probe',f.value);expect(flush).toHaveBeenCalledTimes(settled);
  const later=new Date(Date.now()+60000);fs.utimesSync(f.file,later,later);flush.mockImplementationOnce(()=>{throw new Error('barrier-failed');});expect(()=>f.io.syncRetainedRead('durability-probe',f.value)).toThrow('barrier-failed');
  const failedAt=flush.mock.calls.length;f.io.syncRetainedRead('durability-probe',f.value);expect(flush.mock.calls.length).toBeGreaterThan(failedAt+1);
 });
 it('never caches a positive lineage when a new negative control appears between reads',()=>{
  const f=readDurabilityFixture();
  {expect(f.authority.verifiedNegativeRoleLineage().pendingIntent).toBeNull();fs.writeFileSync(path.join(f.directory,'intent-2.json'),JSON.stringify({v:1,signature:'invalid'}));expect(()=>f.authority.verifiedNegativeRoleLineage()).toThrow('intent-invalid');}
  expect(()=>f.authority.verifiedNegativeRoleLineage()).toThrow('intent-invalid');
 });
 it('does not confuse unrelated ancestor sibling activity with a change in the owned root',()=>{
  const f=readDurabilityFixture(),real=fs.readSync,sibling=f.dir+'.unrelated';directories.push(sibling);let changed=false;
  vi.spyOn(fs,'readSync').mockImplementation(((...args:unknown[])=>{const read=Reflect.apply(real,fs,args);if(!changed){changed=true;fs.mkdirSync(sibling);}return read;}) as typeof fs.readSync);
  expect(()=>f.io.syncRetainedRead('durability-probe',f.value)).not.toThrow();expect(changed).toBe(true);
 });
});
describe('first owner-admitted custody publication',()=>{
 it('persists a real staging write hold through restart and requires all signed recovery holds plus activation before changing profile',()=>{
  const f=fixture();f.pinAll();let service=new GraphWitnessService({...f.options,failureDomain:f.membership.failureDomain,installedFailureDomains:[f.membership.failureDomain],ownedHost:{machineId:f.machines[0].machineId,signingPublicKey:f.membership.members[0].signingPublicKey}});services.push(service);service.registerMembership(f.membership);const manifest=service.recoveryManifest(f.membership.agentId);const authority=()=>new GraphCustodyProfileAuthority({stateDir:f.dir,agentId:f.membership.agentId,publication:f.publication});
  authority().assertPositiveWrites(f.membership);
  const raw={...f.membership,epoch:2,previousMembershipHash:canonicalHash(f.membership)};delete (raw as {custodyProfile?:unknown}).custodyProfile;
  const profile=createGraphCustodyProfile(raw,{mode:'owned-machine',witnessPublicKey:pem(f.witness.publicKey),hostMachineId:f.machines[0].machineId},f.owner.privateKey),next={...raw,custodyProfile:profile,signature:''};next.signature=signGraphRecord(D.membership,unsigned(next),f.owner.privateKey);
  const envelope=createGraphOwnerRecoveryEnvelope(f.owner.privateKey,next),authorizationRaw={v:1 as const,agentId:next.agentId,recoveryId:'owned-profile-stage-two',previousMembershipHash:canonicalHash(f.membership),newMembershipHash:canonicalHash(next),previousWitnessId:f.membership.witnessId,newWitnessId:next.witnessId,fenceEpoch:1,highestCertifiedSequence:0,highestCertifiedCoreHash:null,pendingOutcomes:[],sourceManifestHash:canonicalHash(manifest),rewrapInventoryHash:canonicalHash([]),issuedAt:new Date().toISOString()},authorization={...authorizationRaw,signature:signGraphRecord(D.recovery,authorizationRaw,f.owner.privateKey)},intentRaw={v:1 as const,agentId:next.agentId,previousMembership:f.membership,newMembership:next,ownerRecoveryHash:canonicalHash(envelope),issuedAt:new Date().toISOString()},holdIntent={...intentRaw,signature:signGraphRecord(GRAPH_CUSTODY_INTENT_DOMAIN,intentRaw,f.owner.privateKey)},intentHolds=f.machines.map(machine=>{recoverGraphOwnerControl(envelope,next,pem(f.owner.publicKey),machine.machineId,machine.sealing.privateKey);const receiptRaw={v:1 as const,agentId:next.agentId,envelopeHash:canonicalHash(envelope),membershipHash:canonicalHash(next),profileHash:canonicalHash(profile),ownerPublicKeyHash:canonicalHash(pem(f.owner.publicKey)),machineId:machine.machineId,storedAt:new Date().toISOString()},receipt={...receiptRaw,signature:signGraphRecord(GRAPH_OWNER_RECOVERY_RECEIPT_DOMAIN,receiptRaw,machine.signing.privateKey)};return authority().beginHold(holdIntent,machine.machineId,machine.signing.privateKey,receipt);}),stageRaw={v:1 as const,revision:1,supersedesHash:null,holdIntent,intentHolds,closedTails:f.machines.map(machine=>{const native=f.leaseFor(),raw={v:1 as const,agentId:next.agentId,membershipHash:canonicalHash(f.membership),writerId:native.lease.writerId,leaseEpoch:native.lease.leaseEpoch,nativeLeaseHash:canonicalHash(native.originalLease),machineId:machine.machineId,tailHash:canonicalHash([]),entryCount:0,highestSourceSequence:0,recordedAt:new Date().toISOString()};return{receipt:{...raw,signature:signGraphRecord(GRAPH_NATIVE_TAIL_DOMAIN,raw,machine.signing.privateKey)},observedLease:native.lease,originalObservedLease:native.originalLease,entries:[]};}),agentId:next.agentId,authorization,previousMembership:f.membership,newMembership:next,ownerRecoveryHash:canonicalHash(envelope),issuedAt:new Date().toISOString()},stage={...stageRaw,signature:signGraphRecord(GRAPH_CUSTODY_STAGE_DOMAIN,stageRaw,f.owner.privateKey)};
  const allocation=service.holdOwnedProfile(f.membership.agentId,holdIntent);expect(allocation.intentHash).toBe(canonicalHash(holdIntent));const blocked=f.prepareRequest();blocked.controlCapsule.authorizationProof.membership=f.membership;blocked.packet.controlHash=canonicalHash(blocked.controlCapsule);blocked.packetSignature=signGraphRecord(D.packet,blocked.packet,f.machines[0].signing.privateKey);expect(()=>service.prepare(blocked)).toThrow('custody-allocation-held');expect(service.operation(f.membership.agentId,blocked.packet.idempotencyKey)).toBeNull();expect(service.holdOwnedProfile(f.membership.agentId,holdIntent)).toEqual(allocation);
  const holds=f.machines.map(machine=>{recoverGraphOwnerControl(envelope,next,pem(f.owner.publicKey),machine.machineId,machine.sealing.privateKey);const receiptRaw={v:1 as const,agentId:next.agentId,envelopeHash:canonicalHash(envelope),membershipHash:canonicalHash(next),profileHash:canonicalHash(profile),ownerPublicKeyHash:canonicalHash(pem(f.owner.publicKey)),machineId:machine.machineId,storedAt:new Date().toISOString()},receipt={...receiptRaw,signature:signGraphRecord(GRAPH_OWNER_RECOVERY_RECEIPT_DOMAIN,receiptRaw,machine.signing.privateKey)};return authority().beginStage(stage,machine.machineId,machine.signing.privateKey,receipt);});
  expect(()=>authority().assertPositiveWrites(f.membership)).toThrow('staging-hold');expect(authority().currentMembership()).toEqual(f.membership);
  const transfers=f.machines.map(machine=>{const row={v:1 as const,agentId:next.agentId,recoveryId:authorization.recoveryId,newMembershipHash:canonicalHash(next),sourceManifestHash:authorization.sourceManifestHash,rewrapInventoryHash:authorization.rewrapInventoryHash,highestCertifiedSequence:0,highestCertifiedCoreHash:null,machineId:machine.machineId,persistedAt:new Date().toISOString()};return{...row,signature:signGraphRecord(D.membershipTransfer,row,machine.signing.privateKey)};}),certificateRaw={v:1 as const,agentId:next.agentId,previousMembership:f.membership,newMembership:next,ownerAuthorization:authorization,stateTransferReceipts:transfers,witnessId:next.witnessId,activatedAt:new Date().toISOString()},certificate={...certificateRaw,signature:signGraphRecord(D.membershipActivation,certificateRaw,f.witness.privateKey)};
  expect(()=>authority().stageActivation(stage,certificate,holds.slice(0,1),null as never)).toThrow('certificate-invalid');expect(()=>authority().assertPositiveWrites(f.membership)).toThrow('staging-hold');
  const skippedRaw={...unsigned(stage),revision:3,supersedesHash:canonicalHash(stage)},skipped={...skippedRaw,signature:signGraphRecord(GRAPH_CUSTODY_STAGE_DOMAIN,skippedRaw,f.owner.privateKey)};expect(()=>authority().beginStage(skipped,holds[0].machineId,f.machines[0].signing.privateKey,holds[0].ownerRecoveryReceipt)).toThrow('revision-invalid');
  const revisedRaw={...unsigned(stage),revision:2,supersedesHash:canonicalHash(stage)},revised={...revisedRaw,signature:signGraphRecord(GRAPH_CUSTODY_STAGE_DOMAIN,revisedRaw,f.owner.privateKey)},revisedHolds=holds.map(hold=>authority().beginStage(revised,hold.machineId,f.machines.find(machine=>machine.machineId===hold.machineId)!.signing.privateKey,hold.ownerRecoveryReceipt));
  const current=f.leaseFor(),retirement=service.retireOwnedProfile(f.membership.agentId,{stage:revised,holds:revisedHolds,stateTransferReceipts:transfers,...current});
  const original=f.prepareRequest();original.controlCapsule.authorizationProof.membership=f.membership;original.packet.controlHash=canonicalHash(original.controlCapsule);original.packetSignature=signGraphRecord(D.packet,original.packet,f.machines[0].signing.privateKey);
  expect(()=>service.prepare(original)).toThrow('custody-profile-retired');service.close();services.splice(services.indexOf(service),1);service=new GraphWitnessService({...f.options,failureDomain:f.membership.failureDomain,installedFailureDomains:[f.membership.failureDomain],ownedHost:{machineId:f.machines[0].machineId,signingPublicKey:f.membership.members[0].signingPublicKey}});services.push(service);expect(()=>service.prepare(original)).toThrow('custody-profile-retired');
  const bridgeRaw={...unsigned(current.lease),membershipEpoch:2},newLease={...bridgeRaw,signature:signGraphRecord(D.lease,bridgeRaw,f.machines[0].signing.privateKey)},recovery={newMembership:next,authorization,currentLease:newLease,originalCurrentLease:current.originalLease,revalidations:[],stateTransferReceipts:transfers,sourceManifest:manifest,ownedTransition:{stage:revised,holds:revisedHolds,retirement}};
  const other=f.leaseFor(1,1),otherRaw={...unsigned(other.lease),membershipEpoch:2},otherBridge={...otherRaw,signature:signGraphRecord(D.lease,otherRaw,f.machines[1].signing.privateKey)};expect(()=>service.recoverPending(f.membership.agentId,{...recovery,currentLease:otherBridge,originalCurrentLease:other.originalLease})).toThrow('owned-profile-retirement-required');
  const actual=service.recoverPending(f.membership.agentId,recovery).activation;expect(actual.newMembership).toEqual(next);expect(()=>service.prepare(original)).toThrow('lease-proof-invalid');
  authority().stageActivation(revised,actual,revisedHolds,retirement);expect(authority().currentMembership()).toEqual(f.membership);expect(authority().verifiedNegativeRoleLineage().current).toEqual(next);expect(authority().verifiedNegativeRoleLineage().positiveCurrent).toEqual(f.membership);expect(()=>authority().assertPositiveWrites(next)).toThrow();
  // Cryptographic verifier fixture; real native/import pin execution is covered separately.
  const pins:GraphCustodyActivationPin[]=f.machines.map(machine=>{const before=actual.stateTransferReceipts.find(row=>row.machineId===machine.machineId)!,postRaw={...unsigned(before),persistedAt:new Date().toISOString()},post={...postRaw,signature:signGraphRecord(D.membershipTransfer,postRaw,machine.signing.privateKey)},imported=signGraphCustodyImportedState({v:1,agentId:next.agentId,machineId:machine.machineId,stageHash:canonicalHash(revised),activationHash:canonicalHash(actual),membershipHash:canonicalHash(next),sourceTransferReceiptHash:canonicalHash(post),importInventoryHash:canonicalHash([]),persistedAt:new Date().toISOString()},machine.signing.privateKey);return signGraphCustodyActivationPin({v:1,agentId:next.agentId,machineId:machine.machineId,stageHash:canonicalHash(revised),activationHash:canonicalHash(actual),membershipHash:canonicalHash(next),postImportTransferReceiptHash:canonicalHash(post),postImportTransferReceipt:post,postImportReceipt:imported,postImportReceiptHash:canonicalHash(imported),pinnedAt:new Date().toISOString()},machine.signing.privateKey);});
  expect(()=>authority().activate(revised,actual,revisedHolds,retirement,pins.slice(0,1))).toThrow('act-pins-incomplete');const wrong={...unsigned(pins[0]),membershipHash:canonicalHash(f.membership)};expect(()=>authority().activate(revised,actual,revisedHolds,retirement,[signGraphCustodyActivationPin(wrong,f.machines[0].signing.privateKey),pins[1]])).toThrow('act-pin-invalid');
  expect(()=>authority().activate(stage,certificate,holds,retirement,pins)).toThrow('stage-not-held');const activationPath=path.join(f.dir,'conversation-graph','active-custody',canonicalHash(f.membership.agentId),'activation-2.json'),originalBarrier=fs.fsyncSync,fault=vi.spyOn(fs,'fsyncSync').mockImplementation(fd=>{if(fs.existsSync(activationPath)&&fs.fstatSync(fd).isDirectory()&&fs.fstatSync(fd).ino===fs.statSync(path.dirname(activationPath)).ino)throw new Error('injected-activation-directory-barrier');return originalBarrier(fd);});expect(()=>authority().activate(revised,actual,revisedHolds,retirement,pins)).toThrow('injected-activation-directory-barrier');expect(()=>authority().assertPositiveWrites(next)).toThrow('injected-activation-directory-barrier');expect(()=>authority().activate(revised,actual,revisedHolds,retirement,pins)).toThrow('injected-activation-directory-barrier');fault.mockRestore();authority().activate(revised,actual,revisedHolds,retirement,pins);expect(authority().currentMembership()).toEqual(next);authority().assertPositiveWrites(next);expect(()=>authority().assertPositiveWrites(f.membership)).toThrow('profile-mismatch');authority().activate(revised,actual,revisedHolds,retirement,pins);
 });

 it('reads established genesis only through its original exact durable anchor, without relaxing initial installed-roster verification',()=>{const f=fixture();f.pinAll();const anchor={v:1 as const,agentId:f.membership.agentId,publicationHash:canonicalHash(f.publication),ownerPublicKeyHash:canonicalHash(f.publication.ownerPublicKey),membershipHash:canonicalHash(f.membership)},cold=new GraphCustodyBootstrapStore(f.dir,f.membership.agentId);expect(cold.establishedPublication(anchor)).toEqual(f.publication);expect(()=>cold.publication(f.membership.members.slice(1))).toThrow('publication-invalid');for(const field of ['publicationHash','ownerPublicKeyHash','membershipHash'] as const)expect(()=>cold.establishedPublication({...anchor,[field]:'f'.repeat(64)})).toThrow('anchor-mismatch');expect(()=>cold.establishedPublication({...anchor,agentId:'another-agent'})).toThrow('anchor-invalid');expect(()=>cold.establishedPublication({...anchor,extra:true} as never)).toThrow('anchor-invalid');});
 it('binds actual native lease, owner admission, strict installed roster and signed deployment',()=>{
  const f=fixture(),p=f.publication;
  expect(verifyGraphCustodyBootstrapPublication(p,f.membership.members)).toBe(true);
  expect(verifyGraphCustodyBootstrapPublication(p,f.membership.members.slice(1))).toBe(false);
  expect(verifyGraphCustodyBootstrapPublication({...p,admission:{...p.admission,authenticationMethod:'dispatch'} as never},f.membership.members)).toBe(false);
  expect(verifyGraphCustodyBootstrapPublication({...p,originalLease:{...p.originalLease,released:true}},f.membership.members)).toBe(false);
  expect(verifyGraphCustodyBootstrapPublication({...p,admission:{...p.admission,acceptedAt:p.originalLease.expiresAt}},f.membership.members)).toBe(false);
  expect(verifyGraphCustodyBootstrapPublication({...p,privateTitle:'not-a-field'} as never,f.membership.members)).toBe(false);
 });
 it('durably pins one publication and refuses competing genesis across restart',()=>{
  const f=fixture();f.store.pin(f.publication,f.membership.members,f.machines[0].machineId,f.machines[0].signing.privateKey,f.recoveryReceipt(f.machines[0].machineId));
  const reopened=new GraphCustodyBootstrapStore(f.dir,f.membership.agentId);
  expect(reopened.publication(f.membership.members)).toEqual(f.publication);
  expect(reopened.waitingMembers(f.membership.members)).toEqual([f.machines[1].machineId]);
  const other=fixture(),profile=createGraphCustodyProfile(f.membership,{mode:'owned-machine',witnessPublicKey:pem(f.witness.publicKey),hostMachineId:f.machines[0].machineId},other.owner.privateKey);
  const membership={...f.membership,custodyProfile:profile,signature:''};membership.signature=signGraphRecord(D.membership,unsigned(membership),other.owner.privateKey);
  const competingEnvelope=createGraphOwnerRecoveryEnvelope(other.owner.privateKey,membership);const admission={...f.publication.admission,ownerRecoveryHash:canonicalHash(competingEnvelope),profileHash:canonicalHash(profile),membershipHash:canonicalHash(membership),signature:''};admission.signature=signGraphRecord(GRAPH_CUSTODY_BOOTSTRAP_DOMAIN,unsigned(admission),f.machines[0].signing.privateKey);
  const competing={...f.publication,ownerPublicKey:pem(other.owner.publicKey),membership,admission};
  expect(verifyGraphCustodyBootstrapPublication(competing,f.membership.members)).toBe(true);
  expect(()=>reopened.pin(competing,f.membership.members,f.machines[0].machineId,f.machines[0].signing.privateKey,f.recoveryReceipt(f.machines[0].machineId))).toThrow('conflict');
 });
 it('never credits an existing pin after its publication link survived a still-failing directory barrier',()=>{
  const f=fixture(),pin=path.join(f.dir,'conversation-graph','bootstrap',canonicalHash(f.membership.agentId),'pin-'+canonicalHash(f.machines[0].machineId)+'.json'),directory=path.dirname(pin),original=fs.fsyncSync,barrier=vi.spyOn(fs,'fsyncSync').mockImplementation(fd=>{if(fs.existsSync(pin)&&fs.fstatSync(fd).isDirectory()&&fs.fstatSync(fd).ino===fs.statSync(directory).ino)throw new Error('injected-pin-directory-barrier');return original(fd);});
  expect(()=>f.store.pin(f.publication,f.membership.members,f.machines[0].machineId,f.machines[0].signing.privateKey,f.recoveryReceipt(f.machines[0].machineId))).toThrow('injected-pin-directory-barrier');expect(fs.existsSync(pin)).toBe(true);
  expect(()=>new GraphCustodyBootstrapStore(f.dir,f.membership.agentId).pin(f.publication,f.membership.members,f.machines[0].machineId,f.machines[0].signing.privateKey,f.recoveryReceipt(f.machines[0].machineId))).toThrow('injected-pin-directory-barrier');barrier.mockRestore();expect(f.store.pin(f.publication,f.membership.members,f.machines[0].machineId,f.machines[0].signing.privateKey,f.recoveryReceipt(f.machines[0].machineId)).publicationHash).toBe(canonicalHash(f.publication));
 });
 it('does not persist a publication when the purported local signing key is wrong',()=>{
  const f=fixture();expect(()=>f.store.pin(f.publication,f.membership.members,f.machines[0].machineId,f.machines[1].signing.privateKey,f.recoveryReceipt(f.machines[0].machineId))).toThrow('signer-invalid');
  expect(f.store.publication(f.membership.members)).toBeNull();
 });
 it('does not initialize a database until every installed member durably pins',()=>{
  const f=fixture(),database=path.join(f.dir,'custody.sqlite');let called=false;
  f.store.pin(f.publication,f.membership.members,f.machines[0].machineId,f.machines[0].signing.privateKey,f.recoveryReceipt(f.machines[0].machineId));
  expect(()=>f.store.openDatabase(f.membership.members,f.machines[0].machineId,database,()=>{called=true;})).toThrow('pins-pending');
  expect(called).toBe(false);expect(fs.existsSync(database)).toBe(false);
 });
 it('creates the real owned engine once and reopens its exact membership without reminting',()=>{
  const f=fixture(),database=path.join(f.dir,'custody.sqlite');f.pinAll();const freshFlags:boolean[]=[];
  const open=(fresh:boolean)=>{freshFlags.push(fresh);const service=new GraphWitnessService({...f.options,databasePath:database,failureDomain:f.membership.failureDomain,installedFailureDomains:[f.membership.failureDomain],ownedHost:{machineId:f.machines[0].machineId,signingPublicKey:f.membership.members[0].signingPublicKey}});services.push(service);if(fresh)service.registerMembership(f.membership);return service;};
  const service=f.store.openDatabase(f.membership.members,f.machines[0].machineId,database,open);expect(service.membershipProof(f.membership.agentId,1)).toEqual(f.membership);service.close();services.splice(services.indexOf(service),1);
  const reopened=new GraphCustodyBootstrapStore(f.dir,f.membership.agentId).openDatabase(f.membership.members,f.machines[0].machineId,database,open);
  expect(reopened.membershipProof(f.membership.agentId,1)).toEqual(f.membership);expect(freshFlags).toEqual([true,false]);
 });
 it('quarantines an interrupted creation claim and a missing previously acknowledged database',()=>{
  const f=fixture(),database=path.join(f.dir,'custody.sqlite');f.pinAll();
  expect(()=>f.store.openDatabase(f.membership.members,f.machines[0].machineId,database,()=>{throw new Error('crash-before-open');})).toThrow('crash-before-open');
  let retried=false;expect(()=>new GraphCustodyBootstrapStore(f.dir,f.membership.agentId).openDatabase(f.membership.members,f.machines[0].machineId,database,()=>{retried=true;})).toThrow('restore-quarantine');expect(retried).toBe(false);
 });
 it('refuses an unclaimed preexisting database and prevents reentrant duplicate creation',()=>{
  const f=fixture(),database=path.join(f.dir,'custody.sqlite');f.pinAll();fs.writeFileSync(database,'old-backup');
  expect(()=>f.store.openDatabase(f.membership.members,f.machines[0].machineId,database,()=>null)).toThrow('unpublished-database');
  SafeFsExecutor.safeUnlinkSync(database,{operation:'graph-bootstrap-test:remove-unpublished-fixture'});
  expect(()=>f.store.openDatabase(f.membership.members,f.machines[0].machineId,database,()=>{
   return new GraphCustodyBootstrapStore(f.dir,f.membership.agentId).openDatabase(f.membership.members,f.machines[0].machineId,database,()=>{throw new Error('second-creation');});
  })).toThrow('restore-quarantine');
 });
 it('refuses inherited bootstrap links and custody database paths outside the state root',()=>{
  const f=fixture(),outside=fs.mkdtempSync(path.join(os.tmpdir(),'graph-bootstrap-outside-'));directories.push(outside);
  fs.symlinkSync(outside,path.join(f.dir,'conversation-graph'),'dir');
  expect(()=>f.store.pin(f.publication,f.membership.members,f.machines[0].machineId,f.machines[0].signing.privateKey,f.recoveryReceipt(f.machines[0].machineId))).toThrow('symlink');
  expect(fs.readdirSync(outside)).toEqual([]);
  SafeFsExecutor.safeUnlinkSync(path.join(f.dir,'conversation-graph'),{operation:'graph-bootstrap-test:remove-link'});f.pinAll();
  expect(()=>f.store.openDatabase(f.membership.members,f.machines[0].machineId,path.join(outside,'custody.sqlite'),()=>null)).toThrow('outside-state');
 });
});
