// Accept-all round 4: a peer signs ONE request and offers it to each of the
// target's addresses in turn. When the target is slower than the sender's 5 s
// per-address timeout, the SAME signed bytes arrive again through the next
// address. Refusing that copy as a replay lost the answer every time
// ("Waiting for Mac M5 Pro to confirm" forever). These tests run the real
// runtime transport against one server listening on two real addresses.
import type {Server} from 'node:http';
import request from 'supertest';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {setupGraphRuntimeFixture as setup} from '../helpers/conversation-graph-runtime.js';

vi.setConfig({testTimeout:120_000});
const extra:Server[]=[];
afterEach(async()=>{await Promise.all(extra.splice(0).map(server=>new Promise<void>(resolve=>server.close(()=>resolve()))));});

async function secondAddress(fixture:Awaited<ReturnType<typeof setup>>){
 const {managers,apps,peer}=fixture;
 const server=await new Promise<Server>(resolve=>{const s=apps[1].listen(0,'0.0.0.0',()=>resolve(s));});extra.push(server);
 const address=server.address();if(!address||typeof address==='string')throw new Error('second-address-missing');
 const registry=managers[0].loadRegistry(),entry=registry.machines[peer.machineId];
 const first=new URL(entry.endpoints[0].url);entry.endpoints.push({kind:'lan',url:`http://${first.hostname}:${address.port}`});managers[0].saveRegistry(registry);
 return entry.endpoints.map(row=>row.url);
}

describe('graph peer request offered through two addresses of one machine',()=>{
 it('answers the second copy of a slow request with the first copy\'s result, and runs the work once',async()=>{
  const fixture=await setup();const {runtime,peer}=fixture;
  const urls=await secondAddress(fixture);expect(urls).toHaveLength(2);
  let runs=0;peer.setCustodyTransitionHandler(async payload=>{runs++;await new Promise(resolve=>setTimeout(resolve,6500));return {received:payload,runs};});
  const bodies:string[]=[];const real=globalThis.fetch;const spy=vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{if(String(input).includes('/replicate'))bodies.push(String(init?.body));return real(input as never,init);});
  try{
   // Before the fix: copy 1 times out at 5 s, copy 2 is refused (graph-peer-replayed) -> graph-peer-unavailable.
   await expect(runtime.requestCustodyTransition(peer.machineId,{kind:'proof-request',nonce:'slow'})).resolves.toEqual({received:{kind:'proof-request',nonce:'slow'},runs:1});
  }finally{spy.mockRestore();}
  expect(bodies).toHaveLength(2);expect(bodies[0]).toBe(bodies[1]);expect(runs).toBe(1);
 });

 it('still refuses a request id reused with different bytes, and an exact late repeat gets the same signed answer',async()=>{
  const fixture=await setup();const {runtime,peer,apps}=fixture;
  let runs=0;peer.setCustodyTransitionHandler(async payload=>{runs++;return {received:payload};});
  let captured='';const real=globalThis.fetch;const spy=vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{if(String(input).includes('/replicate'))captured=String(init?.body);return real(input as never,init);});
  try{await runtime.requestCustodyTransition(peer.machineId,{kind:'proof-request',nonce:'once'});}finally{spy.mockRestore();}
  const send=(body:string)=>request(apps[1]).post('/internal/conversation-graph/replicate').set('Authorization','Bearer runtime-peer-auth').set('Content-Type','application/json').send(body);
  const again=await send(captured);expect(again.status).toBe(200);expect(again.body.body).toEqual({received:{kind:'proof-request',nonce:'once'}});expect(runs).toBe(1);
  const tampered=JSON.parse(captured);tampered.body={payload:{kind:'proof-request',nonce:'other'}};
  const refused=await send(JSON.stringify(tampered));expect(refused.status).toBe(409);expect(runs).toBe(1);
 });
});
