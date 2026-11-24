import { afterEach, expect, it } from 'vitest';
import { startAccountsHarness, type AccountsHarnessState } from '../design/harness/accountsServer.js';
import { providerBinding } from '../design/harness/fixtureResponseEvidence.mjs';
import { ACCOUNTS_READS, deriveAccountsExpectation } from '../design/harness/accountsReadiness.mjs';
const closes:Array<()=>Promise<void>>=[];afterEach(async()=>{for(const close of closes.splice(0))await close();});
it.each(['busy','empty','error'] as AccountsHarnessState[])('binds actual %s handler/model reads to the private fixture state',async state=>{
 const h=await startAccountsHarness(state);closes.push(h.close);const bodies:Record<string,unknown>={};
 for(const route of ACCOUNTS_READS){const response=await fetch(h.url+route);expect(response.status).toBe(200);bodies[route]=await response.json();}
 const binding=providerBinding(h.responseEvidenceProvider,h.url);expect(binding.seedState).toBe(state);
 const expected=deriveAccountsExpectation(binding.seedState,bodies,h.now);
 expect(expected.accountCount).toBe(state==='busy'?14:0);expect(expected.failedCount>0).toBe(state==='error');
 if(state==='error'){
  expect(expected.partial).toContain('accounts');
  expect((await fetch(h.url+'/subscription-pool')).status).toBe(503); // Plain unreadable store is distinct from the consumed pooled200.
  expect(expected.seedState).toBe('error');
 }else expect(expected.partial).toBeNull();
});
it('cannot relabel real partial-error data as empty or infer state from a request query',async()=>{
 const h=await startAccountsHarness('error');closes.push(h.close);const bodies:Record<string,unknown>={};
 for(const route of ACCOUNTS_READS)bodies[route]=await fetch(h.url+route).then(response=>response.json());
 await fetch(h.url+'/subscription-pool?scope=pool&seedState=empty');expect(providerBinding(h.responseEvidenceProvider,h.url).seedState).toBe('error');
 expect(()=>deriveAccountsExpectation('empty',bodies,h.now)).toThrow();
});
