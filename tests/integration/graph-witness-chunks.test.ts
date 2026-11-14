import {createGraphControlCapsule} from '../../src/core/GraphWitnessControl.js';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach,describe,expect,it} from 'vitest';
import {SafeFsExecutor} from '../../src/core/SafeFsExecutor.js';
import {GraphWitnessService,graphWitnessBootstrapPayload,type GraphBootstrapTransferPlan,type GraphWitnessBootstrapRequest} from '../../src/core/GraphWitnessService.js';
import {GraphWitnessClient} from '../../src/core/GraphWitnessClient.js';
import {createGraphWitnessServer} from '../../src/server/graphWitnessServer.js';
import {ConversationGraphReplication} from '../../src/core/ConversationGraphReplication.js';
import {ConversationGraphReplicationTransfer,buildGraphRecoverySourceManifest} from '../../src/core/ConversationGraphReplicationTransfer.js';
import {deriveGraphErasureIdentity} from '../../src/core/ConversationGraphOperation.js';
import {newTitleSalt,titleCommitment} from '../../src/core/EffortHeaderStore.js';
import {signGraphAuthorizationReceipt} from '../../src/core/ConversationGraphReplicationProof.js';
import {encodeGraphSourceEnvelope} from '../../src/core/ConversationGraphSourceEnvelope.js';
import {sealGraphBundle,rewrapGraphBundle} from '../../src/core/GraphWitnessCrypto.js';
import {canonicalJson,graphOperationKey,canonicalHash,graphRewrapInventoryHash,signGraphRecord,unsigned,GRAPH_SIGNATURE_DOMAINS as D,witnessActionPayload} from '../../src/core/GraphWitnessTypes.js';
import {replicationFixture} from '../unit/conversation-graph-replication.fixtures.js';
const dirs:string[]=[];const cleanups:Array<()=>Promise<void>>=[];
async function directory(){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'witness-chunks-'));dirs.push(dir);return dir;}
afterEach(async()=>{for(const close of cleanups.splice(0).reverse())await close();for(const dir of dirs.splice(0))SafeFsExecutor.safeRmSync(dir,{recursive:true,force:true,operation:'witness-chunks-fixture-cleanup'});});
const pem=(key:crypto.KeyObject)=>key.export({type:'spki',format:'pem'}).toString();
async function fixture(erased=false){
 const f=replicationFixture(),auditor=crypto.generateKeyPairSync('ed25519'),witness=new GraphWitnessService({databasePath:path.join(await directory(),'old.sqlite'),witnessId:f.membership.witnessId,failureDomain:f.membership.failureDomain,signingPrivateKey:f.witness.privateKey,enrollments:{echo:{ownerPublicKey:pem(f.owner.publicKey),bearerToken:'old-witness-transport-secret',backupPolicyAuditorPublicKey:pem(auditor.publicKey)}},installedFailureDomains:['installed'],now:()=>Date.parse('2026-11-05T08:07:00Z')});cleanups.push(async()=>witness.close());witness.registerMembership(f.membership);
 const records=[];for(let i=0;i<3;i++){const record=f.record(`large-event-${i}`,i+1,records.at(-1)?.packet.coreHash??null);let application=Buffer.alloc(1024*1024,i+1);
  if(erased){const headerId='hdr-0000000000000001',title=`Private header version ${i}`,salt=newTitleSalt();const eventId=graphOperationKey('header-op',`large-event-${i}`);
   const core={schemaVersion:1,kind:'set-effort-title',opId:`large-event-${i}`,headerId,baseVersion:i,authority:'owner',principal:'owner',receipt:{kind:'owner-proof',id:`receipt-header-${i}`},machineId:'writer',createdAt:'2026-11-05T08:05:00.000Z',titleCommitment:titleCommitment(title,salt),bundleRef:{kind:'header-source-bundle',id:`bundle-header-${i}`}};
   const {signature:_oldSignature,...unsignedReceipt}=record.authorizationProof.receipt;const receipt=signGraphAuthorizationReceipt({...unsignedReceipt,eventId,idempotencyKey:`header-op:large-${i}`,coreHash:canonicalHash(core),receiptId:core.receipt.id},f.members[0].signing.privateKey);
   record.coreType='header-op';record.core=core;record.authorizationProof={...record.authorizationProof,receipt};record.packet={...record.packet,coreType:'header-op',erasureIdentity:deriveGraphErasureIdentity('header-op',core),eventId,idempotencyKey:receipt.idempotencyKey,coreHash:canonicalHash(core),authorizationReceiptHash:canonicalHash(receipt)};
   application.fill(0);application=Buffer.from(canonicalJson({kind:'effort-header-payload',requestId:`header-request-${i}`,requestHash:canonicalHash({i}),headerId,title,salt}));
  }
  record.encryptedSourceBundle=sealGraphBundle(encodeGraphSourceEnvelope(record.coreType,record.core,record.authorizationProof,application),f.membership.members,record.packet);application.fill(0);record.packet.sourceBundleHash=canonicalHash(record.encryptedSourceBundle);record.packet.controlHash=canonicalHash(createGraphControlCapsule(record.coreType,record.core,record.authorizationProof));record.packetSignature=signGraphRecord(D.packet,record.packet,f.members[0].signing.privateKey);record.preparationProof=witness.prepare({packet:record.packet,controlCapsule:createGraphControlCapsule(record.coreType,record.core,record.authorizationProof),packetSignature:record.packetSignature,encryptedSourceBundle:record.encryptedSourceBundle,lease:f.lease,originalLease:f.originalLease});records.push(record);}
 if(erased){for(const [requestId,bundleHashes]of [['erase-a',[records[0].packet.sourceBundleHash]],['erase-b',[records[0].packet.sourceBundleHash,records[1].packet.sourceBundleHash]],['erase-c',[records[0].packet.sourceBundleHash]]] as const){const authorizationReceiptHash=canonicalHash({owner:'forget'});witness.erase('echo',requestId,records[0].packet.erasureIdentity,[...bundleHashes],authorizationReceiptHash,f.lease,f.originalLease,signGraphRecord(D.action,witnessActionPayload('erase',{requestId,target:records[0].packet.erasureIdentity,bundleHashes:[...bundleHashes].sort(),authorizationReceiptHash},f.lease),f.members[0].signing.privateKey));}
  const proof=witness.checkpointErasure('echo','erase-a').proof;const evidence={v:1 as const,agentId:'echo',witnessId:f.membership.witnessId,failureDomain:f.membership.failureDomain,requestId:'erase-a',erasureHash:canonicalHash(proof),policy:'no-retained-copies' as const,providerResourceHash:canonicalHash({fixture:'resource'}),evidenceHash:canonicalHash({fixture:'simulated provider evidence; not production'}),checkedAt:'2026-11-05T08:07:00Z',expiresAt:'2026-11-05T08:08:00Z'};witness.attestBackupErasure('echo',{...evidence,signature:signGraphRecord('graph-backup-erasure-v1',evidence,auditor.privateKey)});
  for(const record of records){const recovered=witness.recover('echo',record.packet.idempotencyKey);if(recovered.erasure){record.erasure=recovered.erasure;record.encryptedSourceBundle=null;}}
 }
 const key=crypto.generateKeyPairSync('ed25519');const nextRaw={...unsigned(f.membership),epoch:2,previousMembershipHash:canonicalHash(f.membership),witnessId:'replacement',failureDomain:'new-managed'};const next={...nextRaw,signature:signGraphRecord(D.membership,nextRaw,f.owner.privateKey)};
 const native=f.actuation('writer',2),leaseRaw={...unsigned(native.lease),membershipEpoch:2};const lease={...leaseRaw,signature:signGraphRecord(D.lease,leaseRaw,f.members[0].signing.privateKey)};
 const revalidations=records.map(record=>{const rewrap=record.erasure?null:rewrapGraphBundle(record.encryptedSourceBundle!,'writer',f.members[0].sealing.privateKey,next,'writer',f.members[0].signing.privateKey,record.packet,'2026-11-05T08:07:00Z');const {packet,packetSignature,core,authorizationProof}=record;
  const raw={v:1 as const,agentId:'echo',idempotencyKey:packet.idempotencyKey,operationHash:canonicalHash(packet),coreHash:packet.coreHash,sourceProofHash:canonicalHash({coreType:record.coreType,packet,packetSignature,core,authorizationProof}),subjectHeadsHash:canonicalHash([]),dependenciesHash:canonicalHash([]),rewrapHash:canonicalHash(rewrap),newMembershipHash:canonicalHash(next),currentLeaseHash:canonicalHash(lease),writerId:'writer',decision:record.erasure?'refuse' as const:'adopt' as const,reason:record.erasure?'erased-source' as const:'ok' as const,validatedAt:'2026-11-05T08:07:00Z'};return {proof:{...raw,signature:signGraphRecord(D.revalidation,raw,f.members[0].signing.privateKey)},rewrap};});
 const sourceManifest=buildGraphRecoverySourceManifest(records,f.membership);const authRaw={v:1 as const,agentId:'echo',recoveryId:'large-replacement',previousMembershipHash:canonicalHash(f.membership),newMembershipHash:canonicalHash(next),previousWitnessId:f.membership.witnessId,newWitnessId:next.witnessId,fenceEpoch:2,highestCertifiedSequence:0,highestCertifiedCoreHash:null,pendingOutcomes:revalidations.map(({proof})=>({idempotencyKey:proof.idempotencyKey,operationHash:proof.operationHash,decision:proof.decision,revalidationHash:canonicalHash(proof)})),sourceManifestHash:canonicalHash(sourceManifest),rewrapInventoryHash:graphRewrapInventoryHash(revalidations.map((item,index)=>({eventId:records[index].packet.eventId,rewrapHash:canonicalHash(item.rewrap)}))),issuedAt:'2026-11-05T08:07:00Z'};const authorization={...authRaw,signature:signGraphRecord(D.recovery,authRaw,f.owner.privateKey)};
 const verification=await ConversationGraphReplication.open(f.options(await directory()));for(const record of records)if(record.erasure)await verification.applyErasure(record.erasure,{membership:f.membership,activations:[],endorsement:witness.erasureEndorsement('echo',record.erasure.requestId,crypto.randomBytes(32).toString('base64url'))});const stage={authorization,previousMembership:f.membership,newMembership:next,currentLease:lease,originalCurrentLease:native.originalLease,manifest:sourceManifest,records,revalidations:revalidations.map(i=>i.proof),rewraps:revalidations.flatMap((item,index)=>item.rewrap?[{eventId:records[index].packet.eventId,rewrap:item.rewrap}]:[])};
 const stateTransferReceipts=[];for(const member of f.members)stateTransferReceipts.push(await new ConversationGraphReplicationTransfer({directory:await directory(),machineId:member.machineId,memberPrivateKey:member.signing.privateKey,memberSealingPrivateKey:member.sealing.privateKey,ownerPublicKey:f.owner.publicKey,verification,witnessPublicKeys:new Map([[f.membership.witnessId,f.witness.publicKey]])}).stage(stage));
 const recovery={newMembership:next,authorization,currentLease:lease,originalCurrentLease:native.originalLease,revalidations,stateTransferReceipts,sourceManifest};const raw={recovery,memberships:[f.membership],operations:records.map(record=>({operation:witness.operation('echo',record.packet.idempotencyKey)!,encryptedSourceBundle:record.encryptedSourceBundle})),erasures:witness.inventory('echo','a'.repeat(43)).erasures,...(erased?{backupAttestations:[witness.checkpointErasure('echo','erase-a').backupAttestation!]}:{}),previousFenceEpoch:1};const request:GraphWitnessBootstrapRequest={...raw,bootstrapSignature:signGraphRecord('graph-witness-bootstrap-v1',graphWitnessBootstrapPayload(raw),f.owner.privateKey)};
 const config={databasePath:path.join(await directory(),'new.sqlite'),witnessId:next.witnessId,failureDomain:next.failureDomain,signingPrivateKey:key.privateKey,enrollments:{echo:{ownerPublicKey:pem(f.owner.publicKey),bearerToken:'replacement-transport-secret'}},installedFailureDomains:['installed'],historicalWitnessPublicKeys:{[f.membership.witnessId]:pem(f.witness.publicKey)},historicalBackupPolicyAuditorPublicKeys:{[f.membership.witnessId]:pem(auditor.publicKey)},now:()=>Date.parse('2026-11-05T08:07:00Z')};
 let runtime:ReturnType<typeof createGraphWitnessServer>;let server:ReturnType<ReturnType<typeof createGraphWitnessServer>['app']['listen']>;let base='';
 async function start(){runtime=createGraphWitnessServer(config);server=runtime.app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;}
 async function stop(){await new Promise<void>((resolve,reject)=>server.close(err=>err?reject(err):resolve()));runtime.service.close();}
 await start();cleanups.push(stop);
 const client=()=>new GraphWitnessClient({baseUrl:base,agentId:'echo',bearerToken:config.enrollments.echo.bearerToken,witnessId:next.witnessId,witnessPublicKey:pem(key.publicKey),ownerPublicKey:pem(f.owner.publicKey),expectedFailureDomain:next.failureDomain,historicalWitnessPublicKeys:config.historicalWitnessPublicKeys,allowLoopbackHttpForTests:true});
 async function post(route:string,body:unknown){return fetch(base+'/v1/agents/echo'+route,{method:'POST',headers:{Authorization:`Bearer ${config.enrollments.echo.bearerToken}`,'Content-Type':'application/json'},body:JSON.stringify(body)});}
 return {f,records,request,config,client,post,restart:async()=>{await stop();await start();},service:()=>runtime.service};
}
describe('bounded witness transfer over actual HTTP',()=>{
 it('resumes verified chunks after restart and atomically bootstraps a history larger than ingress capacity',async()=>{
  const f=await fixture();expect(Buffer.byteLength(JSON.stringify(f.request))).toBeGreaterThan(3*1024*1024);
  expect((await f.post('/bootstrap',f.request)).ok).toBe(false);
  const transferId=canonicalHash({payload:graphWitnessBootstrapPayload(f.request),signature:f.request.bootstrapSignature});
  const plan:GraphBootstrapTransferPlan={transferId,payload:graphWitnessBootstrapPayload(f.request) as GraphBootstrapTransferPlan['payload'],bootstrapSignature:f.request.bootstrapSignature,counts:{control:1,membership:1,operation:3,erasure:0,revalidation:3,receipt:2,entry:3}};
  expect((await f.post('/bootstrap-transfers',{...plan,counts:{...plan.counts,operation:4}})).status).toBe(403);
  expect((await f.post('/bootstrap-transfers',plan)).ok).toBe(true);
  expect((await f.post(`/bootstrap-transfers/${transferId}/chunks/membership/0`,{value:f.request.memberships[0]})).ok).toBe(true);
  const {revalidations,stateTransferReceipts,sourceManifest,...rest}=f.request.recovery;
  expect((await f.post(`/bootstrap-transfers/${transferId}/chunks/control/0`,{value:{...rest,sourceManifest:{...sourceManifest,entries:[]}}})).ok).toBe(true);
  const corrupt=structuredClone(f.request.operations[0]);corrupt.encryptedSourceBundle!.ciphertext='A'+corrupt.encryptedSourceBundle!.ciphertext.slice(1);
  expect((await f.post(`/bootstrap-transfers/${transferId}/chunks/operation/0`,{value:corrupt})).ok).toBe(false);
  expect((await f.post(`/bootstrap-transfers/${transferId}/chunks/operation/0`,{value:f.request.operations[0]})).ok).toBe(true);
  expect((await f.post(`/bootstrap-transfers/${transferId}/finish`,{})).status).toBe(409);
  expect(()=>f.service().membershipProof('echo',2)).toThrow();await f.restart();
  const result=await f.client().bootstrap(f.request);expect(result.adoptions).toHaveLength(3);
  expect((await f.client().inventory('b'.repeat(43))).manifest.entries).toHaveLength(3);
  await f.restart();expect((await f.client().bootstrap(f.request)).activation).toEqual(result.activation);
  const recovered=await f.client().recover(f.records[2].packet.idempotencyKey);expect(recovered.encryptedSourceBundle).toEqual(f.records[2].encryptedSourceBundle);
  const eraseFields={requestId:'erase-after-import',target:f.records[2].packet.erasureIdentity,bundleHashes:[f.records[2].packet.sourceBundleHash],authorizationReceiptHash:canonicalHash({owner:'forget-imported'})};
  const lease=f.request.recovery.currentLease;await f.client().erase(eraseFields.requestId,eraseFields.target,eraseFields.bundleHashes,eraseFields.authorizationReceiptHash,lease,f.request.recovery.originalCurrentLease,signGraphRecord(D.action,witnessActionPayload('erase',eraseFields,lease),f.f.members[0].signing.privateKey));
  expect((await f.client().checkpointErasure(eraseFields.requestId)).walPurged).toBe(true);await f.restart();
  const erased=await f.client().recover(f.records[2].packet.idempotencyKey);expect(erased.encryptedSourceBundle).toBeNull();expect(erased.operation.rewrap).toBeNull();
  await f.client().bootstrap(f.request);expect((await f.client().recover(f.records[2].packet.idempotencyKey)).encryptedSourceBundle).toBeNull();
  for(const name of await fs.readdir(path.dirname(f.config.databasePath))){const bytes=await fs.readFile(path.join(path.dirname(f.config.databasePath),name));for(const e of recovered.operation.rewrap!.envelopes)expect(bytes.includes(Buffer.from(e.ciphertext))).toBe(false);}

  // Activated staging cannot retain original or rewrapped key envelopes.
  const db=new Database(f.config.databasePath,{readonly:true});try{const rows=db.prepare("SELECT body FROM witnessTransferRows WHERE section IN ('operation','revalidation')").all() as {body:string}[];expect(rows.length).toBe(6);expect(rows.every(row=>row.body==='null')).toBe(true);const adoptions=db.prepare('SELECT adoption FROM operations').all() as {adoption:string}[];expect(adoptions.every(row=>!row.adoption.includes('ephemeralPublicKey'))).toBe(true);}finally{db.close();}
 },30000);
 it('preserves overlapping and fully redundant erasure requests and their checkpoint identities through replacement',async()=>{
  const f=await fixture(true);expect(f.request.erasures.map(e=>e.requestId)).toEqual(['erase-a','erase-b','erase-c']);
  await f.client().bootstrap(f.request);await f.restart();const inventory=await f.client().inventory('c'.repeat(43));expect(inventory.erasures.map(e=>e.requestId)).toEqual(['erase-a','erase-b','erase-c']);
  for(const proof of f.request.erasures)expect((await f.client().checkpointErasure(proof.requestId)).proof).toEqual(proof);
  const snapshotClient=f.client();await snapshotClient.inventory('d'.repeat(43));expect(snapshotClient.backupPolicyEvidence()).toEqual(f.request.backupAttestations);expect(f.service().checkpointErasure('echo','erase-a')).toMatchObject({backupAttestation:f.request.backupAttestations![0],externalBackupsVerified:false});
  for(const record of f.records.slice(0,2)){const recovered=await f.client().recover(record.packet.idempotencyKey);expect(recovered.encryptedSourceBundle).toBeNull();expect(recovered.operation.rewrap).toBeNull();}
 },30000);
 it('pages a signed erasure inventory larger than3MB without losing redundant signed request identities',async()=>{
  const f=await fixture(true);await f.client().bootstrap(f.request);const hashes=Array.from({length:256},(_,i)=>canonicalHash({erasedInventoryFixture:i}));
  const {currentLease:lease,originalCurrentLease}=f.request.recovery;const authorizationReceiptHash=canonicalHash({owner:'large-inventory-forget'});
  for(let i=0;i<200;i++){const requestId=`large-erasure-${String(i).padStart(3,'0')}`;f.service().erase('echo',requestId,f.records[0].packet.erasureIdentity,hashes,authorizationReceiptHash,lease,originalCurrentLease,signGraphRecord(D.action,witnessActionPayload('erase',{requestId,target:f.records[0].packet.erasureIdentity,bundleHashes:[...hashes].sort(),authorizationReceiptHash},lease),f.f.members[0].signing.privateKey));}
  expect(Buffer.byteLength(JSON.stringify(f.service().inventory('echo','w'.repeat(43))))).toBeGreaterThan(3*1024*1024);const raw=await f.post('/inventory',{challenge:'x'.repeat(43)});expect(raw.status).toBe(409);
  const checkpoint=await f.client().inventory('y'.repeat(43));expect(checkpoint.erasures).toHaveLength(203);expect(new Set(checkpoint.erasures.map(e=>e.requestId)).size).toBe(203);
 },30000);

 it('requires signed cancellation of durable incomplete staging and never admits an aborted transfer',async()=>{
  const f=await fixture();const payload=graphWitnessBootstrapPayload(f.request) as GraphBootstrapTransferPlan['payload'];const transferId=canonicalHash({payload,signature:f.request.bootstrapSignature});
  const plan:GraphBootstrapTransferPlan={transferId,payload,bootstrapSignature:f.request.bootstrapSignature,counts:{control:1,membership:1,operation:3,erasure:0,revalidation:3,receipt:2,entry:3}};
  expect((await f.post('/bootstrap-transfers',plan)).ok).toBe(true);
  expect((await f.post(`/bootstrap-transfers/${transferId}/chunks/membership/0`,{value:f.request.memberships[0]})).ok).toBe(true);
  expect((await f.post(`/bootstrap-transfers/${transferId}/chunks/operation/0`,{value:f.request.operations[0]})).ok).toBe(true);
  expect((await f.post(`/bootstrap-transfers/${transferId}/abort`,{signature:'invalid'})).ok).toBe(false);
  const signature=signGraphRecord('graph-witness-transfer-abort-v1',{agentId:'echo',transferId},f.f.owner.privateKey);
  expect((await f.post(`/bootstrap-transfers/${transferId}/abort`,{signature})).ok).toBe(true);await f.restart();
  expect((await f.post(`/bootstrap-transfers/${transferId}/finish`,{})).status).toBe(409);
  const db=new Database(f.config.databasePath,{readonly:true});try{const row=db.prepare("SELECT body FROM witnessTransferRows WHERE section='operation'").get() as {body:string};expect(row.body).toBe('null');}finally{db.close();}
  expect(()=>f.service().membershipProof('echo',2)).toThrow();
 });

 it('refuses verified chunks when durable staging capacity is exhausted without publishing membership',async()=>{
  const f=await fixture();Object.assign(f.config,{maxBootstrapStagingBytes:128});
  const payload=graphWitnessBootstrapPayload(f.request) as GraphBootstrapTransferPlan['payload'],transferId=canonicalHash({payload,signature:f.request.bootstrapSignature});
  const plan:GraphBootstrapTransferPlan={transferId,payload,bootstrapSignature:f.request.bootstrapSignature,counts:{control:1,membership:1,operation:3,erasure:0,revalidation:3,receipt:2,entry:3}};
  expect((await f.post('/bootstrap-transfers',plan)).ok).toBe(true);const response=await f.post(`/bootstrap-transfers/${transferId}/chunks/membership/0`,{value:f.request.memberships[0]});expect(response.status).toBe(413);
  expect(()=>f.service().membershipProof('echo',2)).toThrow();const db=new Database(f.config.databasePath,{readonly:true});try{expect((db.prepare('SELECT COUNT(*) AS n FROM witnessTransferRows').get() as {n:number}).n).toBe(0);}finally{db.close();}
 });
 it('bounds temporary signed snapshot slots and fails stale pages without dropping canonical inventory',async()=>{
  const f=await fixture(true);await f.client().bootstrap(f.request);const first=await (await f.post('/inventory-exports',{challenge:'m'.repeat(43)})).json() as {exportId:string};
  const pageBefore=f.service().inventoryPage('echo',first.exportId,0) as {headerHash:string};
  for(let i=0;i<8;i++)await f.client().inventory(crypto.createHash('sha256').update(String(i)).digest('base64url'));
  const pageAfter=f.service().inventoryPage('echo',first.exportId,0) as {headerHash:string};expect(pageAfter.headerHash).not.toBe(pageBefore.headerHash);
  const current=await f.client().inventory('n'.repeat(43));expect(current.manifest.entries).toHaveLength(3);expect(current.erasures).toHaveLength(3);
  const db=new Database(f.config.databasePath,{readonly:true});try{expect((db.prepare('SELECT COUNT(*) AS n FROM witnessExports').get() as {n:number}).n).toBe(8);}finally{db.close();}
 });

 it('removes source keys from a second unfinished transfer after the first activates and erasure completes',async()=>{
  const f=await fixture();const alternate=structuredClone(f.request);
  const auth={...unsigned(alternate.recovery.authorization),recoveryId:'second-legal-recovery-attempt'};
  alternate.recovery.authorization={...auth,signature:signGraphRecord(D.recovery,auth,f.f.owner.privateKey)};
  alternate.recovery.stateTransferReceipts=alternate.recovery.stateTransferReceipts.map(receipt=>{
   const raw={...unsigned(receipt),recoveryId:auth.recoveryId};const member=f.f.members.find(m=>m.machineId===receipt.machineId)!;
   return {...raw,signature:signGraphRecord(D.membershipTransfer,raw,member.signing.privateKey)};
  });
  const raw=unsigned(alternate) as any;delete raw.bootstrapSignature;
  alternate.bootstrapSignature=signGraphRecord('graph-witness-bootstrap-v1',graphWitnessBootstrapPayload(raw),f.f.owner.privateKey);
  const payload=graphWitnessBootstrapPayload(alternate) as GraphBootstrapTransferPlan['payload'];
  const transferId=canonicalHash({payload,signature:alternate.bootstrapSignature});
  const plan:GraphBootstrapTransferPlan={transferId,payload,bootstrapSignature:alternate.bootstrapSignature,counts:{control:1,membership:1,operation:3,erasure:0,revalidation:3,receipt:2,entry:3}};
  expect((await f.post('/bootstrap-transfers',plan)).status).toBe(200);
  expect((await f.post(`/bootstrap-transfers/${transferId}/chunks/membership/0`,{value:alternate.memberships[0]})).status).toBe(200);
  const {revalidations,stateTransferReceipts,sourceManifest,...control}=alternate.recovery;
  expect((await f.post(`/bootstrap-transfers/${transferId}/chunks/control/0`,{value:{...control,sourceManifest:{...sourceManifest,entries:[]}}})).status).toBe(200);
  expect((await f.post(`/bootstrap-transfers/${transferId}/chunks/operation/0`,{value:alternate.operations[0]})).status).toBe(200);
  expect((await f.post(`/bootstrap-transfers/${transferId}/chunks/revalidation/0`,{value:revalidations[0]})).status).toBe(200);
  await f.client().bootstrap(f.request);
  const fields={requestId:'erase-while-other-stage-exists',target:f.records[0].packet.erasureIdentity,bundleHashes:[f.records[0].packet.sourceBundleHash],authorizationReceiptHash:canonicalHash({owner:'forget'})};
  const lease=f.request.recovery.currentLease;
  await f.client().erase(fields.requestId,fields.target,fields.bundleHashes,fields.authorizationReceiptHash,lease,f.request.recovery.originalCurrentLease,signGraphRecord(D.action,witnessActionPayload('erase',fields,lease),f.f.members[0].signing.privateKey));
  expect((await f.client().checkpointErasure(fields.requestId)).walPurged).toBe(true);
  const db=new Database(f.config.databasePath,{readonly:true});
  try{
   const rows=db.prepare("SELECT section,body FROM witnessTransferRows WHERE transferId=? AND section IN ('operation','revalidation')").all(transferId) as {section:string;body:string}[];
   expect(rows.every(row=>row.body==='null')).toBe(true);
   expect((db.prepare('SELECT COUNT(*) AS n FROM witnessTransferStale WHERE transferId=?').get(transferId) as {n:number}).n).toBe(1);
  }finally{db.close();}
  expect((await f.post(`/bootstrap-transfers/${transferId}/chunks/operation/0`,{value:alternate.operations[0]})).status).toBe(409);
  expect((await f.post(`/bootstrap-transfers/${transferId}/chunks/revalidation/0`,{value:revalidations[0]})).status).toBe(409);
  expect((await f.post(`/bootstrap-transfers/${transferId}/finish`,{})).status).toBe(409);
  await f.restart();expect((await f.post(`/bootstrap-transfers/${transferId}/finish`,{})).status).toBe(409);
  expect((await f.client().recover(f.records[0].packet.idempotencyKey)).encryptedSourceBundle).toBeNull();
  const bytes=await fs.readFile(f.config.databasePath);for(const envelope of [...revalidations[0].rewrap!.envelopes,...f.records[0].encryptedSourceBundle!.envelopes])expect(bytes.includes(Buffer.from(envelope.ciphertext))).toBe(false);
 });
});
