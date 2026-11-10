/** Actual native/member/source/W SQLite transition and physical negative purge.
 * Synthetic identities/temporary roles only; no production host/key/backup claim. */
import {describe,it,expect,vi} from 'vitest';
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import Database from 'better-sqlite3';
import {setupGraphRuntimeFixture as setup,witnesses} from '../helpers/conversation-graph-runtime.js';
import {GraphCustodyBootstrapStore} from '../../src/core/GraphCustodyBootstrap.js';
import {GraphCustodyProfileAuthority,GRAPH_CUSTODY_INTENT_DOMAIN,GRAPH_CUSTODY_STAGE_DOMAIN} from '../../src/core/GraphCustodyProfileAuthority.js';
import {createGraphCustodyProfile} from '../../src/core/GraphCustodyProfile.js';
import {GraphWitnessService,graphWitnessBootstrapPayload,graphRecoveryUploadId} from '../../src/core/GraphWitnessService.js';
import {GraphWitnessClient} from '../../src/core/GraphWitnessClient.js';
import {createInProcessGraphCustodyTransport,createStagedGraphCustodyTransport} from '../../src/core/GraphCustodyTransport.js';
import {createGraphOwnerRecoveryEnvelope} from '../../src/core/GraphOwnerRecovery.js';
import {GraphOwnerRecoveryStore} from '../../src/core/GraphOwnerRecoveryStore.js';
import {IdentityStore} from '../../src/core/IdentityStore.js';
import {GraphCustodyRetiredRoles} from '../../src/core/GraphCustodyRetiredRoles.js';
import {SafeFsExecutor} from '../../src/core/SafeFsExecutor.js';
import {ConversationGraphLocalErasureFence} from '../../src/core/ConversationGraphLocalErasure.js';
import {signGraphErasureIngress} from '../../src/core/GraphErasureProtocol.js';
import {canonicalHash,signGraphRecord,unsigned,GRAPH_SIGNATURE_DOMAINS as D,witnessActionPayload,graphRewrapInventoryHash} from '../../src/core/GraphWitnessTypes.js';
// Multi-machine graph proof: takes longer than the push lane's 10 s default on slower Linux CI runners.
vi.setConfig({testTimeout:120_000});

