import {expect,it} from 'vitest';
import {GraphSourceCapacityLedger} from '../../src/core/GraphSourceCapacityLedger.js';
import {canonicalHash} from '../../src/core/GraphWitnessTypes.js';
import {setupGraphRuntimeFixture as setup} from '../helpers/conversation-graph-runtime.js';
it('constructs and binds actual local capacity ledgers through Runtime on both original Source nodes',async()=>{
 // Synthetic declared test policy, not a proposed production default or a
 // promise of future disk space / full recovery capacity.
 const policy={v:1 as const,durableBytes:256*1024*1024,transientBytes:128*1024*1024,metadataBytes:32*1024*1024,futureSidecarBytesPerRecord:65536,futureRowOverheadBytes:65536};
 const f=await setup({ownedCustodyHostIndex:0,localCapacityPolicy:policy});
 expect(f.runtime.localSourceCapacityLedger).toBeInstanceOf(GraphSourceCapacityLedger);expect(f.peer.localSourceCapacityLedger).toBeInstanceOf(GraphSourceCapacityLedger);
 expect(f.runtime.localSourceCapacityLedger).not.toBe(f.peer.localSourceCapacityLedger);expect(f.runtime.localSourceCapacityLedger!.policyHash).toBe(canonicalHash(policy));
 expect(await f.runtime.refreshReadiness()).toBe(true);expect(await f.peer.refreshReadiness()).toBe(true);
 const record=f.f.record('explicit-runtime-credit');const result=await f.runtime.withSourceMutation(token=>f.runtime.submitPrepared({coreType:record.coreType,idempotencyKey:record.packet.idempotencyKey,requestHash:canonicalHash('explicit-runtime-credit'),core:record.core,authorizationProof:record.authorizationProof,plaintextSource:Buffer.from('synthetic bounded source')},token));expect(result.state).toBe('committed');
 for(const runtime of [f.runtime,f.peer]){const stored=runtime.source.lookupByIdempotencyKey(record.packet.idempotencyKey)!;expect(runtime.source.retainedOriginalSourceReceipt(stored.packet.eventId)?.phase).toBe('source');const state=runtime.localSourceCapacityLedger!.inspect();expect(state.reservedBytes).toBeGreaterThan(0);expect(state.logicalWithinPolicy).toBe(true);expect(state.physicalHeadroomProven).toBe(false);expect(state.futureRecoveryReady).toBe(false);}
},120000);
