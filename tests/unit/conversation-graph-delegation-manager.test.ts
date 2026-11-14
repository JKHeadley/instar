import {describe,it,expect,vi} from 'vitest';
import {ConversationGraphDelegationManager,type ConversationGraphDelegationAvailability} from '../../src/server/ConversationGraphDelegationManager.js';
import type {ConversationGraphReplicationRuntime} from '../../src/server/ConversationGraphReplicationRuntime.js';
// Lifecycle-only doubles: no authority/provenance conclusion from these tests.
const runtime=()=>({}) as ConversationGraphReplicationRuntime;
function ready(){return{status:'ready',local:{start:vi.fn(),close:vi.fn()},remote:{start:vi.fn(),close:vi.fn()}} as unknown as Extract<ConversationGraphDelegationAvailability,{status:'ready'}>;}
describe('lazy delegation composition publication lifecycle',()=>{
 it('stores promise synchronously before async factory installation and deduplicates publications',async()=>{
  const m=new ConversationGraphDelegationManager(),r=runtime(),value=ready(),factory=vi.fn(async()=>value);m.publish(r);const first=m.get();expect(m.get()).toBe(first);m.publish(r);expect(m.get()).toBe(first);m.setFactory(factory);expect(await first).toBe(value);expect(factory).toHaveBeenCalledOnce();expect(value.local.start).toHaveBeenCalledOnce();await m.close();expect(value.local.close).toHaveBeenCalledOnce();expect(value.remote!.close).toHaveBeenCalledOnce();expect(await m.get()).toMatchObject({status:'held'});
 });
 it('closes superseded initialization without starting it and does not resurrect an old runtime',async()=>{
  const m=new ConversationGraphDelegationManager(),a=runtime(),b=runtime(),av=ready(),bv=ready();let finish!:(v:ConversationGraphDelegationAvailability)=>void;
  m.setFactory(async r=>r===a?await new Promise(resolve=>{finish=resolve;}):bv);m.publish(a);const old=m.get();await Promise.resolve();await Promise.resolve();m.publish(b);expect(await m.get()).toBe(bv);finish(av);expect(await old).toMatchObject({status:'held'});expect(av.local.start).not.toHaveBeenCalled();expect(av.local.close).toHaveBeenCalledOnce();m.publish(a);expect(await m.get()).toBe(bv);await m.close();
 });
 it('close before factory installation unblocks waiting requests with explicit held status',async()=>{const m=new ConversationGraphDelegationManager();m.publish(runtime());const waiting=m.get();await m.close();expect(await waiting).toMatchObject({status:'held'});});
});
