import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RelayServer } from '../../src/threadline/relay/RelayServer.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { recoveryKeyPair, signRecovery, OFFLINE_LEASE_MS, type RecoveryCertificate } from '../../src/recovery/RecoveryProtocol.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const P256_N=BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
function derSignature(raw: Buffer): string {
  const r=raw.subarray(0,32), s0=BigInt('0x'+raw.subarray(32).toString('hex'));
  const s=Buffer.from((s0>P256_N/2n?P256_N-s0:s0).toString(16).padStart(64,'0'),'hex');
  const integer=(b:Buffer)=> { let i=0; while(i<b.length-1&&b[i]===0)i++; b=b.subarray(i);if(b[0]&128)b=Buffer.concat([Buffer.from([0]),b]);return Buffer.concat([Buffer.from([2,b.length]),b]); };
  const payload=Buffer.concat([integer(r),integer(s)]);return Buffer.concat([Buffer.from([48,payload.length]),payload]).toString('base64url');
}
describe('recovery control plane in the actual Threadline HTTP server',()=> {
  let relay: RelayServer, dir: string, base: string;
  const root=recoveryKeyPair(),signer=recoveryKeyPair(),a=recoveryKeyPair(),b=recoveryKeyPair(),sa=recoveryKeyPair(),sb=recoveryKeyPair();
  const owner=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'}), ownerJwk=owner.publicKey.export({format:'jwk'});
  const ownerPublic=Buffer.concat([Buffer.from([4]),Buffer.from(ownerJwk.x!,'base64url'),Buffer.from(ownerJwk.y!,'base64url')]).toString('base64url');
  const deviceId='owner-device-1794'; const pairedHost='recovery.invalid';
  const now=Date.now(); const cert=signRecovery<RecoveryCertificate>({domain:'instar-recovery-certificate-v1',agentId:'throwaway',publicKey:signer.publicKey,generation:1,issuedAt:now-1_000,expiresAt:now+30*OFFLINE_LEASE_MS},root.privateKey);
  const authorities=()=>new Map([['throwaway',{certificate:cert,privateKey:signer.privateKey,owner:{deviceId,publicKey:ownerPublic,host:pairedHost,active:true}}]]);
  const start=async()=> { relay=new RelayServer({host:'127.0.0.1',port:0,registryDataDir:dir});relay.configureRecovery(authorities());await relay.start();base=`http://127.0.0.1:${relay.address!.port}`; };
  beforeAll(async()=>{dir=fs.mkdtempSync(path.join(os.tmpdir(),'recovery-relay-'));await start();});
  afterAll(async()=>{await relay.stop();SafeFsExecutor.safeRmSync(dir,{recursive:true,force:true,operation:'recovery-control-plane.test:cleanup'});});
  const post=async(route:string,body:unknown,headers:Record<string,string>={})=>fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:typeof body==='string'?body:JSON.stringify(body)});
  const ownerRequest=(body:unknown)=> {
    const raw=JSON.stringify(body),time=String(Date.now());
    const sig=derSignature(crypto.sign('sha256',Buffer.from(canonicalString(deviceId,pairedHost,'POST','/v1/recovery/owner',time,Buffer.from(raw))),{key:owner.privateKey,dsaEncoding:'ieee-p1363'}));
    return {raw,headers:{'x-device-id':deviceId,'x-device-time':time,'x-device-signature':sig}};
  };
  const grant=(machineId:string,publicKey:string,source:string,sshPublicKey:string,relayPublicKey:string,sequence=1)=>({action:'grant',agentId:'throwaway',machineId,publicKey,sequence,principals:[{machineId:source,pairingEpoch:1,generation:1,sshPublicKey,relayPublicKey}]});
  const control=(machineId:string,key:string,action:string,body:unknown)=>{
    // The protocol caps the signed lifetime at exactly 30s. Capture once: a
    // millisecond tick between two Date.now() calls otherwise signs 30,001ms.
    const issuedAt=Date.now();
    return signRecovery({domain:'instar-recovery-control-request-v1',agentId:'throwaway',machineId,action,body,nonce:crypto.randomBytes(32).toString('hex'),issuedAt,expiresAt:issuedAt+30_000},key);
  };
  it('never accepts a bearer token as an owner grant',async()=> {
    const r=await post('/v1/recovery/owner',grant('a',a.publicKey,'b',sb.publicKey,b.publicKey),{Authorization:'Bearer test'});expect(r.status).toBe(403);
  });
  it('accepts enrolled-owner signatures, persists enrollment and returns a signed checkpoint',async()=> {
    for(const body of [grant('a',a.publicKey,'b',sb.publicKey,b.publicKey),grant('b',b.publicKey,'a',sa.publicKey,a.publicKey)]){
      const req=ownerRequest(body); const r=await post('/v1/recovery/owner',req.raw,req.headers);expect(r.status,await r.text()).toBe(200);
    }
    const r=await post('/v1/recovery/checkpoint',control('b',b.privateKey,'checkpoint',{challenge:'f'.repeat(64)}));
    expect(r.status).toBe(200);const body=await r.json();expect(body.checkpoint.payload.targetMachineId).toBe('b');expect(body.checkpoint.payload.principals[0].machineId).toBe('a');
  });
  it('captures one timestamp and refuses a signed request over the exact freshness bound',async()=>{
    let time=Date.now();const clock=vi.spyOn(Date,'now').mockImplementation(()=>time++);
    let request:ReturnType<typeof control>;
    try{request=control('b',b.privateKey,'poll',{});}finally{clock.mockRestore();}
    expect(request.payload.expiresAt-request.payload.issuedAt).toBe(30_000);
    const valid=await post('/v1/recovery/poll',request);expect(valid.status,await valid.text()).toBe(200);
    const overlong=signRecovery({...request.payload,nonce:crypto.randomBytes(32).toString('hex'),expiresAt:request.payload.issuedAt+30_001},b.privateKey);
    const response=await post('/v1/recovery/poll',overlong);
    expect(response.status).toBe(403);expect(await response.json()).toEqual({error:'recovery-control-authentication-refused'});
  });
  it('routes opaque frames to the target, acknowledges delivery and rejects replays',async()=> {
    const req=control('a',a.privateKey,'send',{to:'b',id:'frame-1',payload:'opaque-signed-operation'});
    const r=await post('/v1/recovery/send',req);expect(r.status).toBe(200);expect((await r.json()).status).toBe('queued');
    expect((await post('/v1/recovery/send',req)).status).toBe(403);
    const poll=await post('/v1/recovery/poll',control('b',b.privateKey,'poll',{}));expect((await poll.json()).frames[0].payload).toBe('opaque-signed-operation');
    expect((await post('/v1/recovery/ack',control('b',b.privateKey,'ack',{id:'frame-1'}))).status).toBe(200);
    const repeat=await post('/v1/recovery/send',control('a',a.privateKey,'send',{to:'b',id:'frame-1',payload:'opaque-signed-operation'}));expect((await repeat.json()).status).toBe('delivered');
  });
  it('keeps streaming after more than 128 acknowledged frames while enforcing pending-only capacity',async()=>{
    for(let index=0;index<80;index++){
      for(const [from,key,to]of [['a',a.privateKey,'b'],['b',b.privateKey,'a']] as const){
        const id=`stream-${from}-${index}`,payload='opaque-'+id+'x'.repeat(1000);
        const queued=await post('/v1/recovery/send',control(from,key,'send',{to,id,payload}));expect(queued.status,await queued.text()).toBe(200);
        const receiverKey=to==='a'?a.privateKey:b.privateKey;
        if(index%10===0){const frames=await(await post('/v1/recovery/poll',control(to,receiverKey,'poll',{}))).json();expect(frames.frames.some((frame:any)=>frame.id===id)).toBe(true);}
        const ack=await post('/v1/recovery/ack',control(to,receiverKey,'ack',{id}));expect(ack.status,await ack.text()).toBe(200);
      }
    }
    const pending=relay.registry.recoveryRead('mail:throwaway') as any[],acknowledged=relay.registry.recoveryRead('mail-acks:throwaway') as any[];
    expect(pending).toHaveLength(0);expect(acknowledged.length).toBeGreaterThan(128);expect(acknowledged.every(frame=>!('payload'in frame)&&/^[a-f0-9]{64}$/.test(frame.payloadDigest))).toBe(true);
    await relay.stop();await start();
    const again=await post('/v1/recovery/send',control('a',a.privateKey,'send',{to:'b',id:'stream-a-0',payload:'opaque-stream-a-0'+'x'.repeat(1000)}));expect((await again.json()).status).toBe('delivered');
    expect((await post('/v1/recovery/send',control('a',a.privateKey,'send',{to:'b',id:'stream-a-0',payload:'rebound'}))).status).toBe(403);
    for(let index=0;index<16;index++)expect((await post('/v1/recovery/send',control('a',a.privateKey,'send',{to:'b',id:'pending-'+index,payload:'pending'}))).status).toBe(200);
    expect((await post('/v1/recovery/send',control('a',a.privateKey,'send',{to:'b',id:'pending-overflow',payload:'pending'}))).status).toBe(403);
    for(let index=0;index<16;index++)expect((await post('/v1/recovery/ack',control('b',b.privateKey,'ack',{id:'pending-'+index}))).status).toBe(200);
  });

  it('acknowledges an installed checkpoint without requiring a mailbox message',async()=> {
    const response=await post('/v1/recovery/checkpoint',control('b',b.privateKey,'checkpoint',{challenge:'c'.repeat(64)}));
    const {checkpoint}=await response.json();
    const ack=await post('/v1/recovery/checkpoint-ack',control('b',b.privateKey,'checkpoint-ack',{checkpointVersion:checkpoint.payload.version}));
    expect(ack.status).toBe(200);
    const inspect=ownerRequest({action:'inspect',agentId:'throwaway',machineId:'b'});
    const state=await (await post('/v1/recovery/owner',inspect.raw,inspect.headers)).json();
    expect(state.target.acknowledgement).toBe(checkpoint.payload.version);
    expect((await post('/v1/recovery/checkpoint-ack',control('b',b.privateKey,'checkpoint-ack',{checkpointVersion:checkpoint.payload.version+1}))).status).toBe(403);
  });

  it('revokes either transport independently and ordinary grants never clear a route removal',async()=>{
    const change=async(action:string,route:string,sequence:number)=>{const req=ownerRequest({action,route,sequence,agentId:'throwaway',machineId:'b'});return post('/v1/recovery/owner',req.raw,req.headers);};
    expect((await change('revoke-route','ssh',2)).status).toBe(200);
    let cp=await(await post('/v1/recovery/checkpoint',control('b',b.privateKey,'checkpoint',{challenge:'1'.repeat(64)}))).json();expect(cp.checkpoint.payload.disabledRoutes).toEqual(['ssh']);
    const again=ownerRequest(grant('b',b.publicKey,'a',sa.publicKey,a.publicKey,3));expect((await post('/v1/recovery/owner',again.raw,again.headers)).status).toBe(200);
    cp=await(await post('/v1/recovery/checkpoint',control('b',b.privateKey,'checkpoint',{challenge:'2'.repeat(64)}))).json();expect(cp.checkpoint.payload.disabledRoutes).toEqual(['ssh']);
    expect((await change('regrant-route','ssh',3)).status).toBe(403);
    expect((await change('regrant-route','shell',4)).status).toBe(403);
    expect((await change('regrant-route','ssh',4)).status).toBe(200);
    cp=await(await post('/v1/recovery/checkpoint',control('b',b.privateKey,'checkpoint',{challenge:'3'.repeat(64)}))).json();expect(cp.checkpoint.payload.disabledRoutes).toEqual([]);
    expect((await change('revoke-route','relay',5)).status).toBe(200);
    cp=await(await post('/v1/recovery/checkpoint',control('b',b.privateKey,'checkpoint',{challenge:'4'.repeat(64)}))).json();expect(cp.checkpoint.payload.disabledRoutes).toEqual(['relay']);
  });

  it('requires an explicit fresh owner event for repair rearm and preserves it on renewal and route enable',async()=>{
    const ownerCall=async(body:unknown)=>{const req=ownerRequest(body);return post('/v1/recovery/owner',req.raw,req.headers);};
    const rearm={action:'rearm-repair',agentId:'throwaway',machineId:'b',sequence:6};
    expect((await ownerCall({...rearm,repairEpoch:-1})).status).toBe(403);
    const response=await ownerCall(rearm);expect(response.status).toBe(200);expect(await response.json()).toMatchObject({state:'pending-on-target',repairEpoch:1});
    expect((await ownerCall(rearm)).status).toBe(403);
    for(const challenge of ['5','6']){const result=await(await post('/v1/recovery/checkpoint',control('b',b.privateKey,'checkpoint',{challenge:challenge.repeat(64)}))).json();expect(result.checkpoint.payload.repairEpoch).toBe(1);}
    expect((await ownerCall(grant('b',b.publicKey,'a',sa.publicKey,a.publicKey,7))).status).toBe(200);
    expect((await ownerCall({action:'regrant-route',agentId:'throwaway',machineId:'b',route:'relay',sequence:8})).status).toBe(200);
    let result=await(await post('/v1/recovery/checkpoint',control('b',b.privateKey,'checkpoint',{challenge:'7'.repeat(64)}))).json();expect(result.checkpoint.payload.repairEpoch).toBe(1);
    expect((await ownerCall({...rearm,sequence:9,repairEpoch:0})).status).toBe(403);
    expect((await ownerCall({...rearm,sequence:9})).status).toBe(200);
    result=await(await post('/v1/recovery/checkpoint',control('b',b.privateKey,'checkpoint',{challenge:'8'.repeat(64)}))).json();expect(result.checkpoint.payload.repairEpoch).toBe(2);
  });

  it('persists owner sequence and revocation across relay restart',async()=> {
    const stale=ownerRequest(grant('b',b.publicKey,'a',sa.publicKey,a.publicKey,1));
    const revoke=ownerRequest({action:'revoke',agentId:'throwaway',machineId:'b',sourceMachineId:'a',sequence:10});
    const r=await post('/v1/recovery/owner',revoke.raw,revoke.headers);expect(r.status).toBe(200);expect((await r.json()).state).toBe('pending-on-target');
    await relay.stop();await start();
    expect((await post('/v1/recovery/owner',stale.raw,stale.headers)).status).toBe(403);
    expect((await post('/v1/recovery/send',control('a',a.privateKey,'send',{to:'b',id:'revoked-frame',payload:'opaque'}))).status).toBe(403);
    const cp=await post('/v1/recovery/checkpoint',control('b',b.privateKey,'checkpoint',{challenge:'a'.repeat(64)}));expect((await cp.json()).checkpoint.payload.revoked).toEqual(['a']);
  });
});

