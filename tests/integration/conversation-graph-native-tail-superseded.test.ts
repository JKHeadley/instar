/** A reservation superseded by a saved, certified record is retired and never blocks the native tail
 * (accept-all round 2, 11-16). Real two-machine throwaway: the M5 held the lease for a moment while the Studio was
 * frozen and reserved its own copy of a source observation the Studio had already recorded (same idempotency key,
 * its own sequence). Restore never admits it, but every native-tail reader counted it: each tail-close refused with
 * graph-native-tail-conflict and all owner writes stayed "Saved here" indefinitely. Real two-member runtime. */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {describe,expect,it,vi} from 'vitest';
import {canonicalHash} from '../../src/core/GraphWitnessTypes.js';
import {setupGraphRuntimeFixture as setup} from '../helpers/conversation-graph-runtime.js';

vi.setConfig({testTimeout:120_000});

describe('native tail with a superseded reservation',()=>{
 it('retires a reservation whose key is already saved and certified with a different packet, so tails close again',async()=>{
  const {f,runtime,peer,options}=await setup();
  expect(await runtime.refreshReadiness()).toBe(true);expect(await peer.refreshReadiness()).toBe(true);
  const id='native-tail-superseded-a',r=f.record(id);
  expect((await runtime.withSourceMutation(token=>runtime.submitPrepared({coreType:r.coreType,idempotencyKey:r.packet.idempotencyKey,requestHash:canonicalHash(id),
   core:r.core,authorizationProof:r.authorizationProof,plaintextSource:Buffer.from('superseded source')},token))).state).toBe('committed');
  const saved=runtime.source.lookupByIdempotencyKey(r.packet.idempotencyKey)!;
  expect(saved.certificate).toBeTruthy();

  // The same operation reserved again under another sequence: a fully signed copy, what the frozen-writer case left.
  const copy=f.record(id,saved.packet.sourceSequence+40,saved.packet.coreHash);
  expect(copy.packet.idempotencyKey).toBe(saved.packet.idempotencyKey);
  expect(canonicalHash(copy.packet)).not.toBe(canonicalHash(saved.packet));
  const dir=path.join(options[0].stateDir,'state','conversation-graph-intake');await fs.mkdir(dir,{recursive:true});
  const file=path.join(dir,crypto.createHash('sha256').update(copy.packet.idempotencyKey).digest('hex')+'.json');
  const {coreType,packet,packetSignature,core,authorizationProof,encryptedSourceBundle}=copy;
  await fs.writeFile(file,JSON.stringify({v:1,requestHash:canonicalHash('stale copy'),record:{coreType,packet,packetSignature,core,authorizationProof,encryptedSourceBundle}}),{mode:0o600});
  expect((await runtime.intake.reservations()).map(x=>x.packet.sourceSequence)).toContain(copy.packet.sourceSequence);

  const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
  try{
   const {lease,originalLease}=runtime.actuation();
   const snapshot=(runtime as unknown as {snapshotNativeTail(l:unknown,o:unknown):Promise<{entries:Array<{sourceSequence:number}>}>}).snapshotNativeTail.bind(runtime);
   const closure=await snapshot(lease,originalLease);
   expect(closure.entries.some(e=>e.sourceSequence===copy.packet.sourceSequence)).toBe(false);
   // Retired durably: every other reader (own-tail checks, new reservations) no longer sees it.
   await expect(fs.access(file)).rejects.toThrow();
   expect((await runtime.intake.nativeTailReservations()).some(x=>x.packet.sourceSequence===copy.packet.sourceSequence)).toBe(false);
   expect(warn.mock.calls.some(c=>String(c[0]).includes('retired a superseded reservation'))).toBe(true);
  }finally{warn.mockRestore();}
 });

 it('leaves the reservation alone while the saved record is not certified (it could still be canceled)',async()=>{
  const {f,runtime,peer,options}=await setup();
  expect(await runtime.refreshReadiness()).toBe(true);expect(await peer.refreshReadiness()).toBe(true);
  const id='native-tail-superseded-b',r=f.record(id);
  expect((await runtime.withSourceMutation(token=>runtime.submitPrepared({coreType:r.coreType,idempotencyKey:r.packet.idempotencyKey,requestHash:canonicalHash(id),
   core:r.core,authorizationProof:r.authorizationProof,plaintextSource:Buffer.from('pending source')},token))).state).toBe('committed');
  const saved=runtime.source.lookupByIdempotencyKey(r.packet.idempotencyKey)!;
  const copy=f.record(id,saved.packet.sourceSequence+40,saved.packet.coreHash);
  const dir=path.join(options[0].stateDir,'state','conversation-graph-intake');await fs.mkdir(dir,{recursive:true});
  const file=path.join(dir,crypto.createHash('sha256').update(copy.packet.idempotencyKey).digest('hex')+'.json');
  const {coreType,packet,packetSignature,core,authorizationProof,encryptedSourceBundle}=copy;
  await fs.writeFile(file,JSON.stringify({v:1,requestHash:canonicalHash('stale copy'),record:{coreType,packet,packetSignature,core,authorizationProof,encryptedSourceBundle}}),{mode:0o600});
  const lookup=vi.spyOn(runtime.source,'lookupByIdempotencyKey').mockImplementation(()=>({...saved,certificate:undefined}) as typeof saved);
  try{
   const {lease,originalLease}=runtime.actuation();
   const snapshot=(runtime as unknown as {snapshotNativeTail(l:unknown,o:unknown):Promise<unknown>}).snapshotNativeTail.bind(runtime);
   await expect(snapshot(lease,originalLease)).rejects.toThrow('graph-native-tail-conflict');
   await expect(fs.access(file)).resolves.toBeUndefined();
  }finally{lookup.mockRestore();}
 });
});
