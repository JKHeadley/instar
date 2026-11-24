import fs from 'node:fs';
import {EventEmitter} from 'node:events';
import {createAccountsLoadingBarrier,LOADING_REQUEST_HEADER,LOADING_READ} from '../design/harness/accountsLoading.mjs';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { assessRendererEvidence } from '../design/harness/assessRendererEvidence.mjs';
import { createFixtureResponseEvidence } from '../design/harness/fixtureResponseEvidence.mjs';
import { responseEvidenceFixture } from '../fixtures/design-response-evidence.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))SafeFsExecutor.safeRmSync(root,{recursive:true,force:true,operation:'tests/design-renderer-assessment:close'});});
function fixture(){const f=responseEvidenceFixture();roots.push(f.root);return f;}
function assess(f:ReturnType<typeof fixture>,extra:Record<string,unknown>={}){return assessRendererEvidence({provider:f.ledger.provider,fixtureOrigin:f.origin,runDir:f.root,viewport:{width:1280,height:728},theme:'dark',seedNow:'2026-11-01T12:00:00Z',manifestPath:f.manifestPath,checkDeadline:()=>{},...extra});}
it('preserves raw worker evidence and writes explicit emitted-not-consumed parent assessment',async()=>{
 const f=fixture(),before=fs.readFileSync(f.manifestPath);const result=await assess(f);
 expect(fs.readFileSync(f.manifestPath)).toEqual(before);expect(result.assessment.status).toBe('measured');
 for(const row of result.assessment.bodyEvidence){expect(row.browserConsumption).toBe('not-observed');expect(fs.readFileSync(path.join(f.folder,row.file)).toString()).toBe('{"synthetic":true}');}
});
it.each(['unknown-id','mismatch-id','unfinished','status-error','wrong-provider','missing-nonprobe','wrong-body-hash','undeclared-emission','missing-probe'] as const)('refuses %s rather than ignoring missing bytes',async mode=>{
 const f=fixture();let extra={};
 if(mode==='unknown-id')f.manifest.responses[0].bodyEvidence.responseId='unknown';
 if(mode==='mismatch-id')f.manifest.responses[0].bodyEvidence.responseId=f.manifest.responses[1].bodyEvidence.responseId;
 if(mode==='unfinished')f.manifest.responses[0]=f.probe('/mobile/browser-devices/status',false);
 if(mode==='wrong-provider'){const wrong=createFixtureResponseEvidence();wrong.bindOrigin('http://127.0.0.1:41415');extra={provider:wrong.provider};}
 if(mode==='status-error')f.manifest.responses[0].status=503;
 if(mode==='missing-nonprobe')delete f.manifest.responses[2].file;
 if(mode==='wrong-body-hash')f.manifest.responses[2].sha256='0'.repeat(64);
 if(mode==='undeclared-emission')f.manifest.responses[2].bodyEvidence={...f.manifest.responses[0].bodyEvidence};
 if(mode==='missing-probe')f.manifest.responses.splice(0,1);
 f.save();await expect(assess(f,extra)).rejects.toThrow();
});

it.each(['trusted-case','geometry','theme','missing-read','wrong-content'] as const)('refuses mismatched Accounts readiness %s',async mode=>{
 const f=fixture();
 if(mode==='trusted-case')f.manifest.parentCase.seedState='empty';
 if(mode==='geometry')f.manifest.readiness.display.innerWidth=390;
 if(mode==='theme')f.manifest.readiness.display.themeAttribute='light';
 if(mode==='missing-read')f.manifest.responses=f.manifest.responses.filter((row:any)=>!row.url.endsWith('/subscription-pool?scope=pool'));
 if(mode==='wrong-content')f.manifest.readiness.headline='Invented ready';
 f.save();await expect(assess(f)).rejects.toThrow();
});

it.each(['main','list','heading'] as const)('refuses hidden/zero %s even when raw model/text and PNG geometry are correct',async part=>{
 const f=fixture();
 if(part==='main')f.manifest.readiness.visibility.main.display='none';
 if(part==='list')f.manifest.readiness.visibility.list.visibility='hidden';
 if(part==='heading')f.manifest.readiness.visibility.heading.rect.height=0;
 f.save();await expect(assess(f)).rejects.toThrow();
});

it.each(['valid','missing-before','wrong-native-attempt','reversed-observations','wrong-hold','unreleased','native-timeout','native-wrong-id','missing-native'] as const)('parent loading assessment %s binds real hold observations and later finished model separately',async mode=>{
 const hold=createAccountsLoadingBarrier();const f=responseEvidenceFixture({loading:hold});roots.push(f.root);
 const req=Object.assign(new EventEmitter(),{method:'GET',originalUrl:LOADING_READ,headers:{[LOADING_REQUEST_HEADER]:hold.binding.requestId}}),res=new EventEmitter();let waiting:Promise<void>;
 hold.middleware(req as never,res as never,()=>{waiting=hold.wait();});waiting!.catch(()=>{});
 const before=hold.checkPending(hold.binding),after=hold.checkPending(hold.binding);
 f.manifest.parentCase.loading=hold.binding;f.manifest.loading={before,after,native:{before:{...hold.binding,state:'pending',elapsedMs:1},after:{...hold.binding,state:'pending',elapsedMs:2}}};f.manifest.afterLoading=structuredClone(f.manifest.readiness);
 Object.assign(f.manifest.readiness,{painted:false,listPresent:false,skeleton:true,headline:'Loading accounts',rowCount:0,names:[]});
 f.manifest.responses.find((r:any)=>r.url.endsWith(LOADING_READ)).loadingRequestId=hold.binding.requestId;
 if(mode==='native-timeout')f.manifest.loading.native.after.elapsedMs=20_000;
 if(mode==='native-wrong-id')f.manifest.loading.native.after.requestId='other';
 if(mode==='missing-native')delete f.manifest.loading.native;
 if(mode==='missing-before')delete f.manifest.loading.before;
 if(mode==='wrong-native-attempt')f.manifest.responses.find((r:any)=>r.url.endsWith(LOADING_READ)).loadingRequestId='wrong';
 if(mode==='reversed-observations')Object.assign(f.manifest.loading,{before:after,after:before});
 if(mode==='wrong-hold')f.manifest.parentCase.loading={...hold.binding,holdId:'f'.repeat(32)};
 if(mode!=='unreleased'){hold.release(hold.binding);await waiting!;res.emit('finish');}
 f.save();if(mode==='valid'){const result=await assess(f);expect(result.assessment.loadingWitness).toMatchObject({atCapture:'pending',state:'finished'});expect(result.assessment.accountsReadiness.accountCount).toBe(14);}else await expect(assess(f)).rejects.toThrow();
 hold.cancel();
});
