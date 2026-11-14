import {expect,it} from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import {JSDOM} from 'jsdom';
import {RelayServer} from '../../src/threadline/relay/RelayServer.js';
import {recoveryKeyPair,signRecovery,type RecoveryCertificate} from '../../src/recovery/RecoveryProtocol.js';
import {SafeFsExecutor} from '../../src/core/SafeFsExecutor.js';

it('executes the shipped phone console: nonexportable key, real signed enrollment, inspect and revoke',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'recovery-phone-console-')),root=recoveryKeyPair(),signer=recoveryKeyPair(),now=Date.now(),token=crypto.randomBytes(32).toString('base64url');
 const certificate=signRecovery<RecoveryCertificate>({domain:'instar-recovery-certificate-v1',agentId:'browser-test',publicKey:signer.publicKey,generation:1,issuedAt:now-1000,expiresAt:now+3600000},root.privateKey);
 const authority={certificate,privateKey:signer.privateKey,certificationRoot:root.publicKey,enrollment:{tokenHash:crypto.createHash('sha256').update(token).digest('hex'),issuedAt:now,expiresAt:now+900000,host:'127.0.0.1'}};
 const relay=new RelayServer({host:'127.0.0.1',port:0,registryDataDir:dir});relay.configureRecovery(new Map([['browser-test',authority]]));await relay.start();const base=`http://127.0.0.1:${relay.address!.port}`;authority.enrollment.host=new URL(base).host;
 let dom:JSDOM|undefined;
 try{
  const html=await(await fetch(base+'/v1/recovery/phone')).text(),target=recoveryKeyPair(),peerSsh=recoveryKeyPair(),peerRelay=recoveryKeyPair();const grant={action:'grant',agentId:'browser-test',machineId:'target-test',machineName:'Test Mac',peerNames:{paired:'Other Mac'},publicKey:target.publicKey,principals:[{machineId:'paired',pairingEpoch:1,generation:1,sshPublicKey:peerSsh.publicKey,relayPublicKey:peerRelay.publicKey}]};dom=new JSDOM(html,{url:base+'/v1/recovery/phone#'+new URLSearchParams({agent:'browser-test',token,request:Buffer.from(JSON.stringify(grant)).toString('base64url')}),runScripts:'outside-only'});const w=dom.window,values=new Map();
  Object.defineProperty(w,'crypto',{value:crypto.webcrypto});let loseEnrollmentReply=true,loseFirstGrant=true;Object.assign(w,{TextEncoder,TextDecoder,fetch:async(p:string,o:RequestInit)=>{if(p==='/v1/recovery/owner-enroll'&&loseEnrollmentReply){loseEnrollmentReply=false;await fetch(base+p,o);throw Error('Enrollment response lost.');}if(p==='/v1/recovery/owner'&&JSON.parse(String(o.body)).action==='grant'&&loseFirstGrant){loseFirstGrant=false;throw Error('Temporary grant connection failure. Try again.');}return fetch(base+p,o);}});
  // IndexedDB lifecycle shim stores the actual WebCrypto CryptoKey object. Signing
  // and low-S conversion execute unchanged from the shipped page against real HTTP.
  Object.assign(w,{indexedDB:{open(){const result:any={};queueMicrotask(()=>{result.result={close(){},transaction(){return {objectStore:()=>({get(key:string){const r:any={};queueMicrotask(()=>{r.result=values.get(key);r.onsuccess();});return r;},put(value:unknown,key:string){const r:any={};queueMicrotask(()=>{values.set(key,value);r.onsuccess();});return r;}})};}};result.onsuccess();});return result;}}});
  w.eval(w.document.querySelector('script')!.textContent!);
  const text=(id:string)=>w.document.getElementById(id)!.textContent;
  w.document.getElementById('primary')!.click();await expect.poll(()=>text('result')).toContain('Temporary grant connection failure.');await expect.poll(()=>(w.document.getElementById('primary') as HTMLButtonElement).disabled).toBe(false);w.document.getElementById('primary')!.click();await expect.poll(()=>text('result')).toContain('Access submitted.');
  expect(values.get('browser-test').privateKey.extractable).toBe(false);expect(w.location.hash).toBe('');expect(w.document.getElementById('primary')!.hidden).toBe(true);expect(text('title')).toBe('Phone connected');
  expect((w.document.getElementById('target') as HTMLSelectElement).selectedOptions[0].textContent).toBe('Test Mac');w.document.getElementById('inspect')!.click();await expect.poll(()=>text('access')).toContain('Waiting for the target to confirm.');
  w.document.getElementById('routeDisable')!.click();await expect.poll(()=>text('result')).toContain('Route removal submitted');w.document.getElementById('inspect')!.click();await expect.poll(()=>text('access')).toContain('Direct connection turned off.');
  w.document.getElementById('routeEnable')!.click();await expect.poll(()=>text('result')).toContain('Route enabled.');
  w.document.getElementById('retryRepair')!.click();await expect.poll(()=>text('result')).toContain('One new bounded recovery cycle approved.');
  w.document.getElementById('phoneRevoke')!.click();await expect.poll(()=>text('result')).toContain('This phone is disconnected');
  w.document.getElementById('inspect')!.click();await expect.poll(()=>text('result')).toContain('This phone no longer has recovery permission');
  const reload=new JSDOM(html,{url:base+'/v1/recovery/phone#agent=browser-test',runScripts:'outside-only'});
  try{
   Object.defineProperty(reload.window,'crypto',{value:crypto.webcrypto});Object.assign(reload.window,{TextEncoder,TextDecoder,indexedDB:w.indexedDB,fetch:(p:string,o:RequestInit)=>fetch(base+p,o)});
   reload.window.eval(reload.window.document.querySelector('script')!.textContent!);reload.window.document.getElementById('primary')!.click();
   await expect.poll(()=>reload.window.document.getElementById('result')!.textContent).toContain('This phone no longer has recovery permission');
   expect(reload.window.document.getElementById('manage')!.hidden).toBe(true);expect(reload.window.document.getElementById('title')!.textContent).not.toBe('Phone connected');
  }finally{reload.window.close();}

 }finally{dom?.window.close();await relay.stop();SafeFsExecutor.safeRmSync(dir,{recursive:true,force:true,operation:'recovery-phone-console.test:cleanup'});}
});
