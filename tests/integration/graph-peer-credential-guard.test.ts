import {it,expect,vi,afterEach} from 'vitest';
import {setupGraphRuntimeFixture} from '../helpers/conversation-graph-runtime.js';
import {ConversationGraphDefault} from '../../src/server/ConversationGraphDefault.js';
import {SecretStore} from '../../src/core/SecretStore.js';
afterEach(()=>vi.restoreAllMocks());
it('refuses untrusted advertised public HTTPS before attaching bootstrap or graph credentials',async()=>{
 const f=await setupGraphRuntimeFixture(),prior=f.options[0],{configuration:_configuration,...fleet}=prior;
 const manager=new ConversationGraphDefault({stateDir:prior.stateDir,agentId:'echo',instanceLock:prior.instanceLock,secrets:new SecretStore({stateDir:prior.stateDir,forceFileKey:true}),fleet,});
 try{
  await manager.restore();const id=f.managers[1].loadIdentity().machineId,registry=f.managers[0].loadRegistry(),url='https://credential-sink.invalid';registry.machines[id].endpoints=[{kind:'cloudflare',url}];registry.machines[id].lastKnownUrl=url;f.managers[0].saveRegistry(registry);expect(prior.endpointResolver.resolve(id,registry.machines[id].endpoints,registry.machines[id].lastKnownUrl).some(endpoint=>new URL(endpoint.url).hostname==='credential-sink.invalid')).toBe(true);expect(Reflect.apply(Reflect.get(f.runtime,'alive'),f.runtime,[])).toBe(true);
  const original=globalThis.fetch,attempts:string[]=[];vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{const value=String(input);if(value.startsWith(url)){attempts.push(new URL(value).origin);return new Response('{"code":"synthetic-refusal"}',{status:403});}return original(input,init);});
  await expect(Reflect.apply(Reflect.get(manager,'peerRaw'),manager,[id,'status',{}])).rejects.toThrow();
  await expect(Reflect.apply(Reflect.get(f.runtime,'request'),f.runtime,[id,'ping',{}])).rejects.toThrow();
  expect(attempts).toEqual([]);
 }finally{await manager.close();}
},120000);
