import {createGraphControlCapsule} from '../../src/core/GraphWitnessControl.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach,describe,expect,it} from 'vitest';
import {SafeFsExecutor} from '../../src/core/SafeFsExecutor.js';
import {ConversationGraphReplication,type ConversationGraphReplicationRecord} from '../../src/core/ConversationGraphReplication.js';
import {unsigned,canonicalHash,canonicalJson,graphOperationKey,signGraphRecord} from '../../src/core/GraphWitnessTypes.js';
import {encodeGraphSourceEnvelope} from '../../src/core/ConversationGraphSourceEnvelope.js';
import {signGraphAuthorizationReceipt} from '../../src/core/ConversationGraphReplicationProof.js';
import {sealGraphBundle} from '../../src/core/GraphWitnessCrypto.js';
import {newHeaderId,newTitleSalt,titleCommitment} from '../../src/core/EffortHeaderStore.js';
import {deriveGraphErasureIdentity} from '../../src/core/ConversationGraphOperation.js';
import {replicationFixture} from './conversation-graph-replication.fixtures.js';
const dirs:string[]=[];
async function directory(){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'graph-header-custody-'));dirs.push(dir);return dir;}
afterEach(()=>{for(const dir of dirs.splice(0))SafeFsExecutor.safeRmSync(dir,{recursive:true,force:true,operation:'graph-header-source-test:teardown'});});
function header(f:ReturnType<typeof replicationFixture>,wrong=false,headerId=newHeaderId(),rawId='event-one'):ConversationGraphReplicationRecord{
 const graph=f.record();const eventId=graphOperationKey('header-op',rawId),salt=newTitleSalt();
 const core={schemaVersion:1,kind:'set-effort-title',opId:rawId,headerId,baseVersion:0,authority:'owner',principal:'owner',receipt:{kind:'owner-proof',id:'receipt-header-one'},machineId:'writer',createdAt:new Date('2026-11-05T08:05:00Z').toISOString(),titleCommitment:titleCommitment('Actual owner title',salt),bundleRef:{kind:'header-source-bundle',id:'bundle-header-one'}};
 const receipt=signGraphAuthorizationReceipt({...unsigned(graph.authorizationProof.receipt),eventId,coreHash:canonicalHash(core),receiptId:core.receipt.id,idempotencyKey:`header-op:${rawId}`},f.members[0].signing.privateKey);
 const proof={...graph.authorizationProof,receipt};const payload=Buffer.from(canonicalJson({kind:'effort-header-payload',requestId:'request-one',requestHash:canonicalHash('owner request'),headerId,title:wrong?'Unrelated display bytes':'Actual owner title',salt}));
 const envelope=encodeGraphSourceEnvelope('header-op',core,proof,payload);payload.fill(0);
 const encryptedSourceBundle=sealGraphBundle(envelope,f.membership.members,{agentId:'echo',eventId});envelope.fill(0);
 const packet={...graph.packet,coreType:'header-op' as const,controlHash:canonicalHash(createGraphControlCapsule('header-op',core,proof)),erasureIdentity:deriveGraphErasureIdentity('header-op',core),eventId,idempotencyKey:receipt.idempotencyKey,coreHash:canonicalHash(core),authorizationReceiptHash:canonicalHash(receipt),sourceSequence:2,predecessorHash:graph.packet.coreHash,sourceBundleHash:canonicalHash(encryptedSourceBundle)};
 return {coreType:'header-op',packet,packetSignature:signGraphRecord('graph-operation-packet-v1',packet,f.members[0].signing.privateKey),core,authorizationProof:proof,encryptedSourceBundle};
}
describe('typed header source custody',()=>{
 it('rejects validly signed but unrelated title ciphertext before fsync or source durability receipt',async()=>{
  const f=replicationFixture();const dir=await directory();const source=await ConversationGraphReplication.open(f.options(dir));const record=header(f,true);
  await expect(source.receive(record,'writer')).rejects.toThrow();expect(source.repairRecord(record.packet.eventId)).toBeNull();
  expect(await fs.readdir(dir)).toEqual([]);
 });
 it('keeps same raw header and graph IDs distinct without putting title bytes in immutable metadata',async()=>{
  const f=replicationFixture();const dir=await directory();const source=await ConversationGraphReplication.open(f.options(dir));const graph=f.record();await source.appendLocal(graph);const record=header(f);
  await source.appendLocal(record);expect(source.recordsForRepair()).toHaveLength(2);expect(source.repairRecord(graph.packet.eventId)?.coreType).toBe('graph-event');expect(source.repairRecord(record.packet.eventId)?.coreType).toBe('header-op');
  const bytes=source.openVerifiedPayload(record);try{expect(JSON.parse(bytes.toString()).title).toBe('Actual owner title');}finally{bytes.fill(0);}
  for(const name of (await fs.readdir(dir)).filter(name=>!name.includes('.bundle.json')))expect(await fs.readFile(path.join(dir,name),'utf8')).not.toContain('Actual owner title');
  expect(JSON.stringify(source.originRecords())).not.toMatch(/Actual owner title|ciphertext|envelopes/);
 });
 it('logical header forget fences every version including a future op and nonce absent from the hash list',async()=>{
  const f=replicationFixture(),dir=await directory(),headerId=newHeaderId();let source=await ConversationGraphReplication.open(f.options(dir));
  const earlier=header(f,false,headerId,'title-v1');await source.receive(earlier,'writer');
  const raw={v:1 as const,agentId:'echo',requestId:'forget-logical-header',target:earlier.packet.erasureIdentity,bundleHashes:[],membershipEpoch:1,leaseEpoch:1,authorizationReceiptHash:earlier.packet.authorizationReceiptHash,witnessId:'independent-witness',erasedAt:'2026-11-05T08:09:00Z'};
  const proof={...raw,signature:signGraphRecord('graph-witness-erasure-v1',raw,f.witness.privateKey)};await source.applyErasure(proof,f.erasureAuthority(proof));
  const late=header(f,false,headerId,'title-v2');expect(late.packet.sourceBundleHash).not.toBe(earlier.packet.sourceBundleHash);
  const receipt=await source.receive(late,'writer');expect(receipt.phase).toBe('cancellation');
  source=await ConversationGraphReplication.open(f.options(dir));for(const record of source.recordsForRepair()){expect(record.encryptedSourceBundle).toBeNull();expect(()=>source.openVerifiedPayload(record)).toThrow('erased');}
  expect((await fs.readdir(dir)).some(name=>name.includes('.bundle.json'))).toBe(false);
 });

});
