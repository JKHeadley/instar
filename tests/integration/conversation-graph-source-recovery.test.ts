/** Cold recovery uses ONLY actual witness HTTP + surviving member keys and
 * pinned public trust. The old writer's files/control/private key are absent
 * from the returned fixture and cannot be used to regenerate accepted proof.
 * Loopback is test evidence, not an external failure-domain attestation. */
import {afterEach,describe,expect,it} from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import type {Server} from 'node:http';
import {replicationFixture} from '../unit/conversation-graph-replication.fixtures.js';
import {createGraphWitnessServer} from '../../src/server/graphWitnessServer.js';
import {createGraphControlCapsule} from '../../src/core/GraphWitnessControl.js';
import {GraphWitnessClient,type GraphWitnessClientOptions} from '../../src/core/GraphWitnessClient.js';
import {ConversationGraphReplication} from '../../src/core/ConversationGraphReplication.js';
import {reconstructGraphSourceRecord,decodeGraphSourceRecoveryEnvelope,type GraphWitnessSourceRecoveryInput} from '../../src/core/ConversationGraphSourceRecovery.js';
import {canonicalHash,canonicalJson,signGraphRecord,witnessActionPayload,type GraphMembershipEpoch,type GraphWitnessLease} from '../../src/core/GraphWitnessTypes.js';
import {validateGraphOperationCore} from '../../src/core/ConversationGraphOperation.js';
import {openGraphBundle} from '../../src/core/GraphWitnessCrypto.js';
import {WriteAdmission} from '../../src/core/WriteAdmission.js';
import {buildWriteDomainRegistry} from '../../src/core/WriteDomainRegistry.js';
import {FencedLease} from '../../src/core/FencedLease.js';
import {sign} from '../../src/core/MachineIdentity.js';
import {SafeFsExecutor} from '../../src/core/SafeFsExecutor.js';
const directories:string[]=[],servers:Server[]=[],cleanups:Array<()=>void>=[];
afterEach(async()=>{for(const s of servers.splice(0))await new Promise<void>(resolve=>s.close(()=>resolve()));for(const c of cleanups.splice(0).reverse())c();for(const dir of directories.splice(0))SafeFsExecutor.safeRmSync(dir,{recursive:true,force:true,operation:'graph-source-cold-recovery-cleanup'});});
async function beforeWriterDisappears(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'graph-cold-source-'));directories.push(dir);
 const f=replicationFixture(),now=Date.parse('2026-11-05T08:07:00Z');
 const {app,service}=createGraphWitnessServer({databasePath:path.join(dir,'independent-witness.sqlite'),witnessId:f.membership.witnessId,failureDomain:f.membership.failureDomain,signingPrivateKey:f.witness.privateKey,
  enrollments:{echo:{ownerPublicKey:f.owner.publicKey.export({type:'spki',format:'pem'}).toString(),bearerToken:'cold-recovery-transport-only-credential'}},installedFailureDomains:['origin','survivor'],now:()=>now});cleanups.push(()=>service.close());
 const server=await new Promise<Server>(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});servers.push(server);const address=server.address();if(!address||typeof address==='string')throw new Error('fixture-address');
 const clientOptions:GraphWitnessClientOptions={baseUrl:`http://127.0.0.1:${address.port}`,agentId:'echo',bearerToken:'cold-recovery-transport-only-credential',witnessId:f.membership.witnessId,
  witnessPublicKey:f.witness.publicKey.export({type:'spki',format:'pem'}).toString(),ownerPublicKey:f.owner.publicKey.export({type:'spki',format:'pem'}).toString(),expectedFailureDomain:f.membership.failureDomain,allowLoopbackHttpForTests:true};
 const client=new GraphWitnessClient(clientOptions);await client.verifyRemote();await client.registerMembership(f.membership);
 const original=f.record('witness-only-cold-source');const origin=path.join(dir,'lost-origin-files');const originOptions=f.options(origin);const source=await ConversationGraphReplication.open(originOptions);
 await source.appendLocal(original);await client.prepare({controlCapsule:createGraphControlCapsule(original.coreType,original.core,original.authorizationProof),packet:original.packet,packetSignature:original.packetSignature,encryptedSourceBundle:original.encryptedSourceBundle!,lease:f.lease,originalLease:f.originalLease});
 originOptions.writeAdmission.stop();SafeFsExecutor.safeRmSync(origin,{recursive:true,force:true,operation:'graph-source-test-origin-disappears'});
 // Return no original record, original authorization receipt/core, original
 // writer private key, record factory, source object or original control files.
 return {dir,clientOptions,machineId:f.members[1].machineId,signingKey:f.members[1].signing.privateKey,sealingKey:f.members[1].sealing.privateKey,
  ownerPublicKey:clientOptions.ownerPublicKey!,witnessPublicKeys:new Map([[f.membership.witnessId,f.witness.publicKey]]),requestKey:'idempotency-witness-only-cold-source'};
}
async function fetchCold(){
 const fixture=await beforeWriterDisappears(),client=new GraphWitnessClient(fixture.clientOptions);
 const snapshot=await client.recover(fixture.requestKey);
 const response=await fetch(`${fixture.clientOptions.baseUrl}/v1/agents/echo/memberships/${snapshot.operation.packet.membershipEpoch}`,{headers:{Authorization:`Bearer ${fixture.clientOptions.bearerToken}`}});
 if(!response.ok)throw new Error('fixture-witness-membership');const originalMembership=await response.json() as GraphMembershipEpoch;
 const input:GraphWitnessSourceRecoveryInput={packet:snapshot.operation.packet,controlCapsule:snapshot.operation.controlCapsule,packetSignature:snapshot.operation.packetSignature,encryptedSourceBundle:snapshot.encryptedSourceBundle,
  originalMembership,...(snapshot.operation.prepareProof?{preparationProof:snapshot.operation.prepareProof}:{}),...(snapshot.operation.erasedControlProof?{erasedControlProof:snapshot.operation.erasedControlProof}:{}),...(snapshot.operation.adoption?{adoption:snapshot.operation.adoption}:{}),...(snapshot.operation.rewrap?{rewrap:snapshot.operation.rewrap}:{})};
 return {...fixture,client,input,trust:{machineId:fixture.machineId,sealingPrivateKey:fixture.sealingKey,ownerPublicKey:fixture.ownerPublicKey,witnessPublicKeys:fixture.witnessPublicKeys}};
}
describe('exact original control recovered from independent witness ciphertext',()=>{
 it('reconstructs and persists a Saved pending source with no origin control variables or writer key',async()=>{
  const f=await fetchCold();expect(fs.existsSync(path.join(f.dir,'lost-origin-files'))).toBe(false);
  expect(f.input).not.toHaveProperty('core');expect(f.input).not.toHaveProperty('authorizationProof');
  const recovered=reconstructGraphSourceRecord(f.input,f.trust);
  expect(recovered.applicationSource.toString()).toBe('private original source');recovered.applicationSource.fill(0);
  expect(recovered.record.packetSignature).toBe(f.input.packetSignature);expect(canonicalHash(recovered.record.core)).toBe(f.input.packet.coreHash);
  expect(canonicalHash(recovered.record.authorizationProof.receipt)).toBe(f.input.packet.authorizationReceiptHash);
  expect(recovered.record.authorizationProof.receipt.writerId).toBe(f.input.packet.writerId);
  const admission=new WriteAdmission({thisMachineId:f.machineId,isReadOnly:()=>false,isPoolActive:()=>true,registry:buildWriteDomainRegistry({machineId:f.machineId}),dryRun:false,disableTimers:true});cleanups.push(()=>admission.stop());
  const store=await ConversationGraphReplication.open({directory:path.join(f.dir,'cold-survivor'),agentId:'echo',machineId:f.machineId,memberPrivateKey:f.signingKey,memberSealingPrivateKey:f.sealingKey,ownerPublicKey:f.ownerPublicKey,
   witnessPublicKeys:f.witnessPublicKeys,writeAdmission:admission,legacyReadOnly:()=>false,liveAdmission:()=>({admitted:false,writerId:null,leaseEpoch:0,membershipEpoch:1,fencedLeaseHash:null}),
   validateCore:core=>validateGraphOperationCore('graph-event',core)!==null});
  const receipt=await store.receive(recovered.record,recovered.record.packet.writerId);expect(receipt.machineId).toBe(f.machineId);
  expect(store.mayAcknowledgeNewWrite(recovered.record.packet.eventId)).toBe(false);
  expect(store.repairRecord(recovered.record.packet.eventId)?.authorizationProof).toEqual(recovered.record.authorizationProof);
 });
 it('refuses packet, owner-root, namespace and decrypted control mutations',async()=>{
  const f=await fetchCold();expect(()=>reconstructGraphSourceRecord({...f.input,controlCapsule:undefined as never},f.trust)).toThrow('capsule-invalid');
  expect(()=>reconstructGraphSourceRecord({...f.input,preparationProof:undefined},f.trust)).toThrow('custody-missing');
  expect(()=>reconstructGraphSourceRecord({...f.input,packetSignature:'a'.repeat(86)},f.trust)).toThrow('packet-signature');
  expect(()=>reconstructGraphSourceRecord(f.input,{...f.trust,ownerPublicKey:crypto.generateKeyPairSync('ed25519').publicKey})).toThrow('membership');
  expect(()=>reconstructGraphSourceRecord({...f.input,packet:{...f.input.packet,eventId:'header-op:forged'}},f.trust)).toThrow();
  const bytes=openGraphBundle(f.input.encryptedSourceBundle!,f.machineId,f.sealingKey,f.input.packet);let body:Record<string,unknown>;try{body=JSON.parse(bytes.toString());}finally{bytes.fill(0);}
  (body.core as Record<string,unknown>).title='unerasable plaintext';const changed=Buffer.from(canonicalJson(body));
  try{expect(()=>decodeGraphSourceRecoveryEnvelope({packet:f.input.packet,packetSignature:f.input.packetSignature,plaintextEnvelope:changed,ownerPublicKey:f.ownerPublicKey})).toThrow('control-invalid');}finally{changed.fill(0);}
 });
 it('rejects replayed old ciphertext after a real higher-epoch witness erasure',async()=>{
  const f=await fetchCold();const at='2026-11-05T08:06:00.000Z',until='2026-11-05T08:20:00.000Z';
  const fl=new FencedLease({selfMachineId:f.machineId,sign:b=>sign(b,f.signingKey.export({type:'pkcs8',format:'pem'}).toString()),verify:()=>false},{leaseTtlMs:60000,failoverThresholdMs:180000});const native=fl.signLease(2,at,until,2);
  const bridge={v:1 as const,agentId:'echo',membershipEpoch:1,leaseEpoch:2,writerId:f.machineId,issuedAt:at,expiresAt:until,fencedLeaseHash:canonicalHash(native)};
  const lease:GraphWitnessLease={...bridge,signature:signGraphRecord('graph-lease-v1',bridge,f.signingKey)};await f.client.observeLease(lease,native);
  const fields={requestId:'erase-cold-source',target:f.input.packet.erasureIdentity,bundleHashes:[f.input.packet.sourceBundleHash],authorizationReceiptHash:canonicalHash({ownerAction:'forget-source'})};
  const action=signGraphRecord('graph-witness-action-v1',witnessActionPayload('erase',fields,lease),f.signingKey);
  const erasure=await f.client.erase(fields.requestId,fields.target,fields.bundleHashes,fields.authorizationReceiptHash,lease,native,action);
  const retained=reconstructGraphSourceRecord(f.input,{...f.trust,knownErasures:[erasure]});expect(retained.applicationSource.length).toBe(0);expect(retained.record.encryptedSourceBundle).toBeNull();expect(canonicalHash(retained.record.core)).toBe(f.input.packet.coreHash);
  expect((await f.client.recover(f.requestKey)).encryptedSourceBundle).toBeNull();
 });
});
