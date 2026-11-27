/** Actual native/member/source/W SQLite transition and physical negative purge.
 * Synthetic identities/temporary roles only; no production host/key/backup claim. */
import {describe,it,expect,vi} from 'vitest';
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {setupGraphRuntimeFixture as setup,witnesses} from '../helpers/conversation-graph-runtime.js';
import {GraphCustodyBootstrapStore} from '../../src/core/GraphCustodyBootstrap.js';
import {GraphCustodyProfileAuthority,GRAPH_CUSTODY_INTENT_DOMAIN,GRAPH_CUSTODY_STAGE_DOMAIN} from '../../src/core/GraphCustodyProfileAuthority.js';
import {createGraphCustodyProfile} from '../../src/core/GraphCustodyProfile.js';
import {GraphWitnessService,graphWitnessBootstrapPayload} from '../../src/core/GraphWitnessService.js';
import {GraphWitnessClient} from '../../src/core/GraphWitnessClient.js';
import {createStagedGraphCustodyTransport} from '../../src/core/GraphCustodyTransport.js';
import {createGraphOwnerRecoveryEnvelope} from '../../src/core/GraphOwnerRecovery.js';
import {GraphOwnerRecoveryStore} from '../../src/core/GraphOwnerRecoveryStore.js';
import {IdentityStore} from '../../src/core/IdentityStore.js';
import {canonicalHash,signGraphRecord,unsigned,GRAPH_SIGNATURE_DOMAINS as D,witnessActionPayload,graphRewrapInventoryHash} from '../../src/core/GraphWitnessTypes.js';

