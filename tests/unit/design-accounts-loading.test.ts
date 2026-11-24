import { describe,it,expect } from 'vitest';
import { createAccountsLoadingBarrier, LOADING_REQUEST_HEADER, createLoadingRequestHeaders,createLoadingNativeWitness,assertNativeLoadingWitness } from '../design/harness/accountsLoading.mjs';
import { EventEmitter } from 'node:events';
const setup = () => { let now=0; const hold=createAccountsLoadingBarrier({now:()=>now}); const req:any=new EventEmitter(); Object.assign(req,{method:'GET',originalUrl:'/subscription-pool?scope=pool',headers:{[LOADING_REQUEST_HEADER]:hold.binding.requestId}}); const res:any=new EventEmitter(); return {hold,req,res,setNow:(n:number)=>now=n}; };
describe('real awaited Accounts loading barrier',()=>{
 it('holds the exact accepted read, records pending checks, then releases real continuation and finish',async()=>{
  const {hold,req,res}=setup(); let continued=false; let work:any;
  hold.middleware(req,res,()=>{work=hold.wait().then(()=>{continued=true;});});
  expect(continued).toBe(false); const before=hold.checkPending(hold.binding); expect(before.state).toBe('pending');
  const after=hold.checkPending(hold.binding); hold.release(hold.binding); await work; expect(continued).toBe(true); res.emit('finish');
  expect(hold.assess({before,after})).toMatchObject({state:'finished',atCapture:'pending',afterCapture:'released'});
 });
 it('refuses a skeleton without an actual provider read',()=>{const {hold,req,res}=setup();hold.middleware(req,res,()=>{});expect(()=>hold.checkPending(hold.binding)).toThrow();});
 it('does not bind a different or overlapping request attempt',()=>{const {hold,req,res}=setup();hold.middleware(req,res,()=>{void hold.wait();}); const wrong={...req,headers:{[LOADING_REQUEST_HEADER]:'wrong'}};expect(()=>hold.middleware(wrong,res,()=>{})).toThrow();expect(()=>hold.checkPending(hold.binding)).toThrow();hold.cancel();});
 it('refuses release before capture, aborted reads and the real client timeout window',async()=>{
  for(const mode of ['released','aborted','expired']){const {hold,req,res,setNow}=setup();let p:any;hold.middleware(req,res,()=>{p=hold.wait();});p.catch(()=>{});if(mode==='released')hold.release(hold.binding);if(mode==='aborted')req.emit('aborted');if(mode==='expired')setNow(20_000);expect(()=>hold.checkPending(hold.binding)).toThrow();hold.cancel();await p.catch(()=>{});}
 });
 it('cancel releases pending resources without claiming a completed response',async()=>{const {hold,req,res}=setup();let p:any;hold.middleware(req,res,()=>{p=hold.wait();});hold.cancel();await expect(p).rejects.toThrow();expect(()=>hold.assess({})).toThrow();});
 it('rejects forged snapshots and wrong hold identity',async()=>{const {hold,req,res}=setup();let p:any;hold.middleware(req,res,()=>{p=hold.wait();});const before=hold.checkPending(hold.binding);expect(()=>hold.checkPending({...hold.binding,requestId:'x'})).toThrow();hold.release(hold.binding);await p;res.emit('finish');expect(()=>hold.assess({before:{...before},after:before})).toThrow();});
});

it('overrides page IDs only for the one exact native GET and strips them from all retries/other URLs',()=>{
 const route=createLoadingRequestHeaders('http://127.0.0.1:3',{requestId:'trusted'});
 const req=(url:string,method='GET')=>({url:()=>url,method:()=>method,headers:()=>({'X-Instar-Design-Loading-Request':'page-forgery',other:'kept'})});
 expect(route(req('http://127.0.0.1:3/other'))).toEqual({other:'kept'});
 expect(route(req('http://127.0.0.1:3/subscription-pool?scope=pool','POST'))).toEqual({other:'kept'});
 expect(route(req('http://127.0.0.1:3/subscription-pool?scope=pool'))).toEqual({other:'kept',[LOADING_REQUEST_HEADER]:'trusted'});
 expect(route(req('http://127.0.0.1:3/subscription-pool?scope=pool'))).toEqual({other:'kept'});
});

it.each(['timeout','failed','responded','unadmitted'])('refuses native loading %s even if the server has not noticed it yet',mode=>{
 let now=0;const b={holdId:'h',requestId:'r'},n=createLoadingNativeWitness(b,{now:()=>now}),request={};
 if(mode!=='unadmitted')n.admit(request);
 if(mode==='timeout')now=20_000;if(mode==='failed')n.failed(request);if(mode==='responded')n.response(request);
 expect(()=>n.observe()).toThrow();
});
it('records native pending timing across capture and refuses swapped identities and ordering',()=>{
 let now=1;const b={holdId:'h',requestId:'r'},n=createLoadingNativeWitness(b,{now:()=>now});n.admit({});const before=n.observe();now=2;const after=n.observe();
 expect(()=>assertNativeLoadingWitness({before,after},b)).not.toThrow();expect(()=>assertNativeLoadingWitness({before,after},{...b,requestId:'other'})).toThrow();expect(()=>assertNativeLoadingWitness({before:after,after:before},b)).toThrow();
});
