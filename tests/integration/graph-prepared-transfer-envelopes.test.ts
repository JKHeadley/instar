import {describe,it,expect,vi} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {setupHeldGraphSourceFixture} from '../helpers/conversation-graph-held-source.js';
import {canonicalHash} from '../../src/core/GraphWitnessTypes.js';
import {GraphPreparedTransferEnvelopes} from '../../src/core/GraphPreparedTransferEnvelopes.js';

describe('actual preauthorization envelope custody',()=>{
 it('persists randomized keys once, reuses exact hashes, and purges exposed keys on priority deny',async()=>{
  const f=await setupHeldGraphSourceFixture({applicationSource:Buffer.alloc(400*1024,0x61)}),context={authority:f.authorities[0],hold:{kind:'planned' as const,intent:f.intent,nativeFloor:f.nativeFloor,lease:f.native.lease,originalLease:f.native.originalLease}},options={recoveryId:'prepared-envelope-real-resume',source:f.sourceReader,context,newMembership:f.newMembership,coordinator:f.options[0].leaseCoordinator};
  let first:GraphPreparedTransferEnvelopes|undefined,second:GraphPreparedTransferEnvelopes|undefined;
  try{
   first=await f.runtime.transfer.prepareHeldRewrapInventory(options);expect(first).toBeInstanceOf(GraphPreparedTransferEnvelopes);const inventory=first.inventory();expect(inventory).toHaveLength(1);expect(inventory[0].rewrapHash).not.toBe(canonicalHash(null));first.assertForSource(f.sourceReader,options.recoveryId,f.newMembership);expect(()=>first!.assertForSource(f.sourceReader,'different-recovery',f.newMembership)).toThrow();
   second=await f.runtime.transfer.prepareHeldRewrapInventory(options);expect(second.inventory()).toEqual(inventory);
   const custody=path.join(f.managers[0].baseDir,'state','conversation-graph-transfer'),proofFile=path.join(custody,canonicalHash({agentId:'echo',recoveryId:options.recoveryId})+'.preparation.json'),proofBytes=await fs.readFile(proofFile);const invalid={...JSON.parse(proofBytes.toString()),unexpectedPrivate:'must-preserve-unknown-proof'};await fs.writeFile(proofFile,JSON.stringify(invalid));await expect(f.runtime.transfer.prepareHeldRewrapInventory(options)).rejects.toThrow();expect(await fs.readFile(proofFile,'utf8')).toContain('must-preserve-unknown-proof');await fs.writeFile(proofFile,proofBytes);
   const iterator=second.envelopes()[Symbol.asyncIterator](),next=await iterator.next();expect(next.done).toBe(false);const key=next.value!.rewrap!;expect(canonicalHash(key)).toBe(inventory[0].rewrapHash);expect(key.envelopes.length).toBe(f.newMembership.members.length);
   await f.runtime.localErasure.deny(f.original.packet.erasureIdentity);f.runtime.transfer.purgePrivateStageViews(f.original.packet.erasureIdentity);expect(JSON.stringify(key)).not.toContain('ciphertext');await iterator.return?.();await f.runtime.transfer.eraseLocal(f.original.packet.erasureIdentity);await expect(f.runtime.transfer.assertLocalErasurePurged(f.original.packet.erasureIdentity)).resolves.toMatch(/^[a-f0-9]{64}$/);expect(()=>second!.inventory()).toThrow();
  }finally{first?.close();second?.close();f.sourceReader.close();}
 });
 it.each([1,2])('clears parsed prepared key at awaited close %i before it can be returned',async(readIndex)=>{
  const f=await setupHeldGraphSourceFixture(),context={authority:f.authorities[0],hold:{kind:'planned' as const,intent:f.intent,nativeFloor:f.nativeFloor,lease:f.native.lease,originalLease:f.native.originalLease}},options={recoveryId:'prepared-before-close-deny',source:f.sourceReader,context,newMembership:f.newMembership,coordinator:f.options[0].leaseCoordinator},first=await f.runtime.transfer.prepareHeldRewrapInventory(options),hash=first.inventory()[0].rewrapHash,file=path.join(f.managers[0].baseDir,'state','conversation-graph-transfer',canonicalHash({agentId:'echo',recoveryId:options.recoveryId})+'.parts',hash+'.rewrap.json');
  let enter!:()=>void,resume!:()=>void;const entered=new Promise<void>(resolve=>{enter=resolve;}),barrier=new Promise<void>(resolve=>{resume=resolve;}),actualOpen=fs.open.bind(fs),actualParse=JSON.parse;let captured:Record<string,unknown>|undefined,armed=false,blocked=false,keyReads=0;
  const parse=vi.spyOn(JSON,'parse').mockImplementation(((raw:string,...rest:unknown[])=>{const value=Reflect.apply(actualParse,JSON,[raw,...rest]);if(armed&&value?.eventId===f.original.packet.eventId&&value?.newMembershipHash===canonicalHash(f.newMembership))captured=value;return value;}) as typeof JSON.parse),open=vi.spyOn(fs,'open').mockImplementation((async(...args:Parameters<typeof fs.open>)=>{const handle=await actualOpen(...args);if(!blocked&&String(args[0])===file&&++keyReads===readIndex){armed=true;blocked=true;const close=handle.close.bind(handle);vi.spyOn(handle,'close').mockImplementation(async()=>{enter();await barrier;return close();});}return handle;}) as typeof fs.open);
  const pending=f.runtime.transfer.prepareHeldRewrapInventory(options);try{await entered;expect(captured).toBeDefined();expect(JSON.stringify(captured)).toContain('ciphertext');await f.runtime.localErasure.deny(f.original.packet.erasureIdentity);f.runtime.transfer.purgePrivateStageViews(f.original.packet.erasureIdentity);expect(Object.keys(captured!)).toEqual([]);}finally{resume();open.mockRestore();parse.mockRestore();await pending.catch(()=>undefined);first.close();f.sourceReader.close();}await expect(f.runtime.transfer.eraseLocal(f.original.packet.erasureIdentity)).resolves.toBeUndefined();
 });

});