const pem=(key:crypto.KeyObject)=>key.export({format:'pem',type:key.type==='private'?'pkcs8':'spki'}).toString();
describe('historical source proof during transport publication',()=>{
 it('keeps real journal bookkeeping independent while refusing an actual concurrent erasure',async()=>{
  const {f,managers,runtime,peer,service:old,options}=await setup({ownedCustodyHostIndex:0});await runtime.refreshReadiness();await peer.refreshReadiness();
  const stateDir=managers[0].baseDir,owner=pem(f.owner.publicKey),publication=new GraphCustodyBootstrapStore(stateDir,'echo').publication(f.membership.members)!;
  const authority=new GraphCustodyProfileAuthority({stateDir,agentId:'echo',publication});
  const record=f.record('retired-role-private-01');
  expect((await runtime.withSourceMutation(token=>runtime.submitPrepared({coreType:record.coreType,idempotencyKey:record.packet.idempotencyKey,requestHash:canonicalHash('retired-private'),core:record.core,authorizationProof:record.authorizationProof,plaintextSource:Buffer.from('private application ciphertext custody')},token))).state).toBe('committed');
  const saved=runtime.source.repairRecord(record.packet.eventId)!,manifest=old.recoveryManifest('echo'),key2=crypto.generateKeyPairSync('ed25519');
  const raw={...f.membership,epoch:2,previousMembershipHash:canonicalHash(f.membership),witnessId:'owned-successor-role',failureDomain:'owned-successor-domain'};delete (raw as {custodyProfile?:unknown}).custodyProfile;
  const profile=createGraphCustodyProfile(raw,{mode:'owned-machine',witnessPublicKey:pem(key2.publicKey),hostMachineId:runtime.machineId},f.owner.privateKey),next={...raw,custodyProfile:profile,signature:''};next.signature=signGraphRecord(D.membership,unsigned(next),f.owner.privateKey);
  const rewrap=runtime.source.rewrapVerifiedPayload(saved,next,runtime.machineId,managers[0].loadSigningKey()),rewraps=[{eventId:saved.packet.eventId,rewrap}],rewrapInventoryHash=graphRewrapInventoryHash(rewraps.map(row=>({eventId:row.eventId,rewrapHash:canonicalHash(row.rewrap)})));
  const native=runtime.actuation(),bridgeRaw={...unsigned(native.lease),membershipEpoch:2},bridge={...bridgeRaw,signature:signGraphRecord(D.lease,bridgeRaw,managers[0].loadSigningKey())};
  const authorizationRaw={v:1 as const,agentId:'echo',recoveryId:'actual-role-move-two',previousMembershipHash:canonicalHash(f.membership),newMembershipHash:canonicalHash(next),previousWitnessId:f.membership.witnessId,newWitnessId:next.witnessId,fenceEpoch:native.lease.leaseEpoch,highestCertifiedSequence:manifest.highestCertifiedSequence,highestCertifiedCoreHash:manifest.highestCertifiedCoreHash,pendingOutcomes:[],sourceManifestHash:canonicalHash(manifest),rewrapInventoryHash,issuedAt:new Date().toISOString()},authorization={...authorizationRaw,signature:signGraphRecord(D.recovery,authorizationRaw,f.owner.privateKey)};
  const envelope=createGraphOwnerRecoveryEnvelope(f.owner.privateKey,next),receipts=managers.map(identity=>new GraphOwnerRecoveryStore({stateDir:identity.baseDir,agentId:'echo',identity,identities:new IdentityStore({stateDir:identity.baseDir})}).put(envelope,next,owner));
  const intentRaw={v:1 as const,agentId:'echo',previousMembership:f.membership,newMembership:next,ownerRecoveryHash:canonicalHash(envelope),issuedAt:new Date().toISOString()},holdIntent={...intentRaw,signature:signGraphRecord(GRAPH_CUSTODY_INTENT_DOMAIN,intentRaw,f.owner.privateKey)};
  const memberAuthorities=managers.map((manager,index)=>index===0?authority:new GraphCustodyProfileAuthority({stateDir:manager.baseDir,agentId:'echo',publication}));
  const intentHolds=managers.map((manager,index)=>memberAuthorities[index].beginHold(holdIntent,manager.loadIdentity().machineId,manager.loadSigningKey(),receipts[index]));
  const closedTails=await Promise.all([runtime.custodyTransitionTail(holdIntent,{lease:native.lease,originalLease:native.originalLease}),peer.custodyTransitionTail(holdIntent,{lease:native.lease,originalLease:native.originalLease})]);
  const stageRaw={v:1 as const,agentId:'echo',revision:1,supersedesHash:null,holdIntent,intentHolds,closedTails,authorization,previousMembership:f.membership,newMembership:next,ownerRecoveryHash:canonicalHash(envelope),issuedAt:new Date().toISOString()},stage={...stageRaw,signature:signGraphRecord(GRAPH_CUSTODY_STAGE_DOMAIN,stageRaw,f.owner.privateKey)};
  const holds=managers.map((manager,index)=>memberAuthorities[index].beginStage(stage,manager.loadIdentity().machineId,manager.loadSigningKey(),receipts[index]));
  expect(()=>new GraphCustodyProfileAuthority({stateDir,agentId:'echo',publication}).assertPositiveWrites(f.membership)).toThrow('staging-hold');expect(authority.verifiedNegativeRoleLineage().stages).toHaveLength(1);
  const transferStage={authorization,previousMembership:f.membership,newMembership:next,currentLease:bridge,originalCurrentLease:native.originalLease,manifest,records:[saved],revalidations:[],rewraps};
  const transfers=await Promise.all([runtime.transfer.stage(transferStage),peer.transfer.stage(transferStage)]);
  const retirement=old.retireOwnedProfile('echo',{stage,holds,stateTransferReceipts:transfers,...native});
  const oldOperation=old.operation('echo',saved.packet.idempotencyKey)!;
  const directory=path.join(stateDir,'conversation-graph','roles',canonicalHash(next.witnessId));fs.mkdirSync(directory,{recursive:true});
  fs.writeFileSync(path.join(directory,'claim.json'),JSON.stringify({v:1,agentId:'echo',witnessId:next.witnessId,membershipHash:canonicalHash(next),ownerPublicKeyHash:canonicalHash(owner),stageHash:canonicalHash(stage),retirementHash:canonicalHash(retirement),sourceManifestHash:authorization.sourceManifestHash,rewrapInventoryHash}));
  const token='retired-role-test-private-token',successor=new GraphWitnessService({databasePath:path.join(directory,'custody.sqlite'),witnessId:next.witnessId,failureDomain:next.failureDomain,signingPrivateKey:key2.privateKey,ownedHost:{machineId:runtime.machineId,signingPublicKey:next.members[0].signingPublicKey},enrollments:{echo:{ownerPublicKey:owner,bearerToken:token}},historicalWitnessPublicKeys:{[f.membership.witnessId]:pem(f.witness.publicKey)},installedFailureDomains:['actual-owned-test']});witnesses.push(successor);
  const recovery={newMembership:next,authorization,currentLease:bridge,originalCurrentLease:native.originalLease,revalidations:[],stateTransferReceipts:transfers,sourceManifest:manifest,historicalRewraps:rewraps,ownedTransition:{stage,holds,retirement}};
  const bootstrapRaw={recovery,memberships:[f.membership],operations:[{operation:oldOperation,encryptedSourceBundle:saved.encryptedSourceBundle}],erasures:[],previousFenceEpoch:native.lease.leaseEpoch};
  const bootstrapClient=new GraphWitnessClient({agentId:'echo',witnessId:next.witnessId,witnessPublicKey:pem(key2.publicKey),ownerPublicKey:owner,bearerToken:'',expectedFailureDomain:next.failureDomain,historicalWitnessPublicKeys:{[f.membership.witnessId]:pem(f.witness.publicKey)},transport:createStagedGraphCustodyTransport({service:successor,membership:next,ownerPublicKey:owner,bearerToken:token,transition:{stage,holds,retirement}})});
  const activation=(await bootstrapClient.bootstrap({...bootstrapRaw,bootstrapSignature:signGraphRecord('graph-witness-bootstrap-v1',graphWitnessBootstrapPayload(bootstrapRaw),f.owner.privateKey)})).activation;
  authority.stageActivation(stage,activation,holds,retirement);expect(authority.currentMembership()).toEqual(f.membership);expect(()=>authority.assertPositiveWrites(f.membership)).toThrow();
  runtime.installNegativeCustodyRole(activation);
  const imported=await runtime.transfer.postActivationTransferReceipt(transferStage,activation);expect(imported.historicalEventIds).toContain(saved.packet.eventId);
  const activationHash=canonicalHash(activation),manifestHash=canonicalHash(manifest);
  expect(await runtime.source.verifyDurableHistoricalImport(saved.packet.eventId,activationHash,manifestHash)).toMatch(/^[a-f0-9]{64}$/);
  let flushed=false;const actualSync=(runtime.source as any).syncHistoricalFile.bind(runtime.source);
  const flush=vi.spyOn(runtime.source as any,'syncHistoricalFile').mockImplementation(async(name:string,limit:number)=>{if(!flushed){flushed=true;await runtime.drainJournal();}return actualSync(name,limit);});
  try{await expect(runtime.source.verifyDurableHistoricalImport(saved.packet.eventId,activationHash,manifestHash)).resolves.toMatch(/^[a-f0-9]{64}$/);expect(flushed).toBe(true);}finally{flush.mockRestore();}
  const fields={requestId:'actual-during-import-erase',target:saved.packet.erasureIdentity,bundleHashes:[saved.packet.sourceBundleHash],authorizationReceiptHash:canonicalHash('actual owner forget')};
  const erasure=successor.erase('echo',fields.requestId,fields.target,fields.bundleHashes,fields.authorizationReceiptHash,bridge,native.originalLease,signGraphRecord(D.action,witnessActionPayload('erase',fields,bridge),managers[0].loadSigningKey())),erasureAuthority={membership:next,activations:[activation],endorsement:successor.erasureEndorsement('echo',fields.requestId,crypto.randomBytes(32).toString('base64url'))};
  let erased=false;const erase=vi.spyOn(runtime.source as any,'syncHistoricalFile').mockImplementation(async(name:string,limit:number)=>{if(!erased){erased=true;await runtime.source.applyErasure(erasure,erasureAuthority);}return actualSync(name,limit);});
  try{await expect(runtime.source.verifyDurableHistoricalImport(saved.packet.eventId,activationHash,manifestHash)).rejects.toThrow();expect(erased).toBe(true);}finally{erase.mockRestore();}
  expect(()=>runtime.source.openVerifiedPayload(runtime.source.repairRecord(saved.packet.eventId)!)).toThrow('erased');

 });
});
