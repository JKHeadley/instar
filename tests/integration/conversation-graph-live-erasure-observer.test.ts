/** Actual signed coordinator ingress, not fresh phone admission (covered separately). */
import {it,expect} from 'vitest';
import {setupGraphRuntimeFixture} from '../helpers/conversation-graph-runtime.js';
import {observeGraphFixtureErasures} from '../helpers/conversation-graph-live-observer.mjs';
import {canonicalHash} from '../../src/core/GraphWitnessTypes.js';
it('finds actual server-assigned durable erasure with no request-body ID; bare local deny creates no erasure verdict',async()=>{
 const f=await setupGraphRuntimeFixture({ownedCustodyHostIndex:0}),target={sourceKind:'header' as const,sourceId:'observer-assigned-header'},requestId='erasev1_'+canonicalHash({agentId:'echo',principalKey:'owner:echo',headerId:target.sourceId});
 await f.runtime.erasure.acceptOwner({requestId,target,principalKey:'owner:echo',authenticationMethod:'owner-device'});
 const observed=await observeGraphFixtureErasures(f.runtime,'echo',new Set());expect(observed.erasures).toEqual(expect.arrayContaining([expect.objectContaining({requestId,state:expect.objectContaining({localHidden:true,fleetComplete:false})})]));expect(observed.erasureDiscoveryDebt).toEqual([]);
 const onlyLocal={sourceKind:'header' as const,sourceId:'observer-local-only-header'};await f.runtime.eraseLocal(onlyLocal);
 const again=await observeGraphFixtureErasures(f.runtime,'echo',new Set());expect(again.localErasureTargets).toContainEqual(onlyLocal);expect(again.erasures).toHaveLength(1);expect(again.erasures[0].requestId).toBe(requestId);expect(again.erasureInventoryPartial).toBe(false);
},120000);
