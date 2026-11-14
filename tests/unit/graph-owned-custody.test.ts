import {createGraphOwnerRecoveryEnvelope} from '../../src/core/GraphOwnerRecovery.js';
import {GraphOwnerRecoveryStore} from '../../src/core/GraphOwnerRecoveryStore.js';
import {GraphCustodyBootstrapStore,GRAPH_CUSTODY_BOOTSTRAP_DOMAIN,type GraphCustodyBootstrapPublication} from '../../src/core/GraphCustodyBootstrap.js';
import {openConversationGraphStandalone} from '../../src/server/ConversationGraphStandalone.js';
import {base64ToSigningPem,base64ToEncryptionPem} from '../../src/core/MachineIdentity.js';
import crypto from 'node:crypto';
import {MachineIdentityManager} from '../../src/core/MachineIdentity.js';
import {attachOwnedGraphCustody,openPublishedOwnedGraphCustody} from '../../src/core/OwnedGraphCustody.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach,describe,expect,it} from 'vitest';
import {SafeFsExecutor} from '../../src/core/SafeFsExecutor.js';
import {createGraphCustodyProfile,graphCustodyScope,verifyGraphCustodyProfile} from '../../src/core/GraphCustodyProfile.js';
import {createInProcessGraphCustodyTransport,createPeerGraphCustodyTransport} from '../../src/core/GraphCustodyTransport.js';
import {GraphWitnessService} from '../../src/core/GraphWitnessService.js';
import {createGraphControlCapsule,verifyGraphControlCapsule} from '../../src/core/GraphWitnessControl.js';
import {GraphWitnessClient} from '../../src/core/GraphWitnessClient.js';
import {validateGraphErasureIdentity,validGraphOperationKey,canonicalHash,GRAPH_SIGNATURE_DOMAINS as D,signGraphRecord,unsigned,verifyMembershipEpoch} from '../../src/core/GraphWitnessTypes.js';
import {witnessFixture} from './graph-witness-fixtures.js';
const directories:string[]=[],services:GraphWitnessService[]=[];
afterEach(()=>{for(const service of services.splice(0))service.close();for(const dir of directories.splice(0))SafeFsExecutor.safeRmSync(dir,{recursive:true,force:true,operation:'graph-owned-custody-test:teardown'});});
function fixture(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'graph-owned-'));directories.push(dir);return witnessFixture(dir);}
describe('owner-signed owned custody profile and same-engine verified transport',()=>{
 it('accepts only the opaque queued erasure target without admitting queued IDs as signed operation/control identities',()=>{
  const f=fixture(),request=f.prepareRequest(),sourceId='queued:'+canonicalHash({logicalRequestId:'opaque-request'}),target={sourceKind:'graph-intent' as const,sourceId};expect(validateGraphErasureIdentity(target)).toBe(true);
  for(const id of ['queued:','queued:private-title','queued:'+'A'.repeat(64),'queued:'+'a'.repeat(63),'queued:'+'a'.repeat(65)])expect(validateGraphErasureIdentity({sourceKind:'graph-intent',sourceId:id})).toBe(false);
  expect(validGraphOperationKey('graph-event',sourceId)).toBe(false);expect(verifyGraphControlCapsule(request.controlCapsule,{...request.packet,erasureIdentity:target},f.owner.publicKey)).toBe(false);
 });
 it('binds exact roster, host, role key and domain without relabeling legacy external memberships',()=>{
  const f=fixture(),raw={...f.membership,failureDomain:'installed-laptop'},profile=createGraphCustodyProfile(raw,{mode:'owned-machine',witnessPublicKey:f.witness.publicKey.export({type:'spki',format:'pem'}).toString(),hostMachineId:f.machines[0].machineId},f.owner.privateKey);
  const membership={...raw,custodyProfile:profile,signature:''};membership.signature=signGraphRecord(D.membership,unsigned(membership),f.owner.privateKey);
  expect(verifyMembershipEpoch(membership,f.owner.publicKey)).toBe(true);expect(verifyGraphCustodyProfile(profile,membership,f.owner.publicKey)).toBe(true);
  expect(graphCustodyScope(membership,f.machines[0].machineId).kind).toBe('recorded-here');expect(graphCustodyScope(membership,f.machines[1].machineId).kind).toBe('copied-on-owned-machine');
  expect(verifyMembershipEpoch({...membership,members:membership.members.slice(1)},f.owner.publicKey)).toBe(false);
  expect(verifyGraphCustodyProfile({...profile,hostMachineId:f.machines[1].machineId},membership,f.owner.publicKey)).toBe(false);
  expect(verifyGraphCustodyProfile({...profile,mode:'external',hostMachineId:null,hostSigningPublicKey:null},membership,f.owner.publicKey)).toBe(false);
  expect(verifyGraphCustodyProfile({...profile,title:'private'} as never,membership,f.owner.publicKey)).toBe(false);
  expect(verifyMembershipEpoch(f.membership,f.owner.publicKey)).toBe(true);expect(graphCustodyScope(f.membership,f.machines[0].machineId).kind).toBe('external-custody');
 });
 it('opens under actual native one-member authority and durable publication, reopens the same DB and quarantines loss instead of creating blank genesis',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'owned-published-'));directories.push(dir);const owner=crypto.generateKeyPairSync('ed25519'),role=crypto.generateKeyPairSync('ed25519'),ownerPublicKey=owner.publicKey.export({type:'spki',format:'pem'}).toString();
  const native=await openConversationGraphStandalone({stateDir:dir,enrollment:async local=>{const raw={v:1 as const,agentId:'standalone-owned',epoch:1,previousMembershipHash:null,members:[{machineId:local.machineId,signingPublicKey:base64ToSigningPem(local.signingPublicKey),sealingPublicKey:base64ToEncryptionPem(local.encryptionPublicKey)}],writerId:local.machineId,witnessId:'owned-role',failureDomain:'owned-local-disk',createdAt:new Date().toISOString()},profile=createGraphCustodyProfile({...raw,signature:''},{mode:'owned-machine',witnessPublicKey:role.publicKey.export({type:'spki',format:'pem'}).toString(),hostMachineId:local.machineId},owner.privateKey),membership={...raw,custodyProfile:profile,signature:''};membership.signature=signGraphRecord(D.membership,unsigned(membership),owner.privateKey);return {membership,ownerPublicKey};}});
  const membership=native.enrollment.membership,recoveryEnvelope=createGraphOwnerRecoveryEnvelope(owner.privateKey,membership),recoveryReceipt=new GraphOwnerRecoveryStore({stateDir:dir,agentId:membership.agentId,identity:native.identity,identities:native.identities}).put(recoveryEnvelope,membership,ownerPublicKey),originalLease=native.leaseCoordinator.currentLease()!,leaseRaw={v:1 as const,agentId:membership.agentId,membershipEpoch:1,leaseEpoch:originalLease.epoch,writerId:originalLease.holder,issuedAt:originalLease.acquiredAt,expiresAt:originalLease.expiresAt,fencedLeaseHash:canonicalHash(originalLease)},lease={...leaseRaw,signature:signGraphRecord(D.lease,leaseRaw,native.identity.loadSigningKey())},admissionRaw={v:1 as const,ownerRecoveryHash:canonicalHash(recoveryEnvelope),agentId:membership.agentId,principalKey:`owner:${membership.agentId}`,admissionId:'owner-admitted-test-request',authenticationMethod:'owner-device' as const,requestId:'owned-first-use',profileHash:canonicalHash(membership.custodyProfile),membershipHash:canonicalHash(membership),nativeLeaseHash:canonicalHash(originalLease),machineId:originalLease.holder,acceptedAt:new Date().toISOString()},publication:GraphCustodyBootstrapPublication={v:1,ownerPublicKey,membership,lease,originalLease,admission:{...admissionRaw,signature:signGraphRecord(GRAPH_CUSTODY_BOOTSTRAP_DOMAIN,admissionRaw,native.identity.loadSigningKey())}},store=new GraphCustodyBootstrapStore(dir,membership.agentId),args={stateDir:dir,agentId:membership.agentId,identity:native.identity,identities:native.identities,ownerPublicKey,rolePrivateKey:role.privateKey,publication};let host:ReturnType<typeof openPublishedOwnedGraphCustody>|undefined;
  try{
   expect(native.leaseCoordinator.holdsLease()).toBe(true);store.pin(publication,membership.members,originalLease.holder,native.identity.loadSigningKey(),recoveryReceipt);
   expect(()=>openPublishedOwnedGraphCustody({...args,rolePrivateKey:owner.privateKey})).toThrow('owned-custody-role-key-mismatch');expect(fs.existsSync(path.join(dir,'conversation-graph','custody.sqlite'))).toBe(false);
   host=openPublishedOwnedGraphCustody(args);expect((await host.client.inventory('s'.repeat(43))).manifest.entries).toEqual([]);host.close();host=openPublishedOwnedGraphCustody(args);expect(await host.client.membership(1)).toEqual(membership);host.close();host=undefined;
   const database=path.join(dir,'conversation-graph','custody.sqlite');SafeFsExecutor.safeUnlinkSync(database,{operation:'graph-owned-custody-test:simulate-lost-disk'});expect(()=>openPublishedOwnedGraphCustody(args)).toThrow();expect(fs.existsSync(database)).toBe(false);
  }finally{host?.close();await native.close();}
 });
 it('attaches only the actual enrolled host to a published engine and closes its private transport with the live handle',async()=>{
  const f=fixture(),directory=fs.mkdtempSync(path.join(os.tmpdir(),'owned-identity-'));directories.push(directory);const identity=new MachineIdentityManager(directory);await identity.generateIdentity();const machineId=identity.loadIdentity().machineId,signingPublicKey=identity.getSigningPublicKeyPem(machineId)!,sealingPublicKey=crypto.createPublicKey(identity.loadEncryptionKey()).export({type:'spki',format:'pem'}).toString();
  const raw={...f.membership,writerId:machineId,members:[{machineId,signingPublicKey,sealingPublicKey}],failureDomain:'installed-laptop'},profile=createGraphCustodyProfile(raw,{mode:'owned-machine',witnessPublicKey:f.witness.publicKey.export({type:'spki',format:'pem'}).toString(),hostMachineId:machineId},f.owner.privateKey),membership={...raw,custodyProfile:profile,signature:''};membership.signature=signGraphRecord(D.membership,unsigned(membership),f.owner.privateKey);
  const service=new GraphWitnessService({...f.options,failureDomain:membership.failureDomain,ownedHost:{machineId,signingPublicKey}});services.push(service);service.registerMembership(membership);
  const args={service,identity,membership,ownerPublicKey:f.options.enrollments[membership.agentId].ownerPublicKey,bearerToken:f.options.enrollments[membership.agentId].bearerToken};const owned=attachOwnedGraphCustody(args);expect(await owned.client.membership(1)).toEqual(membership);
  const strangerDir=fs.mkdtempSync(path.join(os.tmpdir(),'owned-stranger-'));directories.push(strangerDir);const stranger=new MachineIdentityManager(strangerDir);await stranger.generateIdentity();expect(()=>attachOwnedGraphCustody({...args,identity:stranger})).toThrow('owned-custody-local-identity-invalid');
  owned.close();expect((await owned.transport.request('GET','/health')).status).toBe(503);await expect(owned.client.inventory('x'.repeat(43))).rejects.toThrow('owned-custody-closed');owned.close();
 });
 it('executes actual durable owned service through shared handlers with no URL, socket, paid bearer setup or test loopback flag',async()=>{
  const f=fixture(),host=f.machines[0],raw={...f.membership,failureDomain:'installed-laptop'},profile=createGraphCustodyProfile(raw,{mode:'owned-machine',witnessPublicKey:f.witness.publicKey.export({type:'spki',format:'pem'}).toString(),hostMachineId:host.machineId},f.owner.privateKey),membership={...raw,custodyProfile:profile,signature:''};membership.signature=signGraphRecord(D.membership,unsigned(membership),f.owner.privateKey);
  const options={...f.options,failureDomain:membership.failureDomain,ownedHost:{machineId:host.machineId,signingPublicKey:membership.members[0].signingPublicKey}},service=new GraphWitnessService(options);services.push(service);service.registerMembership(membership);
  const transport=createInProcessGraphCustodyTransport({service,membership,ownerPublicKey:f.options.enrollments[membership.agentId].ownerPublicKey,bearerToken:f.options.enrollments[membership.agentId].bearerToken});
  const client=new GraphWitnessClient({agentId:membership.agentId,bearerToken:'',witnessId:membership.witnessId,witnessPublicKey:profile.witnessPublicKey,expectedFailureDomain:membership.failureDomain,ownerPublicKey:f.options.enrollments[membership.agentId].ownerPublicKey,transport});
  await client.verifyRemote();expect(await client.membership(1)).toEqual(membership);expect((await client.inventory('a'.repeat(43))).manifest.entries).toEqual([]);
  const old=f.prepareRequest(),controlCapsule=createGraphControlCapsule(old.packet.coreType,old.controlCapsule.core,{...old.controlCapsule.authorizationProof,membership});const packet={...old.packet,controlHash:canonicalHash(controlCapsule)},request={...old,controlCapsule,packet,packetSignature:signGraphRecord(D.packet,packet,host.signing.privateKey)};
  const prepared=await client.prepare(request);expect(prepared.eventId).toBe(packet.eventId);expect(graphCustodyScope(await client.membership(1),host.machineId).kind).toBe('recorded-here');
  await expect(client.commit(request,membership,[f.receipt(packet,0)])).rejects.toThrow();const certificate=await client.commit(request,membership,[f.receipt(packet,0),f.receipt(packet,1)]);
  expect((await client.acknowledgeCertificate(packet.idempotencyKey,f.receipt(packet,0,'certificate',canonicalHash(certificate)))).allMembersPersisted).toBe(false);expect((await client.acknowledgeCertificate(packet.idempotencyKey,f.receipt(packet,1,'certificate',canonicalHash(certificate)))).allMembersPersisted).toBe(true);
  expect((await client.operation(packet.idempotencyKey)).certificate).toEqual(certificate);
  const peerTransport=createPeerGraphCustodyTransport({membership,ownerPublicKey:f.options.enrollments[membership.agentId].ownerPublicKey,request:async(machine,payload)=>{expect(machine).toBe(host.machineId);return transport.request(payload.method,payload.path,payload.body);}}),peerClient=new GraphWitnessClient({agentId:membership.agentId,bearerToken:'',witnessId:membership.witnessId,witnessPublicKey:profile.witnessPublicKey,expectedFailureDomain:membership.failureDomain,ownerPublicKey:f.options.enrollments[membership.agentId].ownerPublicKey,transport:peerTransport});
  expect((await peerClient.operation(packet.idempotencyKey)).certificate).toEqual(certificate);
  await expect(peerTransport.request('GET','/v1/agents/foreign/memberships/1')).rejects.toThrow('custody-peer-scope-invalid');
  const corruptTransport=createPeerGraphCustodyTransport({membership,ownerPublicKey:f.options.enrollments[membership.agentId].ownerPublicKey,request:async(_machine,payload)=>{const response=await transport.request(payload.method,payload.path,payload.body);if(payload.path.includes('/operations/')){const body=JSON.parse(response.json);body.stateProof.signature='';return {...response,json:JSON.stringify(body)};}return response;}}),corruptClient=new GraphWitnessClient({agentId:membership.agentId,bearerToken:'',witnessId:membership.witnessId,witnessPublicKey:profile.witnessPublicKey,expectedFailureDomain:membership.failureDomain,ownerPublicKey:f.options.enrollments[membership.agentId].ownerPublicKey,transport:corruptTransport});
  await expect(corruptClient.operation(packet.idempotencyKey)).rejects.toThrow();

  expect((await transport.request('GET','/v1/agents/wrong-agent/memberships/1')).status).toBe(403);
  expect(()=>createInProcessGraphCustodyTransport({service,membership,ownerPublicKey:f.options.enrollments[membership.agentId].ownerPublicKey,bearerToken:'wrong'})).toThrow();
  const fields={requestId:'owned-local-forget',target:packet.erasureIdentity,bundleHashes:[packet.sourceBundleHash],authorizationReceiptHash:canonicalHash({ownerRequest:'forget'})};
  const erased=await client.erase(fields.requestId,fields.target,fields.bundleHashes,fields.authorizationReceiptHash,request.lease,request.originalLease,f.actionSignature('erase',fields,request.lease));expect(erased.target).toEqual(packet.erasureIdentity);
  expect((await client.recover(packet.idempotencyKey)).encryptedSourceBundle).toBeNull();const checkpoint=await client.checkpointErasure(fields.requestId);expect(checkpoint.walPurged).toBe(true);expect(checkpoint.externalBackupsVerified).toBe(false);
  expect(()=>new GraphWitnessService({...options,ownedHost:undefined})).toThrow('witness-failure-domain-not-independent');
  service.close();const reopened=new GraphWitnessService(options);services.push(reopened);expect(reopened.membershipProof(membership.agentId,1)).toEqual(membership);
  const legacy=f.membership;expect(()=>reopened.registerMembership(legacy)).toThrow();expect(canonicalHash(reopened.membershipProof(membership.agentId,1))).toBe(canonicalHash(membership));
 });
});
