import {signGraphErasureIngress} from '../../src/core/GraphErasureProtocol.js';
import {createGraphControlCapsule} from '../../src/core/GraphWitnessControl.js';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach,describe,expect,it} from 'vitest';
import {SafeFsExecutor} from '../../src/core/SafeFsExecutor.js';
import {ConversationGraphReplication} from '../../src/core/ConversationGraphReplication.js';
import {ConversationGraphReplicationTransfer,buildGraphRecoverySourceManifest,type GraphSourceTransferStage} from '../../src/core/ConversationGraphReplicationTransfer.js';
import {rewrapGraphBundle} from '../../src/core/GraphWitnessCrypto.js';
import {canonicalHash,graphRewrapInventoryHash,signGraphRecord,GRAPH_SIGNATURE_DOMAINS as D,witnessActionPayload,verifyMembershipTransferReceipt} from '../../src/core/GraphWitnessTypes.js';
import {GraphWitnessClient,type GraphWitnessClientOptions} from '../../src/core/GraphWitnessClient.js';
import {createGraphWitnessServer} from '../../src/server/graphWitnessServer.js';
import {ReplicatedStoreReader} from '../../src/core/ReplicatedStoreReader.js';
import {ReplicatedKindRegistry} from '../../src/core/ReplicatedRecordEnvelope.js';
import {DroppedOriginRegistry} from '../../src/core/RollbackUnmerge.js';
import {ConflictStore} from '../../src/core/ConflictStore.js';
import {registerConversationGraphReplication} from '../../src/core/ConversationGraphReplication.js';
import {GraphWitnessService,graphRecoveryUploadId,graphWitnessBootstrapPayload} from '../../src/core/GraphWitnessService.js';
import {replicationFixture} from '../unit/conversation-graph-replication.fixtures.js';
const dirs:string[]=[];
async function directory(){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'graph-transfer-'));dirs.push(dir);return dir;}
afterEach(()=>{for(const dir of dirs.splice(0))SafeFsExecutor.safeRmSync(dir,{recursive:true,force:true,operation:'graph-transfer-test:teardown'});});
async function fixture(replacement=false,certified=false){
 const f=replicationFixture();const record=f.record();const witnessOptions={databasePath:path.join(await directory(),'witness.sqlite'),witnessId:f.membership.witnessId,failureDomain:f.membership.failureDomain,signingPrivateKey:f.witness.privateKey,enrollments:{echo:{ownerPublicKey:f.owner.publicKey.export({type:'spki',format:'pem'}).toString(),bearerToken:'test-bearer-credential-at-least-32-chars'}},installedFailureDomains:['installed-fleet'],now:()=>Date.parse('2026-11-05T08:07:00Z')};const witness=new GraphWitnessService(witnessOptions);witness.registerMembership(f.membership);
 record.preparationProof=witness.prepare({packet:record.packet,controlCapsule:createGraphControlCapsule(record.coreType,record.core,record.authorizationProof),packetSignature:record.packetSignature,encryptedSourceBundle:record.encryptedSourceBundle!,lease:f.lease,originalLease:f.originalLease});
 if(certified){const writer=await ConversationGraphReplication.open(f.options(await directory())),peer=await ConversationGraphReplication.open(f.options(await directory(),'sleeper'));
  const own=await writer.appendLocal(record),remote=await peer.receive(record,'writer');const certificate=witness.commit('echo',record.packet.idempotencyKey,f.lease,f.originalLease,[own.receipt,remote]);
  const acks=await Promise.all([writer.attachCertificate(record.packet.eventId,certificate),peer.attachCertificate(record.packet.eventId,certificate)]);
  for(const ack of acks){witness.acknowledgeCertificate('echo',record.packet.idempotencyKey,ack);await writer.recordCertificateReceipt(record.packet.eventId,ack);await peer.recordCertificateReceipt(record.packet.eventId,ack);}
  record.certificate=certificate;record.certificatePersistenceReceipts=acks.sort((a,b)=>a.machineId<b.machineId?-1:a.machineId>b.machineId?1:0);
 }

 const added={signing:crypto.generateKeyPairSync('ed25519'),sealing:crypto.generateKeyPairSync('x25519')};
 const raw={...f.membership,epoch:2,previousMembershipHash:canonicalHash(f.membership),writerId:'sleeper',members:[f.membership.members[1],
  {machineId:'added',signingPublicKey:added.signing.publicKey.export({type:'spki',format:'pem'}).toString(),sealingPublicKey:added.sealing.publicKey.export({type:'spki',format:'pem'}).toString()}]};
 delete (raw as Partial<typeof raw>).signature;
 if(replacement){raw.witnessId='replacement-witness';raw.failureDomain='replacement-managed-external';}
 const next={...raw,signature:signGraphRecord(D.membership,raw,f.owner.privateKey)};
 const native=f.actuation('sleeper',2);const {signature,...leaseRaw}=native.lease;const bridge={...leaseRaw,membershipEpoch:2};
 const lease={...bridge,signature:signGraphRecord(D.lease,bridge,f.members[1].signing.privateKey)};
 const rewrap=rewrapGraphBundle(record.encryptedSourceBundle!,'sleeper',f.members[1].sealing.privateKey,next,'sleeper',f.members[1].signing.privateKey,{agentId:'echo',eventId:record.packet.eventId},'2026-11-05T08:07:00Z');
 const {packet,packetSignature,core,authorizationProof}=record;
 const proofRaw={v:1 as const,agentId:'echo',idempotencyKey:packet.idempotencyKey,operationHash:canonicalHash(packet),coreHash:packet.coreHash,
  sourceProofHash:canonicalHash({coreType:record.coreType,packet,packetSignature,core,authorizationProof}),subjectHeadsHash:canonicalHash([]),dependenciesHash:canonicalHash([]),rewrapHash:canonicalHash(rewrap),
  newMembershipHash:canonicalHash(next),currentLeaseHash:canonicalHash(lease),writerId:'sleeper',decision:'adopt' as const,reason:'ok' as const,validatedAt:'2026-11-05T08:07:00Z'};
 const proof={...proofRaw,signature:signGraphRecord(D.revalidation,proofRaw,f.members[1].signing.privateKey)};
 const manifest=buildGraphRecoverySourceManifest([record],f.membership);
 const authRaw={v:1 as const,agentId:'echo',recoveryId:'recovery-one',previousMembershipHash:canonicalHash(f.membership),newMembershipHash:canonicalHash(next),previousWitnessId:f.membership.witnessId,newWitnessId:next.witnessId,
  fenceEpoch:2,highestCertifiedSequence:certified?1:0,highestCertifiedCoreHash:certified?record.packet.coreHash:null,pendingOutcomes:certified?[]:[{idempotencyKey:packet.idempotencyKey,operationHash:canonicalHash(packet),decision:'adopt' as const,revalidationHash:canonicalHash(proof)}],
  sourceManifestHash:canonicalHash(manifest),rewrapInventoryHash:graphRewrapInventoryHash([{eventId:packet.eventId,rewrapHash:canonicalHash(rewrap)}]),issuedAt:'2026-11-05T08:07:00Z'};
 const authorization={...authRaw,signature:signGraphRecord(D.recovery,authRaw,f.owner.privateKey)};
 const stage:GraphSourceTransferStage={authorization,previousMembership:f.membership,newMembership:next,currentLease:lease,originalCurrentLease:native.originalLease,manifest,records:[record],revalidations:certified?[]:[proof],rewraps:[{eventId:packet.eventId,rewrap}]};
 const verification=await ConversationGraphReplication.open(f.options(await directory()));const dir=await directory();
 const options={directory:dir,machineId:'added',memberPrivateKey:added.signing.privateKey,memberSealingPrivateKey:added.sealing.privateKey,ownerPublicKey:f.owner.publicKey,verification,witnessPublicKeys:new Map([[f.membership.witnessId,f.witness.publicKey]])};
 return {f,stage,options,dir,verification,witness,added,witnessOptions};
}
describe('witness membership activation over real source staging',()=>{
 it('requires every new member durable source transfer before owner-authorized activation',async()=>{
  const {f,stage,options,verification,witness}=await fixture();
  try {
   const addedReceipt=await new ConversationGraphReplicationTransfer(options).stage(stage);
   const survivorReceipt=await new ConversationGraphReplicationTransfer({...options,directory:await directory(),machineId:'sleeper',memberPrivateKey:f.members[1].signing.privateKey,memberSealingPrivateKey:f.members[1].sealing.privateKey}).stage(stage);
   const request={newMembership:stage.newMembership,authorization:stage.authorization,currentLease:stage.currentLease,originalCurrentLease:stage.originalCurrentLease,
    revalidations:[{proof:stage.revalidations[0],rewrap:stage.rewraps[0].rewrap}],stateTransferReceipts:[addedReceipt],sourceManifest:stage.manifest};
   expect(()=>witness.recoverPending('echo',request)).toThrow('all-member-state-transfer-required');
   expect(witness.inventory('echo','a'.repeat(43)).membershipEpoch).toBe(1);
   request.stateTransferReceipts.push(survivorReceipt);
   const response=witness.recoverPending('echo',request);
   expect(response.adoptions[0].disposition).toBe('adopted');
   expect(response.adoptions[0].operationHash).toBe(canonicalHash(stage.records[0].packet));
   expect(witness.recoverPending('echo',request)).toEqual(response);
   expect(witness.inventory('echo','b'.repeat(43)).membershipEpoch).toBe(2);
   expect(()=>witness.prepare({packet:stage.records[0].packet,packetSignature:stage.records[0].packetSignature,encryptedSourceBundle:stage.records[0].encryptedSourceBundle!,lease:f.lease,originalLease:f.originalLease})).toThrow();
  } finally {witness.close();}
 });
 it('durably resumes bounded recovery upload over actual HTTP and rejects incomplete or changed chunks before activation',async()=>{
  const {f,stage,options,witness,witnessOptions}=await fixture();
  const receipts=[await new ConversationGraphReplicationTransfer(options).stage(stage),await new ConversationGraphReplicationTransfer({...options,directory:await directory(),machineId:'sleeper',memberPrivateKey:f.members[1].signing.privateKey,memberSealingPrivateKey:f.members[1].sealing.privateKey}).stage(stage)];
  const request={newMembership:stage.newMembership,authorization:stage.authorization,currentLease:stage.currentLease,originalCurrentLease:stage.originalCurrentLease,revalidations:[{proof:stage.revalidations[0],rewrap:stage.rewraps[0].rewrap}],stateTransferReceipts:receipts,sourceManifest:stage.manifest};
  const {revalidations,stateTransferReceipts,sourceManifest,...header}=request;
  const transferId=graphRecoveryUploadId(request),plan={kind:'recovery' as const,transferId,requestHash:canonicalHash(request),header:{...header,sourceManifest:{...sourceManifest,entries:[]}},hasHistoricalRewraps:false,counts:{entry:sourceManifest.entries.length,revalidation:1,receipt:2,'historical-rewrap':0}};
  witness.close();let runtime=createGraphWitnessServer(witnessOptions),server=runtime.app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
  const post=async(route:string,body:unknown)=>fetch(`http://127.0.0.1:${(server.address() as {port:number}).port}/v1/agents/echo${route}`,{method:'POST',headers:{authorization:`Bearer ${witnessOptions.enrollments.echo.bearerToken}`,'content-type':'application/json'},body:JSON.stringify(body)});
  const close=async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));runtime.service.close();};
  const client=()=>new GraphWitnessClient({baseUrl:`http://127.0.0.1:${(server.address() as {port:number}).port}`,agentId:'echo',bearerToken:witnessOptions.enrollments.echo.bearerToken,witnessId:f.membership.witnessId,witnessPublicKey:f.witness.publicKey.export({type:'spki',format:'pem'}).toString(),ownerPublicKey:witnessOptions.enrollments.echo.ownerPublicKey,expectedFailureDomain:f.membership.failureDomain,allowLoopbackHttpForTests:true});
  try{
   expect((await post('/recovery-uploads',plan)).ok).toBe(true);
   expect((await post(`/recovery-uploads/${transferId}/finish`,{})).status).toBe(409);
   expect((await post(`/recovery-uploads/${transferId}/chunks/entry/0`,{value:sourceManifest.entries[0]})).ok).toBe(true);
   expect((await post(`/recovery-uploads/${transferId}/chunks/entry/0`,{value:{...sourceManifest.entries[0],coreHash:'0'.repeat(64)}})).ok).toBe(false);
   expect(runtime.service.membershipProof('echo',1)).toEqual(f.membership);expect(()=>runtime.service.membershipProof('echo',2)).toThrow();
   await close();runtime=createGraphWitnessServer(witnessOptions);server=runtime.app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
   const completed=await client().recoverPending(request);expect(completed.adoptions[0].disposition).toBe('adopted');
   await close();runtime=createGraphWitnessServer(witnessOptions);server=runtime.app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
   expect(await client().recoverPending(request)).toEqual(completed);expect(runtime.service.membershipProof('echo',2)).toEqual(stage.newMembership);
  }finally{await close();}
 });
 it('bootstraps replacement only from pinned historical witness proofs and exact owner-signed source transfer',async()=>{
  const {f,stage,options,witness,added}=await fixture(true);
  const replacementKey=crypto.generateKeyPairSync('ed25519');
  const replacementOptions={databasePath:path.join(await directory(),'replacement.sqlite'),witnessId:stage.newMembership.witnessId,failureDomain:stage.newMembership.failureDomain,signingPrivateKey:replacementKey.privateKey,
   enrollments:{echo:{ownerPublicKey:f.owner.publicKey.export({type:'spki',format:'pem'}).toString(),bearerToken:'replacement-bearer-credential-at-least-32'}},installedFailureDomains:['installed-fleet'],historicalWitnessPublicKeys:{[f.membership.witnessId]:f.witness.publicKey.export({type:'spki',format:'pem'}).toString()},now:()=>Date.parse('2026-11-05T08:07:00Z')};
  let replacement=new GraphWitnessService(replacementOptions);
  try {
   const addedReceipt=await new ConversationGraphReplicationTransfer(options).stage(stage);
   const survivorReceipt=await new ConversationGraphReplicationTransfer({...options,directory:await directory(),machineId:'sleeper',memberPrivateKey:f.members[1].signing.privateKey,memberSealingPrivateKey:f.members[1].sealing.privateKey}).stage(stage);
   const recovery={newMembership:stage.newMembership,authorization:stage.authorization,currentLease:stage.currentLease,originalCurrentLease:stage.originalCurrentLease,
    revalidations:[{proof:stage.revalidations[0],rewrap:stage.rewraps[0].rewrap}],stateTransferReceipts:[addedReceipt,survivorReceipt],sourceManifest:stage.manifest};
   const raw={recovery,memberships:[f.membership],operations:[{operation:witness.operation('echo',stage.records[0].packet.idempotencyKey)!,encryptedSourceBundle:stage.records[0].encryptedSourceBundle}],erasures:[],previousFenceEpoch:1};
   const request={...raw,bootstrapSignature:signGraphRecord('graph-witness-bootstrap-v1',graphWitnessBootstrapPayload(raw),f.owner.privateKey)};
   expect(()=>replacement.bootstrap('echo',{...request,previousFenceEpoch:2})).toThrow('bootstrap-owner-proof-invalid');
   const corrupted=structuredClone(request);corrupted.operations[0].operation.packet.coreHash='0'.repeat(64);corrupted.bootstrapSignature=signGraphRecord('graph-witness-bootstrap-v1',graphWitnessBootstrapPayload(corrupted),f.owner.privateKey);
   expect(()=>replacement.bootstrap('echo',corrupted)).toThrow('bootstrap-control-invalid');
   const response=replacement.bootstrap('echo',request);
   expect(response.activation.newMembership.witnessId).toBe('replacement-witness');
   expect(replacement.recover('echo',stage.records[0].packet.idempotencyKey).encryptedSourceBundle).toEqual(stage.records[0].encryptedSourceBundle);
   expect(replacement.inventory('echo','z'.repeat(43)).fenceEpoch).toBe(2);
   expect(replacement.bootstrap('echo',request)).toEqual(response);
   const witnessPublicKeys=new Map([[f.membership.witnessId,f.witness.publicKey],[stage.newMembership.witnessId,replacementKey.publicKey]]);
   const survivorStore=await ConversationGraphReplication.open({...f.options(await directory(),'sleeper'),installedMembership:stage.newMembership,witnessPublicKeys});
   const addedStore=await ConversationGraphReplication.open({...f.options(await directory()),machineId:'added',memberPrivateKey:added.signing.privateKey,memberSealingPrivateKey:added.sealing.privateKey,installedMembership:stage.newMembership,witnessPublicKeys});
   const adopted={...stage.records[0],adoption:response.adoptions[0],rewrap:stage.rewraps[0].rewrap};
   const sourceReceipts=await Promise.all([survivorStore.receive(adopted,'writer'),addedStore.receive(adopted,'writer')]);
   const cert=replacement.commit('echo',adopted.packet.idempotencyKey,stage.currentLease,stage.originalCurrentLease,sourceReceipts);
   const acks=await Promise.all([survivorStore.attachCertificate(adopted.packet.eventId,cert),addedStore.attachCertificate(adopted.packet.eventId,cert)]);
   for(const ack of acks){replacement.acknowledgeCertificate('echo',adopted.packet.idempotencyKey,ack);await survivorStore.recordCertificateReceipt(adopted.packet.eventId,ack);await addedStore.recordCertificateReceipt(adopted.packet.eventId,ack);}
   expect(survivorStore.status(adopted.packet.eventId).state).toBe('committed');expect(addedStore.status(adopted.packet.eventId).state).toBe('committed');
   replacement.close();replacement=new GraphWitnessService(replacementOptions);
   expect(replacement.bootstrap('echo',request)).toEqual(response);
   expect(replacement.inventory('echo','r'.repeat(43)).manifest.highestAcknowledgedSequence).toBe(1);
   expect(replacement.operation('echo',adopted.packet.idempotencyKey)?.certificate).toEqual(cert);

  }finally{witness.close();replacement.close();}
 });

 it('certifies exact historical envelopes, refuses A/B substitution, and restores old certified history on a new member after restart',async()=>{
  const {f,stage,options,witness,added}=await fixture(true,true);const key=crypto.generateKeyPairSync('ed25519');
  const oldIngress=signGraphErasureIngress({v:1,agentId:'echo',requestId:'retired-copy-erasure-debt',target:{sourceKind:'header',sourceId:'hdr-1111111111111111'},principalKey:'owner',authenticationMethod:'owner-dashboard',acceptedBy:'writer',membershipEpoch:1,membershipHash:canonicalHash(f.membership),acceptedAt:'2026-11-05T08:06:00.000Z'},f.members[0].signing.privateKey);
  const oldFields={requestId:oldIngress.requestId,target:oldIngress.target,bundleHashes:[],authorizationReceiptHash:canonicalHash(oldIngress)};
  const oldDebt=witness.beginFleetErasure('echo',oldIngress,[],f.lease,f.originalLease,signGraphRecord(D.action,witnessActionPayload('erase',oldFields,f.lease),f.members[0].signing.privateKey));

  const config={databasePath:path.join(await directory(),'historical-witness.sqlite'),witnessId:stage.newMembership.witnessId,failureDomain:stage.newMembership.failureDomain,signingPrivateKey:key.privateKey,
   enrollments:{echo:{ownerPublicKey:f.owner.publicKey.export({type:'spki',format:'pem'}).toString(),bearerToken:'historical-witness-transport-key'}},installedFailureDomains:['installed-fleet'],historicalWitnessPublicKeys:{[f.membership.witnessId]:f.witness.publicKey.export({type:'spki',format:'pem'}).toString()},now:()=>Date.parse('2026-11-05T08:07:00Z')};
  let runtime=createGraphWitnessServer(config),server=runtime.app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
  const client=()=>new GraphWitnessClient({baseUrl:`http://127.0.0.1:${(server.address() as {port:number}).port}`,agentId:'echo',bearerToken:config.enrollments.echo.bearerToken,witnessId:config.witnessId,witnessPublicKey:key.publicKey.export({type:'spki',format:'pem'}).toString(),ownerPublicKey:config.enrollments.echo.ownerPublicKey,expectedFailureDomain:config.failureDomain,historicalWitnessPublicKeys:config.historicalWitnessPublicKeys,allowLoopbackHttpForTests:true});
  try{
   expect(options.verification.historicalTerminalProof(stage.records[0].packet.eventId)).toBeNull();
   const receipts=[await new ConversationGraphReplicationTransfer(options).stage(stage),await new ConversationGraphReplicationTransfer({...options,directory:await directory(),machineId:'sleeper',memberPrivateKey:f.members[1].signing.privateKey,memberSealingPrivateKey:f.members[1].sealing.privateKey}).stage(stage)];
   const recovery={newMembership:stage.newMembership,authorization:stage.authorization,currentLease:stage.currentLease,originalCurrentLease:stage.originalCurrentLease,revalidations:[],stateTransferReceipts:receipts,sourceManifest:stage.manifest,historicalRewraps:stage.rewraps};
   const raw={recovery,memberships:[f.membership],operations:[{operation:witness.operation('echo',stage.records[0].packet.idempotencyKey)!,encryptedSourceBundle:stage.records[0].encryptedSourceBundle}],erasures:[oldDebt.proof],previousFenceEpoch:1};
   const request={...raw,bootstrapSignature:signGraphRecord('graph-witness-bootstrap-v1',graphWitnessBootstrapPayload(raw),f.owner.privateKey)};
   const swapped=structuredClone(request);swapped.recovery.historicalRewraps=[{eventId:stage.records[0].packet.eventId,rewrap:rewrapGraphBundle(stage.records[0].encryptedSourceBundle!,'sleeper',f.members[1].sealing.privateKey,stage.newMembership,'sleeper',f.members[1].signing.privateKey,stage.records[0].packet,'2026-11-05T08:07:00Z')}];
   swapped.bootstrapSignature=signGraphRecord('graph-witness-bootstrap-v1',graphWitnessBootstrapPayload(swapped),f.owner.privateKey);
   await expect(client().bootstrap(swapped)).rejects.toThrow('recovery-rewrap-inventory-mismatch');expect(()=>runtime.service.membershipProof('echo',2)).toThrow();
   const result=await client().bootstrap(request);expect(result.adoptions).toEqual([]);
   const carriedDebt=await client().fleetErasureStatus(oldIngress.requestId);expect(carriedDebt.ingress).toBeNull();expect(carriedDebt.plan.requiredRecipients.map(member=>member.machineId).sort()).toEqual(['added','sleeper','writer']);expect(carriedDebt.receipts).toEqual([]);expect(carriedDebt.proof).toEqual(oldDebt.proof);

   await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));runtime.service.close();runtime=createGraphWitnessServer(config);server=runtime.app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
   const recovered=await client().recover(stage.records[0].packet.idempotencyKey);expect(recovered.materialization).not.toBeNull();expect(recovered.operation.rewrap).toEqual(stage.rewraps[0].rewrap);expect(JSON.stringify(recovered.operation.materialization)).not.toContain('envelopes');
   const sourceDirectory=await directory();const sourceOptions={...f.options(sourceDirectory),machineId:'added',memberPrivateKey:added.signing.privateKey,memberSealingPrivateKey:added.sealing.privateKey,witnessPublicKeys:new Map([[f.membership.witnessId,f.witness.publicKey],[config.witnessId,key.publicKey]]),installedMembership:stage.newMembership};
   let source=await ConversationGraphReplication.open(sourceOptions);
   const restore={packet:recovered.operation.packet,controlCapsule:recovered.operation.controlCapsule,packetSignature:recovered.operation.packetSignature,encryptedSourceBundle:recovered.encryptedSourceBundle!,preparationProof:recovered.operation.prepareProof,certificate:recovered.operation.certificate!,certificatePersistenceReceipts:recovered.operation.certificatePersistenceReceipts,rewrap:recovered.operation.rewrap!,materialization:recovered.materialization!};
   expect(await source.reconstructFromWitness(restore,await client().membership(restore.packet.membershipEpoch))).toBeNull();
   source=await ConversationGraphReplication.open(sourceOptions);expect(source.status(restore.packet.eventId).state).toBe('committed');expect((await fs.readdir(sourceDirectory)).some(name=>name.endsWith('.receipt.json'))).toBe(false);
   const terminalProof={state:'committed',activationHash:canonicalHash(result.activation),manifestHash:canonicalHash(stage.manifest)};expect(source.historicalTerminalProof(restore.packet.eventId)).toEqual(terminalProof);expect(source.allCommitProofDelivered(restore.packet.eventId)).toBe(false);expect(await source.verifyDurableHistoricalImport(restore.packet.eventId,canonicalHash(result.activation),canonicalHash(stage.manifest))).toMatch(/^[a-f0-9]{64}$/);
   const badHistory=source.repairRecord(restore.packet.eventId)!;await expect(source.receiveHistorical({...badHistory,materialization:{...badHistory.materialization!,rewrapHash:'0'.repeat(64)}})).rejects.toThrow();expect(source.historicalTerminalProof(restore.packet.eventId)).toEqual(terminalProof);
   const registry=new ReplicatedKindRegistry();registerConversationGraphReplication(registry);const dropped=new DroppedOriginRegistry({stateDir:sourceDirectory});
   const reader=new ReplicatedStoreReader({registry,stores:{conversationGraph:{enabled:true}},tierOf:()=> 'high',droppedOrigins:dropped,conflictStore:new ConflictStore({stateDir:sourceDirectory}),listRecordKeys:()=>source.originRecords().map(row=>row.envelope.recordKey),loadOriginRecords:(_store,eventId)=>source.originRecords().filter(row=>row.envelope.recordKey===eventId)});
   expect(source.certifiedUnion(reader,dropped).records.map(record=>record.packet.eventId)).toEqual([restore.packet.eventId]);
   // A new witness may custody an older original packet without becoming its signer.
   const frozenOld=f.record('erased-old-owner-packet',2,restore.packet.coreHash),priority={requestId:'erase-old-packet-before-prepare',target:frozenOld.packet.erasureIdentity,bundleHashes:[],authorizationReceiptHash:canonicalHash({owner:'forget-pending'})};
   await client().erase(priority.requestId,priority.target,[],priority.authorizationReceiptHash,stage.currentLease,stage.originalCurrentLease,signGraphRecord(D.action,witnessActionPayload('erase',priority,stage.currentLease),f.members[1].signing.privateKey));
   const bridge=await client().admitErasedControl({packet:frozenOld.packet,packetSignature:frozenOld.packetSignature,controlCapsule:createGraphControlCapsule(frozenOld.coreType,frozenOld.core,frozenOld.authorizationProof),lease:stage.currentLease,originalLease:stage.originalCurrentLease});
   expect(bridge.prepareProof).toBeNull();expect(bridge.erasedControlProof).toMatchObject({membershipEpoch:1,custodyMembershipEpoch:2,witnessId:config.witnessId});expect((await client().recover(frozenOld.packet.idempotencyKey)).encryptedSourceBundle).toBeNull();
   const fields={requestId:'erase-transferred-history',target:restore.packet.erasureIdentity,bundleHashes:[restore.packet.sourceBundleHash],authorizationReceiptHash:canonicalHash({owner:'forget-history'})};
   const erasure=await client().erase(fields.requestId,fields.target,fields.bundleHashes,fields.authorizationReceiptHash,stage.currentLease,stage.originalCurrentLease,signGraphRecord(D.action,witnessActionPayload('erase',fields,stage.currentLease),f.members[1].signing.privateKey));
   expect((await client().checkpointErasure(fields.requestId)).walPurged).toBe(true);
   const forgotten=await client().recover(restore.packet.idempotencyKey);expect(forgotten.operation.rewrap).toBeNull();expect(forgotten.encryptedSourceBundle).toBeNull();expect(forgotten.materialization?.rewrapHash).toBe(recovered.materialization!.rewrapHash);
   const bytes=await fs.readFile(config.databasePath);for(const envelope of [...stage.rewraps[0].rewrap.envelopes,...swapped.recovery.historicalRewraps[0].rewrap.envelopes,...stage.records[0].encryptedSourceBundle!.envelopes])expect(bytes.includes(Buffer.from(envelope.ciphertext))).toBe(false);
   await source.applyErasure(erasure,await client().erasureAuthority(erasure));source=await ConversationGraphReplication.open(sourceOptions);expect(()=>source.openVerifiedPayload(source.repairRecord(restore.packet.eventId)!)).toThrow('erased');

  }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));runtime.service.close();witness.close();}
 });

 it('preserves actual ACT and recovery-context archives across a second witness replacement without dropping original certificate or ciphertext custody',async()=>{
  const x=await fixture(true,true),{f,stage,witness,options,added}=x,servers:Array<ReturnType<ReturnType<typeof createGraphWitnessServer>['app']['listen']>>=[],services:GraphWitnessService[]=[];
  const keys=[crypto.generateKeyPairSync('ed25519'),crypto.generateKeyPairSync('ed25519')];
  async function host(index:number,membership:typeof f.membership){const config={databasePath:path.join(await directory(),`archive-${index}.sqlite`),witnessId:membership.witnessId,failureDomain:membership.failureDomain,signingPrivateKey:keys[index].privateKey,enrollments:{echo:{ownerPublicKey:f.owner.publicKey.export({type:'spki',format:'pem'}).toString(),bearerToken:'archive-transport-owner-test'}},installedFailureDomains:['installed'],historicalWitnessPublicKeys:{[f.membership.witnessId]:f.witness.publicKey.export({type:'spki',format:'pem'}).toString(),...(index?{[stage.newMembership.witnessId]:keys[0].publicKey.export({type:'spki',format:'pem'}).toString()}:{})},now:()=>Date.parse('2026-11-05T08:07:00Z')};const runtime=createGraphWitnessServer(config),server=runtime.app.listen(0,'127.0.0.1');services.push(runtime.service);servers.push(server);await new Promise<void>(resolve=>server.once('listening',resolve));return {service:runtime.service,client:new GraphWitnessClient({baseUrl:`http://127.0.0.1:${(server.address() as {port:number}).port}`,agentId:'echo',bearerToken:config.enrollments.echo.bearerToken,witnessId:config.witnessId,witnessPublicKey:keys[index].publicKey.export({type:'spki',format:'pem'}).toString(),ownerPublicKey:config.enrollments.echo.ownerPublicKey,expectedFailureDomain:config.failureDomain,historicalWitnessPublicKeys:config.historicalWitnessPublicKeys,allowLoopbackHttpForTests:true})};}
  try{
   const transferReceipts=[await new ConversationGraphReplicationTransfer(options).stage(stage),await new ConversationGraphReplicationTransfer({...options,directory:await directory(),machineId:'sleeper',memberPrivateKey:f.members[1].signing.privateKey,memberSealingPrivateKey:f.members[1].sealing.privateKey}).stage(stage)],recovery={newMembership:stage.newMembership,authorization:stage.authorization,currentLease:stage.currentLease,originalCurrentLease:stage.originalCurrentLease,revalidations:[],stateTransferReceipts:transferReceipts,sourceManifest:stage.manifest,historicalRewraps:stage.rewraps};
   const raw={recovery,memberships:[f.membership],operations:[{operation:witness.operation('echo',stage.records[0].packet.idempotencyKey)!,encryptedSourceBundle:stage.records[0].encryptedSourceBundle}],erasures:[],previousFenceEpoch:1},second=await host(0,stage.newMembership);await second.client.bootstrap({...raw,bootstrapSignature:signGraphRecord('graph-witness-bootstrap-v1',graphWitnessBootstrapPayload(raw),f.owner.privateKey)});
   const got=await second.client.recover(stage.records[0].packet.idempotencyKey),sourceDirectory=await directory(),sourceOptions={...f.options(sourceDirectory),machineId:'added',installedMembership:stage.newMembership,memberPrivateKey:added.signing.privateKey,memberSealingPrivateKey:added.sealing.privateKey,witnessPublicKeys:new Map([[f.membership.witnessId,f.witness.publicKey],[stage.newMembership.witnessId,keys[0].publicKey]])};const source=await ConversationGraphReplication.open(sourceOptions);
   expect(await source.reconstructFromWitness({packet:got.operation.packet,packetSignature:got.operation.packetSignature,controlCapsule:got.operation.controlCapsule,preparationProof:got.operation.prepareProof!,encryptedSourceBundle:got.encryptedSourceBundle!,certificate:got.operation.certificate!,certificatePersistenceReceipts:got.operation.certificatePersistenceReceipts,rewrap:got.operation.rewrap!,materialization:got.materialization!},f.membership)).toBeNull();
   const record=source.repairRecord(got.operation.packet.eventId)!,manifest=buildGraphRecoverySourceManifest([record],stage.newMembership);expect(canonicalHash(manifest)).toBe(canonicalHash(await second.client.recoveryManifest()));
   const mRaw={...stage.newMembership,epoch:3,previousMembershipHash:canonicalHash(stage.newMembership),witnessId:'third-witness',failureDomain:'third-external'};delete (mRaw as Partial<typeof mRaw>).signature;const membership={...mRaw,signature:signGraphRecord(D.membership,mRaw,f.owner.privateKey)},native=f.actuation('sleeper',3),leaseValue={...native.lease,membershipEpoch:3};delete (leaseValue as Partial<typeof leaseValue>).signature;const lease={...leaseValue,signature:signGraphRecord(D.lease,leaseValue,f.members[1].signing.privateKey)};
   const rewrap=rewrapGraphBundle(record.encryptedSourceBundle!,'added',added.sealing.privateKey,membership,'sleeper',f.members[1].signing.privateKey,record.packet,'2026-11-05T08:07:00Z',{rewrap:record.rewrap!,membership:stage.newMembership}),inventory=[{eventId:record.packet.eventId,rewrapHash:canonicalHash(rewrap)}];
   const auth={v:1 as const,agentId:'echo',recoveryId:'second-real-replacement',previousMembershipHash:canonicalHash(stage.newMembership),newMembershipHash:canonicalHash(membership),previousWitnessId:stage.newMembership.witnessId,newWitnessId:membership.witnessId,fenceEpoch:3,highestCertifiedSequence:1,highestCertifiedCoreHash:record.packet.coreHash,pendingOutcomes:[],sourceManifestHash:canonicalHash(manifest),rewrapInventoryHash:graphRewrapInventoryHash(inventory),issuedAt:'2026-11-05T08:07:00Z'},authorization={...auth,signature:signGraphRecord(D.recovery,auth,f.owner.privateKey)},nextStage={authorization,previousMembership:stage.newMembership,newMembership:membership,currentLease:lease,originalCurrentLease:native.originalLease,manifest,records:[record],revalidations:[],rewraps:[{eventId:record.packet.eventId,rewrap}]};
   const common={directory:await directory(),ownerPublicKey:f.owner.publicKey,verification:source,witnessPublicKeys:sourceOptions.witnessPublicKeys};const nextReceipts=[await new ConversationGraphReplicationTransfer({...common,machineId:'added',memberPrivateKey:added.signing.privateKey,memberSealingPrivateKey:added.sealing.privateKey}).stage(nextStage),await new ConversationGraphReplicationTransfer({...common,directory:await directory(),machineId:'sleeper',memberPrivateKey:f.members[1].signing.privateKey,memberSealingPrivateKey:f.members[1].sealing.privateKey}).stage(nextStage)];
   const archive=await second.client.recoveryArchive(),nextRecovery={newMembership:membership,authorization,currentLease:lease,originalCurrentLease:native.originalLease,revalidations:[],stateTransferReceipts:nextReceipts,sourceManifest:manifest,historicalRewraps:nextStage.rewraps},nextRaw={recovery:nextRecovery,memberships:[f.membership,stage.newMembership],operations:[{operation:got.operation,encryptedSourceBundle:got.encryptedSourceBundle}],erasures:[],archive,previousFenceEpoch:2},third=await host(1,membership);
   const {archive:_removed,...missing}=nextRaw;await expect(third.client.bootstrap({...missing,bootstrapSignature:signGraphRecord('graph-witness-bootstrap-v1',graphWitnessBootstrapPayload(missing),f.owner.privateKey)})).rejects.toThrow('bootstrap-activation-archive-incomplete');expect(()=>third.service.membershipProof('echo',3)).toThrow();
   const request={...nextRaw,bootstrapSignature:signGraphRecord('graph-witness-bootstrap-v1',graphWitnessBootstrapPayload(nextRaw),f.owner.privateKey)};await third.client.bootstrap(request);expect(await third.client.activation(2)).toEqual(archive.activations[0]);expect(await third.client.recoveryContext(2)).toEqual(archive.contexts[0]);const restored=await third.client.recover(record.packet.idempotencyKey);expect(restored.operation.certificate).toEqual(record.certificate);expect(restored.materialization?.activation.newMembership.epoch).toBe(3);expect(restored.operation.packetSignature).toBe(record.packetSignature);expect(restored.encryptedSourceBundle).toEqual(record.encryptedSourceBundle);
   const cached=await third.client.recoveryContext(3);expect(Object.isFrozen(cached.manifest.entries[0])).toBe(true);expect(await third.client.recoveryContext(3)).toBe(cached);
   expect(()=>{cached.manifest.entries[0].coreHash='0'.repeat(64);}).toThrow();
   await expect(third.client.historicalMaterialization({...restored.operation,packet:{...restored.operation.packet,agentId:'different-agent'}})).rejects.toThrow('witness-recovery-context-ref-mismatch');
   await expect(third.client.historicalMaterialization({...restored.operation,materialization:{...restored.operation.materialization!,manifestHash:'0'.repeat(64)}})).rejects.toThrow('witness-recovery-context-ref-mismatch');
   const mutableOptions=structuredClone((third.client as unknown as {options:GraphWitnessClientOptions}).options),isolated=new GraphWitnessClient(mutableOptions);await isolated.recoveryContext(3);mutableOptions.ownerPublicKey=keys[0].publicKey.export({type:'spki',format:'pem'}).toString();
   expect(await isolated.recoveryContext(3)).toEqual(cached);await expect(new GraphWitnessClient(mutableOptions).recoveryContext(3)).rejects.toThrow();

  }finally{for(const server of servers)await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));for(const service of services)service.close();witness.close();}
 });

});
