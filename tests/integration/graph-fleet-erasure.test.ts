import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {signGraphErasureIngress} from '../../src/core/GraphErasureProtocol.js';
import path from 'node:path';
import request from 'supertest';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {ConversationGraphReplicationRuntime} from '../../src/server/ConversationGraphReplicationRuntime.js';
import {canonicalHash,unsigned,signGraphRecord} from '../../src/core/GraphWitnessTypes.js';
import {signGraphAuthorizationReceipt} from '../../src/core/ConversationGraphReplicationProof.js';
import {setupGraphRuntimeFixture as setup,runtimes} from '../helpers/conversation-graph-runtime.js';
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
async function capture(x:Awaited<ReturnType<typeof setup>>,id:string,topicId=42){
 const base=x.f.record(id),core={...base.core,subject:{kind:'conversation',platform:'telegram',chatId:'-1001',topicId}};
 const receipt=signGraphAuthorizationReceipt({...unsigned(base.authorizationProof.receipt),coreHash:canonicalHash(core)},x.f.members[0].signing.privateKey),proof={...base.authorizationProof,receipt};
 const bytes=Buffer.from(`Private captured body ${id}`);try{
  const result=await x.runtime.withMutation(token=>x.runtime.submitPrepared({coreType:'graph-event',idempotencyKey:receipt.idempotencyKey,requestHash:canonicalHash({id}),core,authorizationProof:proof,plaintextSource:bytes},token));expect(result.state,JSON.stringify(result)).toBe('committed');
 }finally{bytes.fill(0);}return x.runtime.source.lookupByIdempotencyKey(receipt.idempotencyKey)!;
}
const owner=(requestId:string,target:ReturnType<typeof canonicalTarget>)=>({requestId,target,principalKey:'owner',authenticationMethod:'owner-dashboard' as const});
const canonicalTarget=(record:{packet:{erasureIdentity:{sourceKind:'header'|'conversation-metadata'|'graph-intent';sourceId:string}}})=>record.packet.erasureIdentity;
describe('priority graph-capture fleet erasure through actual native runtimes/W/registered signed peers',()=>{
 it('purges both installed copies plus intake while preserving unrelated captures and never substitutes member receipts for provider proof',async()=>{
  const x=await setup();expect(await x.runtime.refreshReadiness()).toBe(true);expect(await x.peer.refreshReadiness()).toBe(true);
  const erased=await capture(x,'erase-online-intent'),unrelated=await capture(x,'keep-unrelated-intent',43);
  const result=await x.runtime.erasure.acceptOwner(owner('forget-captured-online',canonicalTarget(erased)));
  expect(result).toMatchObject({localHidden:true,debtInventoryKnown:true,capturedGraphCopiesComplete:true,fleetComplete:false,waitingMachines:[],witnessPurge:{walPurged:true,externalBackupsVerified:false}});
  for(const runtime of [x.runtime,x.peer]){expect(()=>runtime.source.openVerifiedPayload(runtime.source.repairRecord(erased.packet.eventId)!)).toThrow('erased');const kept=runtime.source.openVerifiedPayload(runtime.source.repairRecord(unrelated.packet.eventId)!);expect(kept.toString()).toBe('Private captured body keep-unrelated-intent');kept.fill(0);expect(await runtime.localFleetPurge(erased.packet.erasureIdentity)).toHaveProperty('purgeInventoryHash');}
  expect((await x.witness.recover(erased.packet.idempotencyKey)).encryptedSourceBundle).toBeNull();expect((await x.witness.recover(unrelated.packet.idempotencyKey)).encryptedSourceBundle).not.toBeNull();
  const status=await x.witness.fleetErasureStatus('forget-captured-online');expect(status.receipts).toHaveLength(2);expect(status.receipts.every(receipt=>receipt.coveredScopes.length===4&&receipt.uncoveredScopes.length===0)).toBe(true);
  const serialized=JSON.stringify(status);expect(serialized).not.toContain('Private captured body');expect(serialized).not.toContain('grantVersion');expect(serialized).not.toContain('grantHash');
 });
 it('durably hides on a follower during W outage and retries the exact signed owner ingress after a native holder change',async()=>{
  const x=await setup();expect(await x.runtime.refreshReadiness()).toBe(true);expect(await x.peer.refreshReadiness()).toBe(true);const erased=await capture(x,'erase-outage-intent');
  const realFetch=globalThis.fetch;vi.stubGlobal('fetch',(input:Parameters<typeof fetch>[0],init?:Parameters<typeof fetch>[1])=>String(input).includes('/v1/agents/echo')?Promise.reject(new Error('actual-witness-network-unavailable')):realFetch(input,init));
  const hidden=await x.peer.erasure.acceptOwner(owner('forget-during-outage',canonicalTarget(erased)));expect(hidden).toMatchObject({localHidden:true,capturedGraphCopiesComplete:false,fleetComplete:false,debtInventoryKnown:false});expect(x.peer.localErasure.isDenied(erased.packet.erasureIdentity)).toBe(true);expect(()=>x.peer.source.openVerifiedPayload(x.peer.source.repairRecord(erased.packet.eventId)!)).toThrow('erased');expect(x.service.recover('echo',erased.packet.idempotencyKey).encryptedSourceBundle).not.toBeNull();
  const native=x.f.actuation(x.peer.machineId,2).originalLease;x.leaseStores[0].casWrite(native);x.leaseStores[1].casWrite(native);vi.unstubAllGlobals();
  await x.peer.erasure.retry();await x.runtime.erasure.retry();const result=await x.peer.erasure.status('forget-during-outage');expect(result).toMatchObject({capturedGraphCopiesComplete:true,fleetComplete:false,waitingMachines:[]});
  const status=await x.witness.fleetErasureStatus('forget-during-outage');expect(status.ingress?.acceptedBy).toBe(x.peer.machineId);expect(status.proof.leaseEpoch).toBe(2);expect(status.receipts).toHaveLength(2);
 });
 it('keeps an offline installed machine named until real restart/purge receipt and rejects bare owner assertions or conflicting request identities',async()=>{
  const x=await setup();expect(await x.runtime.refreshReadiness()).toBe(true);expect(await x.peer.refreshReadiness()).toBe(true);const erased=await capture(x,'erase-offline-intent'),kept=await capture(x,'keep-after-conflict',43);await x.peer.close();
  const pending=await x.runtime.erasure.acceptOwner(owner('forget-offline-peer',canonicalTarget(erased)));expect(pending).toMatchObject({localHidden:true,capturedGraphCopiesComplete:false,fleetComplete:false});expect(pending.waitingMachines.map(member=>member.machineId)).toContain(x.peer.machineId);expect((await x.witness.fleetErasureStatus('forget-offline-peer')).receipts).toHaveLength(1);
  await expect(x.runtime.erasure.acceptOwner(owner('forget-offline-peer',canonicalTarget(kept)))).rejects.toThrow('request-id-conflict');expect(x.runtime.localErasure.isDenied(kept.packet.erasureIdentity)).toBe(false);
  expect((await request(x.apps[0]).post('/internal/conversation-graph/replicate').set('Authorization','Bearer runtime-peer-auth').send({action:'erase-forward',owner:true,target:kept.packet.erasureIdentity})).status).not.toBe(200);
  const restarted=await ConversationGraphReplicationRuntime.open(x.options[1]);if(!restarted)throw new Error('missing-restarted-peer');runtimes.push(restarted);await restarted.erasure.retry();
  expect((await x.runtime.erasure.status('forget-offline-peer'))).toMatchObject({capturedGraphCopiesComplete:true,fleetComplete:false,waitingMachines:[]});expect(()=>restarted.source.openVerifiedPayload(restarted.source.repairRecord(erased.packet.eventId)!)).toThrow('erased');
  const files=await fs.readdir(path.join(x.managers[0].baseDir,'state'));expect(files.length).toBeGreaterThan(0);
 });
 it('recovers a fully fsynced signed temporary after crash, isolates torn slots, and never manufactures their owner authority',async()=>{
  const x=await setup();expect(await x.runtime.refreshReadiness()).toBe(true);expect(await x.peer.refreshReadiness()).toBe(true);const erased=await capture(x,'erase-recovered-temporary');
  await x.runtime.localFleetPurge(erased.packet.erasureIdentity);
  const ingress=signGraphErasureIngress({v:1,agentId:'echo',requestId:'recover-signed-temporary',target:erased.packet.erasureIdentity,principalKey:'owner',authenticationMethod:'owner-dashboard',acceptedBy:x.runtime.machineId,membershipEpoch:1,membershipHash:canonicalHash(x.f.membership),acceptedAt:new Date().toISOString()},x.managers[0].loadSigningKey());
  const directory=path.join(x.managers[0].baseDir,'state','conversation-graph-erasure-ingress');await fs.mkdir(directory,{recursive:true,mode:0o700});const digest=canonicalHash({agentId:'echo',requestId:ingress.requestId}),temporary=path.join(directory,`${digest}.ingress.json.${crypto.randomUUID()}.tmp`);
  const fd=await fs.open(temporary,'wx',0o600);try{await fd.writeFile(JSON.stringify(ingress));await fd.sync();}finally{await fd.close();}
  const bad=canonicalHash({agentId:'echo',requestId:'never-durable-corrupt'});await fs.writeFile(path.join(directory,`${bad}.ingress.json`),' {"v":1,"agentId":', {mode:0o600});
  await x.runtime.erasure.retry();const status=await x.witness.fleetErasureStatus(ingress.requestId);expect(status.ingress).toEqual(ingress);expect(status.receipts).toHaveLength(2);expect(await x.witness.pendingFleetErasures()).not.toContain('never-durable-corrupt');
  expect((await x.runtime.erasure.status(ingress.requestId)).localIngressDebt).toBeGreaterThan(0);expect((await fs.readdir(directory)).some(name=>name.endsWith('.corrupt'))).toBe(true);expect(JSON.parse(await fs.readFile(path.join(directory,`${digest}.ingress.json`),'utf8'))).toEqual(ingress);
 });

 it('keeps every member backup policy unknown even with valid independent W-domain audit and physical-purge signatures',async()=>{
  // This audit SIGNATURE fixture exercises authorization; it asserts no real cloud policy.
  const auditor=crypto.generateKeyPairSync('ed25519');const x=await setup({backupPolicyAuditorPublicKey:auditor.publicKey.export({type:'spki',format:'pem'}).toString()});expect(await x.runtime.refreshReadiness()).toBe(true);expect(await x.peer.refreshReadiness()).toBe(true);const erased=await capture(x,'erase-with-audit-fixture');await x.runtime.erasure.acceptOwner(owner('forget-backup-debt',canonicalTarget(erased)));
  const status=await x.witness.fleetErasureStatus('forget-backup-debt'),now=Date.now(),value={v:1 as const,agentId:'echo',witnessId:status.proof.witnessId,failureDomain:'managed-external',requestId:status.proof.requestId,erasureHash:canonicalHash(status.proof),policy:'no-retained-copies' as const,providerResourceHash:canonicalHash({fixture:'not-a-real-provider'}),evidenceHash:canonicalHash({fixture:'signature-only-negative-proof'}),checkedAt:new Date(now).toISOString(),expiresAt:new Date(now+3600000).toISOString()};
  x.service.attestBackupErasure('echo',{...value,signature:signGraphRecord('graph-backup-erasure-v1',value,auditor.privateKey)});
  const view=await x.runtime.erasure.status('forget-backup-debt');expect(view).toMatchObject({liveGraphStoresPurged:true,fleetComplete:false,witnessPurge:{walPurged:true,externalBackupsVerified:true}});expect(view.memberBackupDebt).toHaveLength(2);expect(view.memberBackupDebt.every(debt=>debt.state==='unknown')).toBe(true);
 });

 it('drains owner work that is still before ledger publication when closing and rejects new jobs without dropping accepted erasure',async()=>{
  const x=await setup();expect(await x.runtime.refreshReadiness()).toBe(true);expect(await x.peer.refreshReadiness()).toBe(true);const erased=await capture(x,'erase-during-quiesce');
  let release!:()=>void,entered!:()=>void;const blocked=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});const original=x.runtime.localFleetPurge.bind(x.runtime);
  vi.spyOn(x.runtime,'localFleetPurge').mockImplementation(async(target,proof)=>{const actual=await original(target,proof);if(!proof){entered();await blocked;}return actual;});
  const accepted=x.runtime.erasure.acceptOwner(owner('forget-during-quiesce',canonicalTarget(erased)));await started;
  let drained=false;const closing=x.runtime.erasure.close().then(()=>{drained=true;});await Promise.resolve();expect(drained).toBe(false);await expect(x.runtime.erasure.status('forget-during-quiesce')).rejects.toThrow('stopped');release();
  expect(await accepted).toMatchObject({localHidden:true,liveGraphStoresPurged:true,fleetComplete:false});await closing;expect(drained).toBe(true);expect((await x.witness.fleetErasureStatus('forget-during-quiesce')).receipts).toHaveLength(2);
 });

});
