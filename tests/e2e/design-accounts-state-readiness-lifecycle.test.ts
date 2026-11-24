import { expect, it } from 'vitest';
import { startAccountsHarness } from '../design/harness/accountsServer.js';
import { providerBinding } from '../design/harness/fixtureResponseEvidence.mjs';
import { ACCOUNTS_READS, deriveAccountsExpectation, validateParentCase } from '../design/harness/accountsReadiness.mjs';
it('keeps trusted fixture state and actual model facts coherent through real startup, raw-store changes and disposal',async()=>{
 const h=await startAccountsHarness();const origin=h.url;let runId:string|undefined;
 try{
  for(const state of ['busy','empty','error'] as const){
   await h.setState(state);const binding=providerBinding(h.responseEvidenceProvider,origin);
   if(runId)expect(binding.runId).toBe(runId);runId=binding.runId;
   const parentCase=validateParentCase({fixtureRunId:binding.runId,seedState:binding.seedState});expect(parentCase.seedState).toBe(state);
   const bodies:Record<string,unknown>={};for(const route of ACCOUNTS_READS){const response=await fetch(origin+route);expect(response.status).toBe(200);bodies[route]=await response.json();}
   const expected=deriveAccountsExpectation(parentCase.seedState,bodies,h.now);expect(expected.accountCount).toBe(state==='busy'?14:0);
   expect(expected.failedCount>0).toBe(state==='error');
  }
 }finally{await h.close();}
 await expect(fetch(origin+'/subscription-pool?scope=pool')).rejects.toThrow();
});
