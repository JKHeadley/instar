import { afterEach,it,expect } from 'vitest';
import { startAccountsHarness } from '../design/harness/accountsServer.js';
import { providerBinding,providerLoadingAction } from '../design/harness/fixtureResponseEvidence.mjs';
import { LOADING_REQUEST_HEADER,LOADING_READ } from '../design/harness/accountsLoading.mjs';
const closes:Array<()=>Promise<void>>=[];afterEach(async()=>{for(const close of closes.splice(0))await close();});
async function pending(h:any,b:any){for(let i=0;i<100;i++){try{return providerLoadingAction(h.responseEvidenceProvider,h.url,'check',b);}catch{await new Promise(r=>setTimeout(r,5));}}throw new Error('Real provider read never entered');}
it('holds an actual production pooled read, then drains its real busy aggregation',async()=>{
 const h=await startAccountsHarness('busy',{loading:true});closes.push(h.close);const b=providerBinding(h.responseEvidenceProvider,h.url).loading!;
 let complete=false;const request=fetch(h.url+LOADING_READ,{headers:{[LOADING_REQUEST_HEADER]:b.requestId}}).then(async r=>{complete=true;return {status:r.status,body:await r.json()};});
 const before=await pending(h,b);expect(complete).toBe(false);expect(h.peerRequests.some(r=>r.path==='/subscription-pool')).toBe(true);
 const after=providerLoadingAction(h.responseEvidenceProvider,h.url,'check',b);providerLoadingAction(h.responseEvidenceProvider,h.url,'release',b);
 const result=await request;expect(result.status).toBe(200);expect(result.body.accounts.length).toBeGreaterThan(0);
 expect(providerLoadingAction(h.responseEvidenceProvider,h.url,'assess',{before,after})).toMatchObject({atCapture:'pending',state:'finished'});
 expect((await fetch(h.url+'/design/loading/release')).status).toBe(404);
});
it('cannot obtain pending evidence by wrong origin, identity or a query-controlled hold',async()=>{
 const h=await startAccountsHarness('busy',{loading:true});closes.push(h.close);const b=providerBinding(h.responseEvidenceProvider,h.url).loading!;
 expect(()=>providerLoadingAction(h.responseEvidenceProvider,h.url,'check',{...b,requestId:'wrong'})).toThrow();
 expect(()=>providerLoadingAction(h.responseEvidenceProvider,'http://127.0.0.1:1','check',b)).toThrow();
 const r=await fetch(h.url+LOADING_READ+'&loading=true');expect(r.status).toBe(200);
 expect(()=>providerLoadingAction(h.responseEvidenceProvider,h.url,'check',b)).toThrow();
});
