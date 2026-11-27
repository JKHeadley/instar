import crypto from 'node:crypto';
import {expect,it,vi} from 'vitest';
import {setupGraphRuntimeFixture} from '../helpers/conversation-graph-runtime.js';
import {GraphOwnedControlFrameCache,GRAPH_OWNED_FRAME_CHUNK_BYTES,GRAPH_OWNED_FRAME_DOMAIN} from '../../src/core/GraphOwnedControlFrameCache.js';
import {createGraphControlCapsule} from '../../src/core/GraphWitnessControl.js';
import {sealGraphBundle} from '../../src/core/GraphWitnessCrypto.js';
import {canonicalHash,canonicalJson,unsigned,signGraphRecord,GRAPH_SIGNATURE_DOMAINS as D} from '../../src/core/GraphWitnessTypes.js';

it('checks real native/source/control authority before allocation and purges both live transport directions on denial',async()=>{
 const f=await setupGraphRuntimeFixture({ownedCustodyHostIndex:0}),current=f.runtime.actuation(),record=f.f.record('framed-source');
 const bundle=sealGraphBundle(crypto.randomBytes(400000),f.f.membership.members,{agentId:'echo',eventId:record.packet.eventId});
 const packet={...record.packet,sourceBundleHash:canonicalHash(bundle)},packetSignature=signGraphRecord(D.packet,packet,f.managers[0].loadSigningKey());
 const controlCapsule=createGraphControlCapsule(record.coreType,record.core,record.authorizationProof);
 const caches=[f.runtime,f.peer].map((runtime,index)=>new GraphOwnedControlFrameCache({stateDir:f.options[index].stateDir,agentId:'echo',identity:f.managers[index],authority:f.authorities[index],leaseCoordinator:f.options[index].leaseCoordinator,fence:runtime.localErasure}));
 try{
  const [outgoing,incoming]=caches,target=f.peer.machineId,commandHash=canonicalHash({kind:'stage',actualRecord:packet.eventId});
  const part=outgoing.createSourcePart({target,commandHash,packet,packetSignature,controlCapsule,...current,bundle});
  expect(Buffer.byteLength(canonicalJson(bundle))).toBeGreaterThan(256*1024);
  expect(()=>incoming.begin({...part.plan,packet:{...packet,erasureIdentity:{sourceKind:'header',sourceId:'forged-header'}}},f.runtime.machineId)).toThrow('proof-invalid');
  const wrongTargetPacket={...packet,erasureIdentity:{sourceKind:'header' as const,sourceId:'signed-but-wrong-target'}},wrongTargetBody={...unsigned(part.plan),packet:wrongTargetPacket,packetSignature:signGraphRecord(D.packet,wrongTargetPacket,f.managers[0].loadSigningKey())},wrongTargetPlan={...wrongTargetBody,signature:signGraphRecord(GRAPH_OWNED_FRAME_DOMAIN,wrongTargetBody,f.managers[0].loadSigningKey())};
  expect(()=>incoming.begin(wrongTargetPlan,f.runtime.machineId)).toThrow('proof-invalid');
  expect(()=>incoming.begin(part.plan,target)).toThrow('proof-invalid');
  const key=incoming.begin(part.plan,f.runtime.machineId);expect(incoming.begin(part.plan,f.runtime.machineId)).toBe(key);
  expect(()=>incoming.take(key,f.runtime.machineId,commandHash)).toThrow('incomplete');
  for(let index=0;index<part.plan.chunkHashes.length;index++){
   const chunk=outgoing.outboundChunk(part.key,target,index);expect(Buffer.byteLength(canonicalJson({chunk}))).toBeLessThan(256*1024);expect(Buffer.from(chunk,'base64url').length).toBeLessThanOrEqual(GRAPH_OWNED_FRAME_CHUNK_BYTES);
   if(index===0)expect(()=>incoming.chunk(key,f.runtime.machineId,index,chunk.slice(1))).toThrow('chunk-invalid');
   incoming.chunk(key,f.runtime.machineId,index,chunk);incoming.chunk(key,f.runtime.machineId,index,chunk);
  }
  expect(incoming.take(key,f.runtime.machineId,commandHash)).toEqual(bundle);
  const restarting=new GraphOwnedControlFrameCache({stateDir:f.options[1].stateDir,agentId:'echo',identity:f.managers[1],authority:f.authorities[1],leaseCoordinator:f.options[1].leaseCoordinator,fence:f.peer.localErasure});
  expect(()=>restarting.take(key,f.runtime.machineId,commandHash)).toThrow('incomplete');restarting.close();
  const pending=incoming.begin(part.plan,f.runtime.machineId);incoming.chunk(pending,f.runtime.machineId,0,outgoing.outboundChunk(part.key,target,0));
  await f.peer.localErasure.deny(packet.erasureIdentity);incoming.purge(packet.erasureIdentity);
  expect(incoming.assertLocalErasurePurged(packet.erasureIdentity)).toMatch(/^[a-f0-9]{64}$/);
  expect(()=>incoming.begin(part.plan,f.runtime.machineId)).toThrow('proof-invalid');expect(()=>incoming.take(pending,f.runtime.machineId,commandHash)).toThrow('incomplete');
  await f.runtime.localErasure.deny(packet.erasureIdentity);outgoing.purge(packet.erasureIdentity);expect(outgoing.assertLocalErasurePurged(packet.erasureIdentity)).toMatch(/^[a-f0-9]{64}$/);
  expect(()=>outgoing.outboundChunk(part.key,target,0)).toThrow('unknown');
  const later=f.f.record('unrelated-after-erasure'),next=outgoing.createSourcePart({target,commandHash:canonicalHash({next:'unrelated'}),packet:later.packet,packetSignature:later.packetSignature,controlCapsule:createGraphControlCapsule(later.coreType,later.core,later.authorizationProof),...current,bundle:later.encryptedSourceBundle!}),laterKey=incoming.begin(next.plan,f.runtime.machineId);
  for(let index=0;index<next.plan.chunkHashes.length;index++)incoming.chunk(laterKey,f.runtime.machineId,index,outgoing.outboundChunk(next.key,target,index));
  expect(incoming.take(laterKey,f.runtime.machineId,next.plan.commandHash)).toEqual(later.encryptedSourceBundle);outgoing.release(next.key);
 }finally{for(const cache of caches)cache.close();}
});
it('refuses an originally valid part after an actual signed native takeover',async()=>{
 const f=await setupGraphRuntimeFixture({ownedCustodyHostIndex:0}),current=f.runtime.actuation(),record=f.f.record('native-framing-takeover'),caches=[f.runtime,f.peer].map((runtime,index)=>new GraphOwnedControlFrameCache({stateDir:f.options[index].stateDir,agentId:'echo',identity:f.managers[index],authority:f.authorities[index],leaseCoordinator:f.options[index].leaseCoordinator,fence:runtime.localErasure}));
 try{const part=caches[0].createSourcePart({target:f.peer.machineId,commandHash:canonicalHash({takeover:'actual'}),packet:record.packet,packetSignature:record.packetSignature,controlCapsule:createGraphControlCapsule(record.coreType,record.core,record.authorizationProof),...current,bundle:record.encryptedSourceBundle!});
  const key=caches[1].begin(part.plan,f.runtime.machineId);caches[1].chunk(key,f.runtime.machineId,0,caches[0].outboundChunk(part.key,f.peer.machineId,0));const buffer=(caches[1] as unknown as {entries:Map<string,{buffer:Buffer}>}).entries.get(key)!.buffer;expect(buffer.some(byte=>byte!==0)).toBe(true);const next=f.f.actuation(f.peer.machineId,2);expect(f.leaseStores[1].casWrite(next.originalLease).ok).toBe(true);expect(f.options[1].leaseCoordinator.currentLease()?.holder).toBe(f.peer.machineId);
  expect(()=>caches[1].begin(part.plan,f.runtime.machineId)).toThrow('proof-invalid');expect(buffer.every(byte=>byte===0)).toBe(true);expect(()=>caches[1].chunk(key,f.runtime.machineId,0,caches[0].outboundChunk(part.key,f.peer.machineId,0))).toThrow('unknown');
 }finally{for(const cache of caches)cache.close();}
});
it('retains the original signed part across a genuine same-epoch native renewal',async()=>{
 const f=await setupGraphRuntimeFixture({ownedCustodyHostIndex:0}),current=f.runtime.actuation(),record=f.f.record('native-framing-renewal'),caches=[f.runtime,f.peer].map((runtime,index)=>new GraphOwnedControlFrameCache({stateDir:f.options[index].stateDir,agentId:'echo',identity:f.managers[index],authority:f.authorities[index],leaseCoordinator:f.options[index].leaseCoordinator,fence:runtime.localErasure}));
 try{const part=caches[0].createSourcePart({target:f.peer.machineId,commandHash:canonicalHash({renewal:'actual'}),packet:record.packet,packetSignature:record.packetSignature,controlCapsule:createGraphControlCapsule(record.coreType,record.core,record.authorizationProof),...current,bundle:record.encryptedSourceBundle!}),frozen=canonicalJson(part.plan);
  const clock=vi.spyOn(Date,'now').mockReturnValue(Date.parse(current.originalLease.expiresAt)+1000);try{expect(await f.options[0].leaseCoordinator.renew()).toBe(true);const renewed=f.options[0].leaseCoordinator.currentLease()!;expect(renewed.epoch).toBe(current.originalLease.epoch);expect(renewed.signature).not.toBe(current.originalLease.signature);expect(f.leaseStores[1].refresh(renewed)).toBe(true);expect(()=>caches[1].begin(part.plan,f.runtime.machineId)).not.toThrow();expect(canonicalJson(part.plan)).toBe(frozen);}finally{clock.mockRestore();}
 }finally{for(const cache of caches)cache.close();}
});
