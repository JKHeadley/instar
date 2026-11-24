import {createAccountsLoadingBarrier,LOADING_REQUEST_HEADER,LOADING_READ} from '../design/harness/accountsLoading.mjs';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { runRendererWorker } from '../design/harness/rendererParent.mjs';
import { responseEvidenceFixture } from '../fixtures/design-response-evidence.js';
const validationBoundary = vi.hoisted(() => ({ afterReturn: () => {} }));
vi.mock('../design/harness/assessRendererEvidence.mjs', async importOriginal => {
 const real = await importOriginal();
 return { ...real, assessRendererEvidence: async args => {
  const result = await real.assessRendererEvidence(args);
  validationBoundary.afterReturn(); // Real bytes and real persistence complete before this timing intervention.
  return result;
 } };
});
let now: number; const roots: string[] = [];
beforeEach(() => { vi.useFakeTimers(); now = 0; validationBoundary.afterReturn = () => {}; });
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'tests/design-renderer-parent:close' }); });
function fixture(abortDuringValidation=false,expireAfterValidation=false) {
 const data=responseEvidenceFixture();roots.push(data.root);const controller=new AbortController();
 const child=Object.assign(new EventEmitter(),{pid:456,stdout:new EventEmitter(),stderr:new EventEmitter(),stdin:{end:vi.fn()},send:vi.fn((_message,callback)=>callback?.()),kill:vi.fn()});
 const spawn=vi.fn(()=>child);
 const completion=runRendererWorker(data.config,{fixtureEvidenceProvider:data.ledger.provider,signal:controller.signal,spawnWorker:spawn,now:()=>now,
  onEvent:event=>{if(abortDuringValidation&&event.kind==='parent-validation-start')queueMicrotask(()=>controller.abort());if(expireAfterValidation&&event.kind==='parent-validation-complete')now=60_000;}});
 const ack=()=>child.emit('message',{type:'renderer-complete',result:{status:'capture-produced',manifest:data.manifestPath,cleanup:{status:'closed-gracefully'}}});
 return {...data,child,spawn,completion,controller,ack};
}
it('records deadline cancellation and cannot promote a later capture acknowledgment',async()=>{
 const f=fixture();now=60_000;await vi.advanceTimersByTimeAsync(60_000);
 expect(f.child.send).toHaveBeenCalledWith({type:'renderer-cancel',reason:'screen-deadline'},expect.any(Function));expect(f.child.kill).not.toHaveBeenCalled();
 f.ack();f.child.emit('exit',0,null);expect(await f.completion).toMatchObject({status:'unavailable',timerFired:true,cancelSent:true,workerExitObserved:true});
});
it('retains recovery ownership instead of killing only an unresponsive worker',async()=>{
 const f=fixture();now=120_000;await vi.advanceTimersByTimeAsync(120_000);const result=await f.completion;
 expect(result.status).toBe('unavailable');expect(result.recoveryOwnership.worker).toBe(f.child);expect(f.child.kill).not.toHaveBeenCalled();
});
it('refuses a bare successful worker exit without its capture and cleanup receipt',async()=>{
 const f=fixture();f.child.emit('exit',0,null);expect(await f.completion).toMatchObject({status:'unavailable',recoveryOwnership:{workerPid:456}});
});
it('promotes only after trusted same-fixture raw-byte assessment, preserving stdin-only nonce transport',async()=>{
 const f=fixture();f.ack();f.child.emit('exit',0,null);
 const result=await f.completion;expect(result).toMatchObject({status:'measured',assessment:{assessment:{status:'measured',bodyEvidence:[{kind:'fixture-emitted',browserConsumption:'not-observed'},{kind:'fixture-emitted',browserConsumption:'not-observed'}]}}});
 expect(f.spawn.mock.calls[0][1]).toHaveLength(1);expect(JSON.stringify(f.spawn.mock.calls[0][1])).not.toContain('a'.repeat(64));
 const input=JSON.parse(f.child.stdin.end.mock.calls[0][0]);expect(input.bootNonce).toBe('a'.repeat(64));expect(input).not.toHaveProperty('parentCase');expect(input).not.toHaveProperty('seedState');
 expect(f.child.send).toHaveBeenCalledWith({type:'renderer-case',parentCase:{fixtureRunId:f.manifest.parentCase.fixtureRunId,seedState:'busy'}},expect.any(Function));
});
it('cannot promote when parent cancellation arrives during validation',async()=>{
 const f=fixture(true);f.ack();f.child.emit('exit',0,null);
 const result=await f.completion;expect(result).toMatchObject({status:'unavailable',cancelSent:true,assessment:{assessment:{status:'unavailable'}}});
 expect(JSON.parse(fs.readFileSync(result.assessment.filename,'utf8')).status).toBe('unavailable');expect(f.child.kill).not.toHaveBeenCalled();
});
it('rejects a candidate/stdin evidence provider or an unbranded parent callback before launch',()=>{
 const f=responseEvidenceFixture();roots.push(f.root);const spawn=vi.fn();
 expect(()=>runRendererWorker({...f.config,fixtureEvidenceProvider:{}},{spawnWorker:spawn})).toThrow();
 expect(()=>runRendererWorker(f.config,{fixtureEvidenceProvider:()=>({}),spawnWorker:spawn})).toThrow();expect(spawn).not.toHaveBeenCalled();
});

