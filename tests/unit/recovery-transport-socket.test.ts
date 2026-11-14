import {afterEach,describe,expect,it,vi} from 'vitest';
import http from 'node:http';import {channel} from 'node:diagnostics_channel';
import {recoveryFetchWithDestination,observeRecoveryTransport,type RecoveryPeerTarget} from '../../src/recovery/RecoveryClient.js';
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
describe('recovery proof transport comes from the actual request socket',()=>{
 it('captures real connection destinations for repeated requests, including pool reuse',async()=>{
  vi.stubEnv('NODE_USE_ENV_PROXY','0');
  const server=http.createServer((_req,res)=>res.end('ok'));
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{const address=server.address() as {port:number};
   for(let i=0;i<4;i++){
    const result=await recoveryFetchWithDestination(new URL(`http://127.0.0.1:${address.port}/proof-${i}`),{});
    expect(await result.response.text()).toBe('ok');expect(result.destination).toBe('127.0.0.1');
   }
  }finally{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
 });
 it('does not accept unrelated concurrent diagnostic events or invented DNS observations',async()=>{
  vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{
   channel('undici:client:sendHeaders').publish({headers:'x-instar-recovery-observation: unrelated\r\n',socket:{remoteAddress:'198.51.100.2',encrypted:true,authorized:true}});
   return new Response('ok');
  });
  expect((await recoveryFetchWithDestination(new URL('https://relay.invalid/'),{})).destination).toBeNull();
  await expect(observeRecoveryTransport({} as RecoveryPeerTarget,'relay')).rejects.toThrow('recovery-transport-observation-unavailable');
 });
 it('fails path qualification closed for effective proxy or unauthenticated TLS sockets',async()=>{
  let authorized=true;
  vi.spyOn(globalThis,'fetch').mockImplementation(async(_url,init)=>{
   const trace=new Headers(init?.headers).get('x-instar-recovery-observation');
   channel('undici:client:sendHeaders').publish({headers:`x-instar-recovery-observation: ${trace}\r\n`,socket:{remoteAddress:'198.51.100.2',encrypted:true,authorized}});
   return new Response('ok');
  });
  vi.stubEnv('NODE_USE_ENV_PROXY','1');vi.stubEnv('HTTPS_PROXY','http://proxy.invalid');
  expect((await recoveryFetchWithDestination(new URL('https://relay.invalid/'),{})).destination).toBeNull();
  vi.stubEnv('NODE_USE_ENV_PROXY','0');authorized=false;
  expect((await recoveryFetchWithDestination(new URL('https://relay.invalid/'),{})).destination).toBeNull();
  await expect(observeRecoveryTransport({} as RecoveryPeerTarget,'relay','127.0.0.1')).rejects.toThrow('recovery-transport-observation-unavailable');
 });
});
