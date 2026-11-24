import { it,expect } from 'vitest';
import { startAccountsHarness } from '../design/harness/accountsServer.js';
import {providerBinding,providerLoadingAction} from '../design/harness/fixtureResponseEvidence.mjs';
import {LOADING_REQUEST_HEADER,LOADING_READ} from '../design/harness/accountsLoading.mjs';
it('real fixture startup supplies only private loading authority and close cancels the pending read and listener',async()=>{
 const h=await startAccountsHarness('busy',{loading:true});const binding=providerBinding(h.responseEvidenceProvider,h.url);expect(binding.seedState).toBe('busy');expect(binding.loading).toBeDefined();
 expect((await fetch(h.url+'/sessions',{headers:{Authorization:`Bearer ${h.bootNonce}`}})).status).toBe(204);
 const request=fetch(h.url+LOADING_READ,{headers:{[LOADING_REQUEST_HEADER]:binding.loading!.requestId}}).then(r=>r.text()).catch(e=>e);
 let entered=false;for(let i=0;i<100;i++){try{providerLoadingAction(h.responseEvidenceProvider,h.url,'check',binding.loading);entered=true;break;}catch{await new Promise(r=>setTimeout(r,5));}}
 expect(entered).toBe(true);await h.close();await request;
 expect(()=>providerLoadingAction(h.responseEvidenceProvider,h.url,'check',binding.loading)).toThrow();
 await expect(fetch(h.url+'/sessions')).rejects.toThrow();
});
