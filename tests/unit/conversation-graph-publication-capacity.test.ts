import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach,expect,it} from 'vitest';
import {SafeFsExecutor} from '../../src/core/SafeFsExecutor.js';
import {GRAPH_REPLICATION_MAX_MEMBERSHIP_EPOCH as MAX_M,GRAPH_REPLICATION_MAX_LEASE_EPOCH as MAX_N,GRAPH_REPLICATION_EPOCH_STRIDE as STRIDE,GRAPH_REPLICATION_NEGATIVE_RANK_BASE as NEG,graphReplicationPublicationVersion as rank,validGraphReplicationPublicationVersion as validRank} from '../../src/core/ConversationGraphReplicationLimits.js';
import {ConversationGraphReplication} from '../../src/core/ConversationGraphReplication.js';
import {ConversationGraphIntake} from '../../src/core/ConversationGraphIntake.js';
import {createGraphControlCapsule} from '../../src/core/GraphWitnessControl.js';
import {encodeGraphSourceEnvelope} from '../../src/core/ConversationGraphSourceEnvelope.js';
import {sealGraphBundle} from '../../src/core/GraphWitnessCrypto.js';
import {signGraphAuthorizationReceipt} from '../../src/core/ConversationGraphReplicationProof.js';
import {validateGraphReplicationDescriptor} from '../../src/core/ConversationGraphReplicationDescriptor.js';
import {canonicalHash,unsigned,signGraphRecord,GRAPH_SIGNATURE_DOMAINS as D,verifyMembershipEpoch,validatePacket,verifyWitnessLease} from '../../src/core/GraphWitnessTypes.js';
import {replicationFixture} from './conversation-graph-replication.fixtures.js';
const dirs:string[]=[];afterEach(()=>{for(const dir of dirs.splice(0))SafeFsExecutor.safeRmSync(dir,{recursive:true,force:true,operation:'graph-publication-capacity-test:cleanup'});});
async function directory(){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'graph-publication-capacity-'));dirs.push(dir);return dir;}
function frame(membershipEpoch:number,leaseEpoch:number){
 const f=replicationFixture(),current=f.actuation('writer',leaseEpoch),m={...unsigned(f.membership),epoch:membershipEpoch,previousMembershipHash:membershipEpoch===1?null:canonicalHash({prior:membershipEpoch-1})},membership={...m,signature:signGraphRecord(D.membership,m,f.owner.privateKey)};
 const b={...unsigned(current.lease),membershipEpoch},lease={...b,signature:signGraphRecord(D.lease,b,f.members[0].signing.privateKey)},original=f.record('capacity-event'),core={...original.core,createdAt:'2026-11-05T08:06:00.000Z'};
 const receipt=signGraphAuthorizationReceipt({...unsigned(original.authorizationProof.receipt),coreHash:canonicalHash(core),membershipEpoch,leaseEpoch,fencedLeaseHash:canonicalHash(current.originalLease),acceptedAt:core.createdAt},f.members[0].signing.privateKey),authorizationProof={receipt,membership,lease,originalLease:current.originalLease};
 const encryptedSourceBundle=sealGraphBundle(encodeGraphSourceEnvelope('graph-event',core,authorizationProof,Buffer.from('bounded original source')),membership.members,original.packet),packet={...original.packet,membershipEpoch,leaseEpoch,coreHash:canonicalHash(core),authorizationReceiptHash:canonicalHash(receipt),sourceBundleHash:canonicalHash(encryptedSourceBundle),controlHash:canonicalHash(createGraphControlCapsule('graph-event',core,authorizationProof))};
 f.setLive({admitted:true,writerId:'writer',membershipEpoch,leaseEpoch,fencedLeaseHash:canonicalHash(current.originalLease)});
 return {f,membership,lease,record:{...original,core,packet,authorizationProof,encryptedSourceBundle,packetSignature:signGraphRecord(D.packet,packet,f.members[0].signing.privateKey)}};
}
it('orders every earlier membership below the next, keeps M1 ranks, and keeps every negative above every positive',()=>{
 expect(rank(1,17,1023)).toBe(17*STRIDE+1023);
 expect(rank(1,MAX_N,1023)).toBeLessThan(rank(2,1,0));expect(rank(MAX_M-1,MAX_N,1023)).toBeLessThan(rank(MAX_M,1,0));
 const maximum=rank(MAX_M,MAX_N,1023);expect(maximum).toBe(2**50-1);expect(rank(1,1,0,true)).toBeGreaterThan(maximum);expect(rank(MAX_M,MAX_N,1023,true)).toBe(NEG+maximum);expect(Number.isSafeInteger(NEG+maximum)).toBe(true);
 for(const value of [rank(1,1,0),maximum,rank(1,1,0,true),NEG+maximum])expect(validRank(value)).toBe(true);
 for(const value of [2**50,NEG,NEG+2**50,Number.MAX_SAFE_INTEGER])expect(validRank(value)).toBe(false);
 expect(()=>rank(MAX_M+1,1,0)).toThrow('capacity');expect(()=>rank(1,MAX_N+1,0)).toThrow('capacity');
});
it('accepts exact shared MAX with genuine signatures and refuses MAX+1 before source ACK or durable Intake reservation',async()=>{
 const exact=frame(MAX_M,MAX_N),source=await ConversationGraphReplication.open({...exact.f.options(await directory()),installedMembership:exact.membership});
 expect(verifyMembershipEpoch(exact.membership,exact.f.owner.publicKey)).toBe(true);expect(validatePacket(exact.record.packet)).toBe(true);expect(verifyWitnessLease(exact.lease,exact.membership)).toBe(true);
 expect((await source.appendLocal(exact.record)).receipt.phase).toBe('source');
 const descriptor=source.descriptorFor(exact.record);expect(validateGraphReplicationDescriptor({...descriptor,publicationVersion:2**50})).toBeNull();expect(validateGraphReplicationDescriptor({...descriptor,publicationVersion:NEG+2**50})).toBeNull();expect(validateGraphReplicationDescriptor({...descriptor,publicationVersion:rank(1,1,0,true)})).toBeNull();expect(validateGraphReplicationDescriptor({...descriptor,erasureHash:canonicalHash('unsigned-negative')})).toBeNull();
 for(const [membershipEpoch,leaseEpoch]of [[MAX_M+1,1],[1,MAX_N+1]]){
  const over=frame(membershipEpoch,leaseEpoch),dir=await directory(),target=await ConversationGraphReplication.open(over.f.options(dir)),before=await fs.readdir(dir);
  expect(validatePacket(over.record.packet)).toBe(false);await expect(target.receive(over.record,'writer')).rejects.toThrow('untrusted');expect(await fs.readdir(dir)).toEqual(before);
  const spoolDir=await directory(),spool=new ConversationGraphIntake(spoolDir,over.f.owner.publicKey,new Map([[over.f.membership.witnessId,over.f.witness.publicKey]]));await expect(spool.reserve(over.record.packet.idempotencyKey,canonicalHash('attempt'),()=>over.record)).rejects.toThrow();expect(await spool.reservations()).toEqual([]);expect((await fs.readdir(spoolDir)).filter(name=>name.endsWith('.json'))).toEqual([]);
 }
});