describe('recovery phone commissioning and current owner revocation',()=>{
  let relay:RelayServer,dir:string,base:string;
  const root=recoveryKeyPair(),signer=recoveryKeyPair();const now=Date.now();
  let cert=signRecovery<RecoveryCertificate>({domain:'instar-recovery-certificate-v1',agentId:'phone-test',publicKey:signer.publicKey,generation:1,issuedAt:now-1000,expiresAt:now+OFFLINE_LEASE_MS},root.privateKey);
  let token=crypto.randomBytes(32).toString('base64url');
  const phone=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'}),jwk=phone.publicKey.export({format:'jwk'});
  const publicKey=Buffer.concat([Buffer.from([4]),Buffer.from(jwk.x!,'base64url'),Buffer.from(jwk.y!,'base64url')]).toString('base64url');
  const deviceId='phone-device-test';
  const start=async()=>{relay=new RelayServer({host:'127.0.0.1',port:0,registryDataDir:dir});relay.configureRecovery(new Map([['phone-test',{certificate:cert,certificationRoot:root.publicKey,privateKey:signer.privateKey,enrollment:{tokenHash:crypto.createHash('sha256').update(token).digest('hex'),issuedAt:now,expiresAt:now+15*60_000,host:'recovery.invalid'}}]]));await relay.start();base=`http://127.0.0.1:${relay.address!.port}`;};
  beforeAll(async()=>{dir=fs.mkdtempSync(path.join(os.tmpdir(),'recovery-phone-'));await start();});
  afterAll(async()=>{await relay.stop();SafeFsExecutor.safeRmSync(dir,{recursive:true,force:true,operation:'recovery-phone.test:cleanup'});});
  const signed=async(route:string,action:unknown)=>{const raw=JSON.stringify(action),time=String(Date.now());const sig=derSignature(crypto.sign('sha256',Buffer.from(canonicalString(deviceId,'recovery.invalid','POST',route,time,Buffer.from(raw))),{key:phone.privateKey,dsaEncoding:'ieee-p1363'}));return fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json','x-device-id':deviceId,'x-device-time':time,'x-device-signature':sig},body:raw});};
  it('serves a CSP-bound phone console without including host credentials',async()=>{const r=await fetch(base+'/v1/recovery/phone');expect(r.status).toBe(200);expect(r.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");const html=await r.text();expect(html).toContain('Your private signing key stays on this phone.');expect(html).not.toContain(token);expect(html).not.toContain(signer.privateKey);});
  it('requires possession of the one-use enrollment token and phone signing key',async()=>{const body={agentId:'phone-test',deviceId,publicKey,token};const unsigned=await fetch(base+'/v1/recovery/owner-enroll',{method:'POST',body:JSON.stringify(body)});expect(unsigned.status).toBe(403);expect((await signed('/v1/recovery/owner-enroll',{...body,token:'incorrect'})).status).toBe(403);expect((await signed('/v1/recovery/owner-enroll',body)).status).toBe(200);await relay.stop();await start();expect((await signed('/v1/recovery/owner-enroll',body)).status).toBe(403);});
  it('persists owner revocation and never resurrects it from boot enrollment config',async()=>{expect((await signed('/v1/recovery/owner',{agentId:'phone-test',action:'inspect',machineId:'target'})).status).toBe(200);expect((await signed('/v1/recovery/owner',{agentId:'phone-test',action:'revoke-owner'})).status).toBe(200);await relay.stop();await start();expect((await signed('/v1/recovery/owner',{agentId:'phone-test',action:'inspect',machineId:'target'})).status).toBe(403);expect((await signed('/v1/recovery/owner-enroll',{agentId:'phone-test',deviceId,publicKey,token})).status).toBe(403);});
  it('replaces a lost phone only with a new release-certified generation and fresh host capability',async()=>{
    await relay.stop();
    cert=signRecovery<RecoveryCertificate>({...cert.payload,generation:2},root.privateKey);
    await start();
    expect((await signed('/v1/recovery/owner-enroll',{agentId:'phone-test',deviceId,publicKey,token})).status).toBe(403);
    await relay.stop();token=crypto.randomBytes(32).toString('base64url');await start();
    expect((await signed('/v1/recovery/owner-enroll',{agentId:'phone-test',deviceId,publicKey,token})).status).toBe(200);
    expect((await signed('/v1/recovery/owner',{agentId:'phone-test',action:'inspect',machineId:'target'})).status).toBe(200);
  });

});