const pem=(key:crypto.KeyObject)=>key.export({format:'pem',type:key.type==='private'?'pkcs8':'spki'}).toString();
describe('retired role erasure without historical signing keys',()=>{
 it('verifies actual retirement/ACT, purges old+new role ciphertext with current owner ingress, then imports real current W erasure',async()=>{
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
  const holds=managers.map((manager,index)=>authority.beginStage(stage,manager.loadIdentity().machineId,manager.loadSigningKey(),receipts[index]));
  expect(()=>new GraphCustodyProfileAuthority({stateDir,agentId:'echo',publication}).assertPositiveWrites(f.membership)).toThrow('staging-hold');expect(authority.verifiedNegativeRoleLineage().stages).toHaveLength(1);
  const transferStage={authorization,previousMembership:f.membership,newMembership:next,currentLease:bridge,originalCurrentLease:native.originalLease,manifest,records:[saved],revalidations:[],rewraps};
  const transfers=await Promise.all([runtime.transfer.stage(transferStage),peer.transfer.stage(transferStage)]);
  // Leave a REAL owner/native-authorized recovery upload unfinished in the
  // old role. Its key-envelope row is a separate private staged copy.
  const uploadHeader={newMembership:next,authorization,currentLease:bridge,originalCurrentLease:native.originalLease,sourceManifest:{...manifest,entries:[]}};
  const uploadPlan={kind:'recovery' as const,transferId:graphRecoveryUploadId(uploadHeader),requestHash:canonicalHash({authorization,manifest,rewraps}),header:uploadHeader,counts:{entry:manifest.entries.length,revalidation:0,receipt:next.members.length,'historical-rewrap':1},hasHistoricalRewraps:true};
  old.beginRecoveryUpload('echo',uploadPlan);old.putRecoveryUpload('echo',uploadPlan.transferId,'historical-rewrap',0,rewraps[0]);
  const retirement=old.retireOwnedProfile('echo',{stage,holds,stateTransferReceipts:transfers,...native});
  const oldOperation=old.operation('echo',saved.packet.idempotencyKey)!;
  const directory=path.join(stateDir,'conversation-graph','roles',canonicalHash(next.witnessId));fs.mkdirSync(directory,{recursive:true});
  fs.writeFileSync(path.join(directory,'claim.json'),JSON.stringify({v:1,agentId:'echo',witnessId:next.witnessId,membershipHash:canonicalHash(next),ownerPublicKeyHash:canonicalHash(owner),stageHash:canonicalHash(stage),retirementHash:canonicalHash(retirement),sourceManifestHash:authorization.sourceManifestHash,rewrapInventoryHash}));
  const token='retired-role-test-private-token',successor=new GraphWitnessService({databasePath:path.join(directory,'custody.sqlite'),witnessId:next.witnessId,failureDomain:next.failureDomain,signingPrivateKey:key2.privateKey,ownedHost:{machineId:runtime.machineId,signingPublicKey:next.members[0].signingPublicKey},enrollments:{echo:{ownerPublicKey:owner,bearerToken:token}},historicalWitnessPublicKeys:{[f.membership.witnessId]:pem(f.witness.publicKey)},installedFailureDomains:['actual-owned-test']});witnesses.push(successor);
  const recovery={newMembership:next,authorization,currentLease:bridge,originalCurrentLease:native.originalLease,revalidations:[],stateTransferReceipts:transfers,sourceManifest:manifest,historicalRewraps:rewraps,ownedTransition:{stage,holds,retirement}};
  const bootstrapRaw={recovery,memberships:[f.membership],operations:[{operation:oldOperation,encryptedSourceBundle:saved.encryptedSourceBundle}],erasures:[],previousFenceEpoch:native.lease.leaseEpoch};
  const bootstrapClient=new GraphWitnessClient({agentId:'echo',witnessId:next.witnessId,witnessPublicKey:pem(key2.publicKey),ownerPublicKey:owner,bearerToken:'',expectedFailureDomain:next.failureDomain,historicalWitnessPublicKeys:{[f.membership.witnessId]:pem(f.witness.publicKey)},transport:createStagedGraphCustodyTransport({service:successor,membership:next,ownerPublicKey:owner,bearerToken:token,transition:{stage,holds,retirement}})});
  const activation=(await bootstrapClient.bootstrap({...bootstrapRaw,bootstrapSignature:signGraphRecord('graph-witness-bootstrap-v1',graphWitnessBootstrapPayload(bootstrapRaw),f.owner.privateKey)})).activation;
  authority.stageActivation(stage,activation,holds,retirement);expect(authority.currentMembership()).toEqual(f.membership);expect(authority.verifiedNegativeRoleLineage().current).toEqual(next);expect(()=>authority.assertPositiveWrites(f.membership)).toThrow();
  old.close();witnesses.splice(witnesses.indexOf(old),1); // helper receives NO old role signing key.
  const target=saved.packet.erasureIdentity,fence=new ConversationGraphLocalErasureFence(stateDir);await fence.deny(target);
  const ingress=signGraphErasureIngress({v:1,agentId:'echo',requestId:'erase-retired-role-01',target,principalKey:'owner:echo',authenticationMethod:'owner-device',acceptedBy:runtime.machineId,membershipEpoch:2,membershipHash:canonicalHash(next),acceptedAt:new Date().toISOString()},managers[0].loadSigningKey());
  const helper=new GraphCustodyRetiredRoles({stateDir,identity:managers[0],authority});
  const oldFile=path.join(stateDir,'conversation-graph','custody.sqlite'),inspect=()=>{const db=new Database(oldFile,{readonly:true});try{return(db.prepare('SELECT COUNT(*) AS n FROM bundles WHERE ciphertext IS NOT NULL').get() as {n:number}).n;}finally{db.close();}};
  const volatile={sourceKind:'header' as const,sourceId:'hdr-not-durably-published'},volatileIngress=signGraphErasureIngress({...unsigned(ingress),requestId:'erase-volatile-not-published',target:volatile},managers[0].loadSigningKey());
  const failedPublication=vi.spyOn(fs.promises,'mkdir').mockRejectedValueOnce(new Error('injected-local-deny-publication-failure'));
  try{await expect(fence.deny(volatile)).rejects.toThrow('publication-failure');}finally{failedPublication.mockRestore();}
  expect(new ConversationGraphLocalErasureFence(stateDir).isDenied(volatile)).toBe(true);
  expect(()=>helper.purge(volatile,{ingress:volatileIngress,fence})).toThrow('local-erasure-fence-not-durable');expect(inspect()).toBeGreaterThan(0);await fence.deny(volatile);
  expect(inspect()).toBeGreaterThan(0);
  const stagedDb=new Database(oldFile,{readonly:true});try{expect((stagedDb.prepare("SELECT COUNT(*) AS n FROM witnessTransferRows WHERE section='historical-rewrap' AND body!='null'").get() as {n:number}).n).toBeGreaterThan(0);}finally{stagedDb.close();}
  const unassigned=new Database(oldFile),originalRow=unassigned.prepare('SELECT packet FROM operations WHERE eventId=?').get(saved.packet.eventId) as {packet:string};
  const missingIdentity=JSON.parse(originalRow.packet);delete missingIdentity.erasureIdentity;
  unassigned.prepare('UPDATE operations SET packet=? WHERE eventId=?').run(JSON.stringify(missingIdentity),saved.packet.eventId);
  try{expect(()=>helper.purge(target,{ingress,fence})).toThrow('evidence-missing');}
  finally{unassigned.prepare('UPDATE operations SET packet=? WHERE eventId=?').run(originalRow.packet,saved.packet.eventId);unassigned.close();}
  expect(inspect()).toBeGreaterThan(0);
  const alias=path.join(managers[1].baseDir,'outside-managed-role-alias.sqlite');fs.linkSync(oldFile,alias);
  try{expect(()=>helper.purge(target,{ingress,fence})).toThrow('evidence-missing');expect(inspect()).toBeGreaterThan(0);}
  finally{SafeFsExecutor.safeUnlinkSync(alias,{operation:'graph-retired-role-test-owned-hardlink-cleanup'});}
  expect(()=>helper.purge(target,{ingress:{...ingress,principalKey:'forged-owner'},fence})).toThrow('local-ingress-invalid');expect(inspect()).toBeGreaterThan(0);
  const activationFile=path.join(stateDir,'conversation-graph','active-custody',canonicalHash('echo'),'pending-activation-2.json'),activationBytes=fs.readFileSync(activationFile);
  SafeFsExecutor.safeUnlinkSync(activationFile,{operation:'graph-retired-role-test-synthetic-authority-rollback'});
  expect(()=>helper.purge(target,{ingress,fence})).toThrow('local-ingress-invalid');expect(inspect()).toBeGreaterThan(0);
  fs.writeFileSync(activationFile,activationBytes);
  expect(helper.purge(target,{ingress,fence}).roles.sort()).toEqual([f.membership.witnessId,next.witnessId].sort());
  for(const file of [path.join(stateDir,'conversation-graph','custody.sqlite'),path.join(directory,'custody.sqlite')]){const db=new Database(file,{readonly:true});try{expect((db.prepare('SELECT COUNT(*) AS n FROM bundles WHERE ciphertext IS NOT NULL').get() as {n:number}).n).toBe(0);expect((db.prepare('SELECT COUNT(*) AS n FROM localTargetErasures').get() as {n:number}).n).toBe(1);expect((db.prepare("SELECT COUNT(*) AS n FROM witnessTransferRows WHERE section='historical-rewrap' AND body!='null'").get() as {n:number}).n).toBe(0);}finally{db.close();}expect(!fs.existsSync(file+'-wal')||fs.statSync(file+'-wal').size===0).toBe(true);expect(fs.readFileSync(file).includes(Buffer.from(saved.encryptedSourceBundle!.ciphertext))).toBe(false);}
  expect(()=>successor.recover('echo',saved.packet.idempotencyKey)).toThrow('source-locally-erased');
  const client=new GraphWitnessClient({agentId:'echo',witnessId:next.witnessId,witnessPublicKey:pem(key2.publicKey),ownerPublicKey:owner,bearerToken:'',expectedFailureDomain:next.failureDomain,historicalWitnessPublicKeys:{[f.membership.witnessId]:pem(f.witness.publicKey)},transport:createInProcessGraphCustodyTransport({service:successor,membership:next,ownerPublicKey:owner,bearerToken:token})});
  const proofHashes=[saved.packet.sourceBundleHash];
  const eraseAction=signGraphRecord(D.action,witnessActionPayload('erase',{requestId:ingress.requestId,target,bundleHashes:proofHashes,authorizationReceiptHash:canonicalHash(ingress)},bridge),managers[0].loadSigningKey());
  const status=await client.beginFleetErasure(ingress,proofHashes,bridge,native.originalLease,eraseAction),erasureAuthority=await client.erasureAuthority(status.proof);
  expect(()=>helper.purge({...target,sourceId:target.sourceId+'-wrong'},{proof:status.proof,erasureAuthority})).toThrow('authority-invalid');
  expect(()=>helper.purge(target,{proof:status.proof,erasureAuthority:{...erasureAuthority,endorsement:{...erasureAuthority.endorsement,signature:'invalid'}}})).toThrow('authority-invalid');
  expect(()=>new GraphCustodyRetiredRoles({stateDir:managers[1].baseDir,identity:managers[1],authority})).toThrow('scope-mismatch');
  const adversarial=new Database(oldFile),packetRow=adversarial.prepare('SELECT packet FROM operations WHERE eventId=?').get(saved.packet.eventId) as {packet:string};
  const conflicting=JSON.parse(packetRow.packet);conflicting.erasureIdentity={...target,sourceId:target.sourceId+'-different'};
  adversarial.prepare('UPDATE operations SET packet=? WHERE eventId=?').run(JSON.stringify(conflicting),saved.packet.eventId);
  try{expect(()=>helper.purge(target,{proof:status.proof,erasureAuthority})).toThrow('evidence-missing');expect((adversarial.prepare('SELECT COUNT(*) AS n FROM targetErasures').get() as {n:number}).n).toBe(0);}
  finally{adversarial.prepare('UPDATE operations SET packet=? WHERE eventId=?').run(packetRow.packet,saved.packet.eventId);adversarial.close();}
  expect(helper.purge(target,{proof:status.proof,erasureAuthority}).purgeInventoryHash).toMatch(/^[a-f0-9]{64}$/);
  const unknown=path.join(stateDir,'conversation-graph','unknown-live-role-copy');fs.copyFileSync(oldFile,unknown);
  expect(()=>helper.purge(target,{proof:status.proof,erasureAuthority})).toThrow('evidence-missing');
  const oldDb=new Database(path.join(stateDir,'conversation-graph','custody.sqlite'),{readonly:true});try{expect((oldDb.prepare('SELECT COUNT(*) AS n FROM ownedRetirements').get() as {n:number}).n).toBe(1);}finally{oldDb.close();}
 });
});