it('downgrades the persisted parent assessment if the final disposition crosses the deadline',async()=>{
 const f=fixture(false,true);f.ack();f.child.emit('exit',0,null);const result=await f.completion;
 expect(result.status).toBe('unavailable');expect(result.assessment.assessment.status).toBe('unavailable');
 expect(JSON.parse(fs.readFileSync(result.assessment.filename,'utf8')).status).toBe('unavailable');
});

it.each(['deadline','cancel'] as const)('downgrades the owned assessment when %s arrives exactly after awaited validation returns',async mode=>{
 const f=fixture();validationBoundary.afterReturn=()=>{if(mode==='deadline')now=60_000;else f.controller.abort();};
 f.ack();f.child.emit('exit',0,null);const result=await f.completion;
 expect(result.status).toBe('unavailable');expect(result.assessment.assessment.status).toBe('unavailable');
 expect(JSON.parse(fs.readFileSync(`${f.folder}/parent-assessment.json`,'utf8')).status).toBe('unavailable');
 expect(result.assessment.filename).toBe(`${f.folder}/parent-assessment.json`);
});

it('parent IPC uses its private hold identity and abort rejects the actual pending provider wait',async()=>{
 const hold=createAccountsLoadingBarrier(),data=responseEvidenceFixture({loading:hold});roots.push(data.root);const controller=new AbortController();
 const req=Object.assign(new EventEmitter(),{method:'GET',originalUrl:LOADING_READ,headers:{[LOADING_REQUEST_HEADER]:hold.binding.requestId}}),res=new EventEmitter();let pending:Promise<void>;
 hold.middleware(req as never,res as never,()=>{pending=hold.wait();});pending!.catch(()=>{});
 const child=Object.assign(new EventEmitter(),{pid:456,stdout:new EventEmitter(),stderr:new EventEmitter(),stdin:{end:vi.fn()},send:vi.fn((_m,cb)=>cb?.()),kill:vi.fn()});
 const result=runRendererWorker(data.config,{fixtureEvidenceProvider:data.ledger.provider,signal:controller.signal,spawnWorker:()=>child,now:()=>now});
 expect(child.send.mock.calls[0][0].parentCase.loading).toEqual(hold.binding);expect(JSON.parse(child.stdin.end.mock.calls[0][0])).not.toHaveProperty('loading');
 child.emit('message',{type:'renderer-loading',id:1,action:'check',holdId:'page-forgery'});
 expect(child.send.mock.calls.at(-1)![0]).toMatchObject({type:'renderer-loading-result',id:1,value:{holdId:hold.binding.holdId,state:'pending'}});
 controller.abort();await expect(pending!).rejects.toThrow();child.emit('exit',0,null);expect((await result).status).toBe('unavailable');expect(child.kill).not.toHaveBeenCalled();
});
