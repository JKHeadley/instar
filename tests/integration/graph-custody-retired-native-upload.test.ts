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
import {createGraphNativeSourceUpload,GRAPH_NATIVE_UPLOAD_DOMAIN} from '../../src/core/GraphNativeSourceUpload.js';
import {createGraphControlCapsule} from '../../src/core/GraphWitnessControl.js';
import {GraphCustodyRetiredRoles} from '../../src/core/GraphCustodyRetiredRoles.js';
import {SafeFsExecutor} from '../../src/core/SafeFsExecutor.js';
import {ConversationGraphLocalErasureFence} from '../../src/core/ConversationGraphLocalErasure.js';
import {signGraphErasureIngress} from '../../src/core/GraphErasureProtocol.js';
import {canonicalHash,signGraphRecord,unsigned,GRAPH_SIGNATURE_DOMAINS as D,witnessActionPayload,graphRewrapInventoryHash} from '../../src/core/GraphWitnessTypes.js';
// Multi-machine graph proof: takes longer than the push lane's 10 s default on slower Linux CI runners.
vi.setConfig({testTimeout:120_000});

const pem=(key:crypto.KeyObject)=>key.export({format:'pem',type:key.type==='private'?'pkcs8':'spki'}).toString();
describe('retired role erasure without historical signing keys',()=>{
 it.each(['current','retired'] as const)('purges complete and ACKed partial native uploads from actual %s owned role while preserving unrelated B',async(mode)=>{
  const {f,managers,runtime,peer,service:old,options}=await setup({ownedCustodyHostIndex:0});await runtime.refreshReadiness();await peer.refreshReadiness();
  const stateDir=managers[0].baseDir,owner=pem(f.owner.publicKey),publication=new GraphCustodyBootstrapStore(stateDir,'echo').publication(f.membership.members)!;
  const authority=new GraphCustodyProfileAuthority({stateDir,agentId:'echo',publication});
  const record=f.record('retired-role-private-01');
  expect((await runtime.withSourceMutation(token=>runtime.submitPrepared({coreType:record.coreType,idempotencyKey:record.packet.idempotencyKey,requestHash:canonicalHash('retired-private'),core:record.core,authorizationProof:record.authorizationProof,plaintextSource:Buffer.alloc(400000,65)},token))).state).toBe('committed');
  const otherRecord=f.record('unrelated-role-private-02');
  expect((await runtime.withSourceMutation(token=>runtime.submitPrepared({coreType:otherRecord.coreType,idempotencyKey:otherRecord.packet.idempotencyKey,requestHash:canonicalHash('unrelated-private'),core:otherRecord.core,authorizationProof:otherRecord.authorizationProof,plaintextSource:Buffer.from('unrelated acknowledged source copy')},token))).state).toBe('committed');
  const unrelated=runtime.source.repairRecord(otherRecord.packet.eventId)!;
  const saved=runtime.source.repairRecord(record.packet.eventId)!,manifest=old.recoveryManifest('echo'),key2=crypto.generateKeyPairSync('ed25519');
  const raw={...f.membership,epoch:2,previousMembershipHash:canonicalHash(f.membership),witnessId:'owned-successor-role',failureDomain:'owned-successor-domain'};delete (raw as {custodyProfile?:unknown}).custodyProfile;
  const profile=createGraphCustodyProfile(raw,{mode:'owned-machine',witnessPublicKey:pem(key2.publicKey),hostMachineId:runtime.machineId},f.owner.privateKey),next={...raw,custodyProfile:profile,signature:''};next.signature=signGraphRecord(D.membership,unsigned(next),f.owner.privateKey);
  const rewrap=runtime.source.rewrapVerifiedPayload(saved,next,runtime.machineId,managers[0].loadSigningKey()),rewraps=[{eventId:saved.packet.eventId,rewrap},{eventId:unrelated.packet.eventId,rewrap:runtime.source.rewrapVerifiedPayload(unrelated,next,runtime.machineId,managers[0].loadSigningKey())}],rewrapInventoryHash=graphRewrapInventoryHash(rewraps.map(row=>({eventId:row.eventId,rewrapHash:canonicalHash(row.rewrap)})));
  const native=runtime.actuation(),bridgeRaw={...unsigned(native.lease),membershipEpoch:2},bridge={...bridgeRaw,signature:signGraphRecord(D.lease,bridgeRaw,managers[0].loadSigningKey())};
  const authorizationRaw={v:1 as const,agentId:'echo',recoveryId:'actual-role-move-two',previousMembershipHash:canonicalHash(f.membership),newMembershipHash:canonicalHash(next),previousWitnessId:f.membership.witnessId,newWitnessId:next.witnessId,fenceEpoch:native.lease.leaseEpoch,highestCertifiedSequence:manifest.highestCertifiedSequence,highestCertifiedCoreHash:manifest.highestCertifiedCoreHash,pendingOutcomes:[],sourceManifestHash:canonicalHash(manifest),rewrapInventoryHash,issuedAt:new Date().toISOString()},authorization={...authorizationRaw,signature:signGraphRecord(D.recovery,authorizationRaw,f.owner.privateKey)};
  const envelope=createGraphOwnerRecoveryEnvelope(f.owner.privateKey,next),receipts=managers.map(identity=>new GraphOwnerRecoveryStore({stateDir:identity.baseDir,agentId:'echo',identity,identities:new IdentityStore({stateDir:identity.baseDir})}).put(envelope,next,owner));
  const intentRaw={v:1 as const,agentId:'echo',previousMembership:f.membership,newMembership:next,ownerRecoveryHash:canonicalHash(envelope),issuedAt:new Date().toISOString()},holdIntent={...intentRaw,signature:signGraphRecord(GRAPH_CUSTODY_INTENT_DOMAIN,intentRaw,f.owner.privateKey)};
  const memberAuthorities=managers.map((manager,index)=>index===0?authority:new GraphCustodyProfileAuthority({stateDir:manager.baseDir,agentId:'echo',publication}));
  const intentHolds=managers.map((manager,index)=>memberAuthorities[index].beginHold(holdIntent,manager.loadIdentity().machineId,manager.loadSigningKey(),receipts[index]));
  const closedTails=await Promise.all([runtime.custodyTransitionTail(holdIntent,{lease:native.lease,originalLease:native.originalLease}),peer.custodyTransitionTail(holdIntent,{lease:native.lease,originalLease:native.originalLease})]);
  const stageNative=(item:typeof saved,label:string,partial:boolean)=>{
   const rewrap=runtime.source.rewrapVerifiedPayload(item,f.membership,runtime.machineId,managers[0].loadSigningKey());
   const fields={v:1 as const,agentId:'echo',idempotencyKey:item.packet.idempotencyKey,operationHash:canonicalHash(item.packet),coreHash:item.packet.coreHash,sourceProofHash:closedTails[0].entries.find(e=>e.eventId===item.packet.eventId)!.sourceProofHash,subjectHeadsHash:canonicalHash([]),dependenciesHash:canonicalHash([]),rewrapHash:canonicalHash(rewrap),newMembershipHash:canonicalHash(f.membership),currentLeaseHash:canonicalHash(native.lease),writerId:runtime.machineId,decision:'adopt' as const,reason:'ok' as const,validatedAt:new Date(Date.now()+(label==='partial'?1:0)).toISOString()};
   const request={packet:item.packet,packetSignature:item.packetSignature,controlCapsule:createGraphControlCapsule(item.coreType,item.core,item.authorizationProof),encryptedSourceBundle:item.encryptedSourceBundle!,...native,originalSourceReceipt:item.certificate!.memberReceipts.find(r=>r.machineId===runtime.machineId)!,closedTails,revalidation:{...fields,signature:signGraphRecord(D.revalidation,fields,managers[0].loadSigningKey())},rewrap};
   const upload=createGraphNativeSourceUpload(request,body=>signGraphRecord(GRAPH_NATIVE_UPLOAD_DOMAIN,body,managers[0].loadSigningKey()));old.beginNativeSourceUpload('echo',upload.plan);
   const acknowledged=partial?upload.chunks.slice(0,1):upload.chunks;for(const [index,value]of acknowledged.entries())expect(old.putNativeSourceUpload('echo',upload.plan.transferId,index,value)).toEqual({hash:canonicalHash(value)});
   if(partial)expect(upload.chunks.length).toBeGreaterThan(1);return upload;
  };
  const completeA=stageNative(saved,'complete',false),partialA=stageNative(saved,'partial',true),completeB=stageNative(unrelated,'unrelated',false);
  const nativeDb=path.join(stateDir,'conversation-graph','custody.sqlite');
  const nativeRows=(id:string)=>{const db=new Database(nativeDb,{readonly:true});try{return db.prepare("SELECT body FROM witnessTransferRows WHERE transferId=? AND section='native-source' AND body!='null' ORDER BY rowIndex").all(id) as {body:string}[];}finally{db.close();}};
  const retainedB=nativeRows(completeB.plan.transferId);expect(retainedB).toHaveLength(completeB.chunks.length);
  const assertNativePurged=()=>{expect(nativeRows(completeA.plan.transferId)).toHaveLength(0);expect(nativeRows(partialA.plan.transferId)).toHaveLength(0);expect(nativeRows(completeB.plan.transferId)).toEqual(retainedB);};
  const rejectForgedNative=(helper:GraphCustodyRetiredRoles,target:typeof saved.packet.erasureIdentity,ingress:ReturnType<typeof signGraphErasureIngress>,fence:ConversationGraphLocalErasureFence)=>{
   const db=new Database(nativeDb),planRow=db.prepare('SELECT plan FROM witnessTransfers WHERE transferId=?').get(partialA.plan.transferId) as {plan:string};
   const wrongSigner={...partialA.plan,signature:signGraphRecord(GRAPH_NATIVE_UPLOAD_DOMAIN,unsigned(partialA.plan),managers[1].loadSigningKey())};
   db.prepare('UPDATE witnessTransfers SET plan=? WHERE transferId=?').run(JSON.stringify(wrongSigner),partialA.plan.transferId);
   try{expect(()=>helper.purge(target,{ingress,fence})).toThrow('evidence-missing');expect(nativeRows(partialA.plan.transferId)).toHaveLength(1);}finally{db.prepare('UPDATE witnessTransfers SET plan=? WHERE transferId=?').run(planRow.plan,partialA.plan.transferId);}
   const chunk=db.prepare("SELECT body,hash FROM witnessTransferRows WHERE transferId=? AND section='native-source' AND rowIndex=0").get(partialA.plan.transferId) as {body:string;hash:string};
   db.prepare("UPDATE witnessTransferRows SET body=?,hash=? WHERE transferId=? AND section='native-source' AND rowIndex=0").run(JSON.stringify(completeB.chunks[0]),canonicalHash(completeB.chunks[0]),partialA.plan.transferId);
   try{expect(()=>helper.purge(target,{ingress,fence})).toThrow('evidence-missing');expect(nativeRows(completeA.plan.transferId)).toHaveLength(completeA.chunks.length);}finally{db.prepare("UPDATE witnessTransferRows SET body=?,hash=? WHERE transferId=? AND section='native-source' AND rowIndex=0").run(chunk.body,chunk.hash,partialA.plan.transferId);db.close();}
  };
  if(mode==='current'){
   const target=saved.packet.erasureIdentity,fence=new ConversationGraphLocalErasureFence(stateDir);await fence.deny(target);
   const ingress=signGraphErasureIngress({v:1,agentId:'echo',requestId:'erase-native-current',target,principalKey:'owner:echo',authenticationMethod:'owner-device',acceptedBy:runtime.machineId,membershipEpoch:1,membershipHash:canonicalHash(f.membership),acceptedAt:new Date().toISOString()},managers[0].loadSigningKey());
   const helper=new GraphCustodyRetiredRoles({stateDir,identity:managers[0],authority});rejectForgedNative(helper,target,ingress,fence);expect(helper.purge(target,{ingress,fence}).purgeInventoryHash).toMatch(/^[a-f0-9]{64}$/);assertNativePurged();return;
  }
  const stageRaw={v:1 as const,agentId:'echo',revision:1,supersedesHash:null,holdIntent,intentHolds,closedTails,authorization,previousMembership:f.membership,newMembership:next,ownerRecoveryHash:canonicalHash(envelope),issuedAt:new Date().toISOString()},stage={...stageRaw,signature:signGraphRecord(GRAPH_CUSTODY_STAGE_DOMAIN,stageRaw,f.owner.privateKey)};
  const holds=managers.map((manager,index)=>authority.beginStage(stage,manager.loadIdentity().machineId,manager.loadSigningKey(),receipts[index]));
  expect(()=>new GraphCustodyProfileAuthority({stateDir,agentId:'echo',publication}).assertPositiveWrites(f.membership)).toThrow('staging-hold');expect(authority.verifiedNegativeRoleLineage().stages).toHaveLength(1);
  const transferStage={authorization,previousMembership:f.membership,newMembership:next,currentLease:bridge,originalCurrentLease:native.originalLease,manifest,records:[saved,unrelated],revalidations:[],rewraps};
  const transfers=await Promise.all([runtime.transfer.stage(transferStage),peer.transfer.stage(transferStage)]);
  // Leave a REAL owner/native-authorized recovery upload unfinished in the
  // old role. Its key-envelope row is a separate private staged copy.
  const uploadHeader={newMembership:next,authorization,currentLease:bridge,originalCurrentLease:native.originalLease,sourceManifest:{...manifest,entries:[]}};
  const uploadPlan={kind:'recovery' as const,transferId:graphRecoveryUploadId(uploadHeader),requestHash:canonicalHash({authorization,manifest,rewraps}),header:uploadHeader,counts:{entry:manifest.entries.length,revalidation:0,receipt:next.members.length,'historical-rewrap':2},hasHistoricalRewraps:true};
  old.beginRecoveryUpload('echo',uploadPlan);old.putRecoveryUpload('echo',uploadPlan.transferId,'historical-rewrap',0,rewraps[0]);const unrelatedAck=old.putRecoveryUpload('echo',uploadPlan.transferId,'historical-rewrap',1,rewraps[1]);expect(unrelatedAck.hash).toBe(canonicalHash(rewraps[1]));
  const retirement=old.retireOwnedProfile('echo',{stage,holds,stateTransferReceipts:transfers,...native});
  const oldOperation=old.operation('echo',saved.packet.idempotencyKey)!;
  const directory=path.join(stateDir,'conversation-graph','roles',canonicalHash(next.witnessId));fs.mkdirSync(directory,{recursive:true});
  fs.writeFileSync(path.join(directory,'claim.json'),JSON.stringify({v:1,agentId:'echo',witnessId:next.witnessId,membershipHash:canonicalHash(next),ownerPublicKeyHash:canonicalHash(owner),stageHash:canonicalHash(stage),retirementHash:canonicalHash(retirement),sourceManifestHash:authorization.sourceManifestHash,rewrapInventoryHash}));
  const token='retired-role-test-private-token',successor=new GraphWitnessService({databasePath:path.join(directory,'custody.sqlite'),witnessId:next.witnessId,failureDomain:next.failureDomain,signingPrivateKey:key2.privateKey,ownedHost:{machineId:runtime.machineId,signingPublicKey:next.members[0].signingPublicKey},enrollments:{echo:{ownerPublicKey:owner,bearerToken:token}},historicalWitnessPublicKeys:{[f.membership.witnessId]:pem(f.witness.publicKey)},installedFailureDomains:['actual-owned-test']});witnesses.push(successor);
  const recovery={newMembership:next,authorization,currentLease:bridge,originalCurrentLease:native.originalLease,revalidations:[],stateTransferReceipts:transfers,sourceManifest:manifest,historicalRewraps:rewraps,ownedTransition:{stage,holds,retirement}};
  const bootstrapRaw={recovery,memberships:[f.membership],operations:[{operation:oldOperation,encryptedSourceBundle:saved.encryptedSourceBundle},{operation:old.operation('echo',unrelated.packet.idempotencyKey)!,encryptedSourceBundle:unrelated.encryptedSourceBundle}],erasures:[],previousFenceEpoch:native.lease.leaseEpoch};
  const bootstrapClient=new GraphWitnessClient({agentId:'echo',witnessId:next.witnessId,witnessPublicKey:pem(key2.publicKey),ownerPublicKey:owner,bearerToken:'',expectedFailureDomain:next.failureDomain,historicalWitnessPublicKeys:{[f.membership.witnessId]:pem(f.witness.publicKey)},transport:createStagedGraphCustodyTransport({service:successor,membership:next,ownerPublicKey:owner,bearerToken:token,transition:{stage,holds,retirement}})});
  const activation=(await bootstrapClient.bootstrap({...bootstrapRaw,bootstrapSignature:signGraphRecord('graph-witness-bootstrap-v1',graphWitnessBootstrapPayload(bootstrapRaw),f.owner.privateKey)})).activation;
  authority.stageActivation(stage,activation,holds,retirement);expect(authority.currentMembership()).toEqual(f.membership);expect(()=>authority.assertPositiveWrites(f.membership)).toThrow();
  old.close();witnesses.splice(witnesses.indexOf(old),1); // helper receives NO old role signing key.
  const target=saved.packet.erasureIdentity,fence=new ConversationGraphLocalErasureFence(stateDir);await fence.deny(target);
  const ingress=signGraphErasureIngress({v:1,agentId:'echo',requestId:'erase-retired-role-01',target,principalKey:'owner:echo',authenticationMethod:'owner-device',acceptedBy:runtime.machineId,membershipEpoch:2,membershipHash:canonicalHash(next),acceptedAt:new Date().toISOString()},managers[0].loadSigningKey());
  const helper=new GraphCustodyRetiredRoles({stateDir,identity:managers[0],authority});
  rejectForgedNative(helper,target,ingress,fence);
  const oldFile=path.join(stateDir,'conversation-graph','custody.sqlite'),inspect=()=>{const db=new Database(oldFile,{readonly:true});try{return(db.prepare('SELECT COUNT(*) AS n FROM bundles WHERE ciphertext IS NOT NULL').get() as {n:number}).n;}finally{db.close();}};
  expect(inspect()).toBeGreaterThan(0);
  const stagedDb=new Database(oldFile,{readonly:true});try{expect((stagedDb.prepare("SELECT COUNT(*) AS n FROM witnessTransferRows WHERE section='historical-rewrap' AND body!='null'").get() as {n:number}).n).toBeGreaterThan(0);}finally{stagedDb.close();}
  const replay=path.join(managers[1].baseDir,'retired-before-purge.sqlite');fs.copyFileSync(oldFile,replay);
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
  expect(helper.purge(target,{ingress,fence}).purgeInventoryHash).toMatch(/^[a-f0-9]{64}$/);
  for(const file of [oldFile,path.join(directory,'custody.sqlite')]){const db=new Database(file,{readonly:true});try{expect((db.prepare('SELECT ciphertext FROM bundles WHERE hash=?').get(unrelated.packet.sourceBundleHash) as {ciphertext:string}).ciphertext).not.toBeNull();}finally{db.close();}}
  const db=new Database(oldFile,{readonly:true});try{const retained=db.prepare("SELECT hash,body FROM witnessTransferRows WHERE transferId=? AND section='historical-rewrap' AND rowIndex=1").get(uploadPlan.transferId) as {hash:string;body:string};expect(retained.hash).toBe(unrelatedAck.hash);expect(JSON.parse(retained.body)).toEqual(rewraps[1]);}finally{db.close();}
  expect(runtime.source.repairRecord(unrelated.packet.eventId)!.encryptedSourceBundle).toBeTruthy();
 });
});
