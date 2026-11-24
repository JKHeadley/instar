/** Fixture-only awaited read barrier. No HTTP control or application state mutation. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
export const LOADING_REQUEST_HEADER='x-instar-design-loading-request';
export const LOADING_READ='/subscription-pool?scope=pool';
export function createAccountsLoadingBarrier({now=()=>performance.now()}={}) {
 const binding=Object.freeze({holdId:randomBytes(16).toString('hex'),requestId:randomBytes(16).toString('hex')});
 const context=new AsyncLocalStorage(), snapshots=new Map();
 let observationSequence=0;
 let admitted=false, entered=false, released=false, canceled=false, invalid=false, aborted=false, finished=false, startedAt, resolve,reject;
 const pending=new Promise((yes,no)=>{resolve=yes;reject=no;});pending.catch(()=>{});
 const match=b=>b?.holdId===binding.holdId&&b?.requestId===binding.requestId;
 const requireIdentity=b=>{if(!match(b))throw new Error('Loading hold identity mismatch');};
 const cancel=()=>{canceled=true;reject(new Error('Loading read canceled'));};
 const middleware=(req,res,next)=>{
  if(req.method!=='GET'||(req.originalUrl??req.url)!==LOADING_READ){next();return;}
  if(admitted||req.headers[LOADING_REQUEST_HEADER]!==binding.requestId){invalid=true;throw new Error('Loading request attempt mismatch or overlap');}
  admitted=true;startedAt=now();
  req.once('aborted',()=>{aborted=true;cancel();});
  res.once('close',()=>{if(!finished){aborted=true;cancel();}});
  res.once('finish',()=>{finished=true;});
  context.run(binding.requestId,next);
 };
 const wait=()=>{
  if(context.getStore()!==binding.requestId)return Promise.resolve();
  if(entered){invalid=true;throw new Error('Loading read entered more than once');}
  entered=true;return pending;
 };
 const checkPending=b=>{
  requireIdentity(b);
  if(!admitted||!entered||released||canceled||invalid||aborted||finished||now()-startedAt>=20_000)throw new Error('Actual Accounts read is not safely pending');
  const snapshot=Object.freeze({...binding,token:randomBytes(16).toString('hex'),state:'pending',sequence:++observationSequence,elapsedMs:now()-startedAt});snapshots.set(snapshot.token,snapshot);return snapshot;
 };
 const release=b=>{requireIdentity(b);if(canceled||invalid||aborted||!entered)throw new Error('Loading read cannot release');released=true;resolve();};
 const assess=({before,after})=>{
  if(!before||!after||before===after||snapshots.get(before.token)!==before||snapshots.get(after.token)!==after||after.sequence<=before.sequence||after.elapsedMs<before.elapsedMs||!released||!finished||canceled||invalid||aborted)throw new Error('Loading capture sequence or final response is unproven');
  return {...binding,state:'finished',atCapture:'pending',afterCapture:'released',before,after};
 };
 const snapshot=token=>snapshots.get(token);
 return {binding,middleware,wait,checkPending,release,cancel,assess,snapshot};
}

/** The trusted parent case binds one native attempt; page-provided IDs never survive. */
export function createLoadingRequestHeaders(origin, binding) {
 let used=false;
 return request=>{
  const headers={...request.headers()};for(const key of Object.keys(headers))if(key.toLowerCase()===LOADING_REQUEST_HEADER)delete headers[key];
  if(binding&&!used&&request.method()==='GET'&&request.url()===origin+LOADING_READ){used=true;headers[LOADING_REQUEST_HEADER]=binding.requestId;}
  return headers;
 };
}
/** Browser-owned timing begins at actual route admission, not later server entry. */
export function createLoadingNativeWitness(binding,{now=()=>performance.now()}={}){
 let started,request,failed=false,responded=false;
 return {
  admit(value){if(request)throw new Error('Second native loading attempt');request=value;started=now();},
  failed(value){if(value===request)failed=true;},
  response(value){if(value===request)responded=true;},
  observe(){const elapsedMs=now()-started;if(!request||failed||responded||!Number.isFinite(elapsedMs)||elapsedMs<0||elapsedMs>=20_000)throw new Error('Native loading request is no longer pending within client deadline');return {...binding,state:'pending',elapsedMs};}
 };
}
export function assertNativeLoadingWitness(value,binding){
 for(const key of ['before','after']){const v=value?.[key];if(!v||v.holdId!==binding.holdId||v.requestId!==binding.requestId||v.state!=='pending'||!Number.isFinite(v.elapsedMs)||v.elapsedMs<0||v.elapsedMs>=20_000)throw new Error('Actual native pending loading evidence is invalid');}
 if(value.after.elapsedMs<value.before.elapsedMs)throw new Error('Native loading capture ordering is invalid');
}
