/** Compatibility signing paths must clear their OWN cloned sealed-key views,
 * even though production pinning now uses the actual retained reader. */
import fs from 'node:fs';import path from 'node:path';
import {observeFixturePerformance} from '../helpers/conversation-graph-live-performance.mjs';
import {it,expect,vi} from 'vitest';
import {setupGraphDefaultPlannedTransition} from '../helpers/graph-default-planned-transition.js';
import {GraphCustodyActivationPinStore} from '../../src/core/GraphCustodyActivationPinStore.js';
import type {GraphSourceTransferStage} from '../../src/core/ConversationGraphReplicationTransfer.js';
it('clears v1 ordinary pin clones and detached envelopes during an awaited import before purge returns',async()=>{
 const observer=process.env.GRAPH_PIN_DIAGNOSTIC_PERF==='1'?observeFixturePerformance(fs.mkdtempSync(path.join(process.cwd(),'.instar/state/build/graph-ordinary-pin-perf-'))):null;try{
 const began=Date.now(),phase=(name:string)=>console.info('ordinary-pin-phase',JSON.stringify({name,elapsedMs:Date.now()-began}));phase('fixture-start');
 const f=await setupGraphDefaultPlannedTransition({onPhase:phase,skipReadinessForComponentProof:true}),manager=f.defaults[0],runtime=manager.runtime!,authority=manager.memberLossPlanningComponents()!.authority,native=manager.nativeDelegationDependencies!,reader=await runtime.transfer.openRetainedCustodyStage(f.activation,authority),records:GraphSourceTransferStage['records']=[],rewraps:GraphSourceTransferStage['rewraps']=[];
 phase('reader-open');let release!:()=>void,entered!:()=>void;const blocked=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});let captured:GraphSourceTransferStage|undefined;
 try{
  phase('reader-iterate');expect(reader.count).toBe(2);for await(const row of reader.recordsInManifestOrder()){records.push(row.record);if(row.newRewrap)rewraps.push({eventId:row.record.packet.eventId,rewrap:row.newRewrap});}
  const stage:GraphSourceTransferStage={...reader.metadata,records,rewraps},sourceBundle=records[0].encryptedSourceBundle!;expect(sourceBundle).not.toBeNull();
  const importActual=vi.spyOn(runtime.transfer,'postActivationTransferReceipt').mockImplementationOnce(async value=>{captured=value;phase('compatibility-import-entered');entered();await blocked;throw new Error('test-ordinary-pin-denied-after-await');});
  const pending=new GraphCustodyActivationPinStore({stateDir:authority.stateRoot,identity:native.identity,identities:native.identities,authority,transfer:runtime.transfer}).pin(f.transition,f.activation,stage),rejected=expect(pending).rejects.toThrow('test-ordinary-pin-denied-after-await');
  try{
   phase('compatibility-pin-called');await started;const held=captured!.records[0],bundle=held.encryptedSourceBundle!,detached=bundle.envelopes[0],newEnvelope=captured!.rewraps.find(row=>row.eventId===held.packet.eventId)!.rewrap;
   expect(bundle).not.toBe(sourceBundle);expect(detached.ephemeralPublicKey).toBeTruthy();expect(newEnvelope.envelopes.length).toBeGreaterThan(0);
   phase('priority-deny-start');await runtime.eraseLocal(held.packet.erasureIdentity);
   phase('priority-deny-returned');expect(held.encryptedSourceBundle).toBeNull();expect(detached.ephemeralPublicKey??null).toBeNull();expect(Object.keys(newEnvelope)).toHaveLength(0);await runtime.transfer.assertLocalErasurePurged(held.packet.erasureIdentity);
   release();await rejected;
  }finally{release();importActual.mockRestore();}
 }finally{release();reader.close();await f.cleanup();}
 }finally{if(observer)console.info('ordinary-pin-performance',JSON.stringify(observer.snapshot()));observer?.close();}
},120000);
