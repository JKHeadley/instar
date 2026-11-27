/** The owner's read view is built once and reused until the graph changes (accept-all round 2, 11-16):
 * every Conversations read used to rebuild and re-verify the whole graph four times, holding the
 * server for 3 to 9 seconds per read on a real agent. Real two-member runtime, real commits. */
import {describe,expect,it,vi} from 'vitest';
import {canonicalHash} from '../../src/core/GraphWitnessTypes.js';
import {ConversationGraphHeaderCustody} from '../../src/server/ConversationGraphHeaderCustody.js';
import {ConversationGraphRuntimeReadSource} from '../../src/server/ConversationGraphReadSource.js';
import {ConversationGraphReadModel} from '../../src/core/conversationGraphRead.js';
import {setupGraphRuntimeFixture as setup} from '../helpers/conversation-graph-runtime.js';

vi.setConfig({testTimeout:120_000});
// A view is never reused while a durable write is still settling (its caller updates the record after it resolves).
const settle=async()=>{for(let i=0;i<3;i++)await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setTimeout(resolve,50));};

describe('conversation graph read view cache',()=>{
 it('reuses one verified view until a commit, a peer change, a lost member or 15 s',async()=>{
  const {f,runtime,peer,managers}=await setup();
  expect(await runtime.refreshReadiness()).toBe(true);expect(await peer.refreshReadiness()).toBe(true);
  const submit=(id:string)=>{const r=f.record(id);return runtime.withSourceMutation(token=>runtime.submitPrepared({coreType:r.coreType,idempotencyKey:r.packet.idempotencyKey,
   requestHash:canonicalHash(id),core:r.core,authorizationProof:r.authorizationProof,plaintextSource:Buffer.from('read view source '+id)},token));};
  expect((await submit('read-view-cache-a')).state).toBe('committed');
  await settle();

  const union=vi.spyOn(runtime.source,'certifiedUnion');
  const first=runtime.readView();
  // One union for the whole view (it used to be four: projection, inventory, its projection, coverage).
  expect(union).toHaveBeenCalledTimes(1);
  expect(runtime.readView()).toBe(first);
  expect(union).toHaveBeenCalledTimes(1);
  expect(first.retained.records.map(r=>r.packet.idempotencyKey)).toContain(f.record('read-view-cache-a').packet.idempotencyKey);

  // A durable commit is seen by the very next read.
  expect((await submit('read-view-cache-b')).state).toBe('committed');
  await settle();
  const second=runtime.readView();
  expect(second).not.toBe(first);
  expect(second.retained.records.map(r=>r.packet.idempotencyKey)).toContain(f.record('read-view-cache-b').packet.idempotencyKey);

  // Any own or peer stream file change (a peer's commit arrives this way) rebuilds the next read.
  expect(runtime.readView()).toBe(second);
  const streams=(runtime as unknown as {options:{peerStreams:{foldSignature(store:string):string|null}}}).options.peerStreams;
  const signature=vi.spyOn(streams,'foldSignature').mockReturnValue('a peer stream changed');
  const afterPeer=runtime.readView();
  expect(afterPeer).not.toBe(second);
  expect(runtime.readView()).toBe(afterPeer);
  // A stream state that cannot be read is never served from the cache.
  signature.mockReturnValue(null);
  expect(runtime.readView()).not.toBe(afterPeer);
  expect(runtime.readView()).not.toBe(afterPeer);
  signature.mockRestore();

  // Time: coverage staleness is judged against the clock, so a view is never older than 15 s.
  const now=Date.now(),clock=vi.spyOn(Date,'now').mockReturnValue(now+16_000);
  try{expect(runtime.readView()).not.toBe(afterPeer);}finally{clock.mockRestore();}

  // A lost signed member withholds the view exactly as the uncached projection does.
  const registry=managers[0].loadRegistry();delete registry.machines[managers[1].loadIdentity().machineId];managers[0].saveRegistry(registry);
  expect(()=>runtime.retainedProjection()).toThrow();
  expect(()=>runtime.readView()).toThrow();
  union.mockRestore();
 });

 it('serves page reads from the shared view and verifies each event once per view',async()=>{
  const {f,runtime,peer,managers}=await setup();
  expect(await runtime.refreshReadiness()).toBe(true);expect(await peer.refreshReadiness()).toBe(true);
  const r=f.record('read-view-page-a');
  expect((await runtime.withSourceMutation(token=>runtime.submitPrepared({coreType:r.coreType,idempotencyKey:r.packet.idempotencyKey,requestHash:canonicalHash('read-view-page-a'),
   core:r.core,authorizationProof:r.authorizationProof,plaintextSource:Buffer.from('page source')},token))).state).toBe('committed');
  await settle();
  const source=new ConversationGraphRuntimeReadSource(runtime,new ConversationGraphHeaderCustody(managers[0].baseDir,runtime));
  const model=new ConversationGraphReadModel(source),owner={principalKey:'owner:echo',grantVersion:'fixture-owner',mayView:()=>true};
  const view=vi.spyOn(runtime,'readView'),verify=vi.spyOn(runtime.source,'verifyHistoricalRecord'),union=vi.spyOn(runtime.source,'certifiedUnion');
  expect(model.roots(owner,{view:'all'}).status).toBe(200);
  const verifiedOnce=verify.mock.calls.length;
  expect(model.roots(owner,{view:'all'}).status).toBe(200);
  expect(model.roots(owner,{view:'overview'}).status).toBe(200);
  // Each read pins one view and its own lookups are answered from that pin, so readView() is called
  // more than once per read; what matters is that all three reads saw the same view, built once.
  expect(view.mock.calls.length).toBeGreaterThanOrEqual(3);
  expect(new Set(view.mock.results.map(r=>r.value)).size).toBe(1);
  // Three reads, one union, and no event verified twice.
  expect(union).toHaveBeenCalledTimes(1);
  expect(verify.mock.calls.length).toBe(verifiedOnce);
  view.mockRestore();verify.mockRestore();union.mockRestore();
 });
 it('builds one view for a whole read even while writes keep the view key null',async()=>{
  const {f,runtime}=await setup();
  expect(await runtime.refreshReadiness()).toBe(true);
  const r=f.record('read-view-pin-a');
  expect((await runtime.withSourceMutation(token=>runtime.submitPrepared({coreType:r.coreType,idempotencyKey:r.packet.idempotencyKey,
   requestHash:canonicalHash('read-view-pin-a'),core:r.core,authorizationProof:r.authorizationProof,plaintextSource:Buffer.from('pin source')},token))).state).toBe('committed');
  await settle();
  // A write in flight makes the view key null, so nothing is cached between calls.
  vi.spyOn(runtime.source,'readViewMarker').mockReturnValue(null);
  const union=vi.spyOn(runtime.source,'certifiedUnion');
  runtime.readView();runtime.readView();
  expect(union).toHaveBeenCalledTimes(2);
  union.mockClear();
  const pinned=runtime.withPinnedReadView(()=>{const a=runtime.readView(),b=runtime.readView(),c=runtime.retainedForRead();expect(b).toBe(a);expect(c).toBe(a.retained);return a;});
  expect(union).toHaveBeenCalledTimes(1);
  // The pin ends with the call, also when it throws.
  expect(runtime.readView()).not.toBe(pinned);
  expect(()=>runtime.withPinnedReadView(()=>{throw new Error('read failed');})).toThrow('read failed');
  union.mockClear();runtime.readView();expect(union).toHaveBeenCalledTimes(1);
 });
});
