/** Independent review probes; production implementation is not changed here. */
import {afterEach,describe,it,expect,vi} from 'vitest';
import {JSDOM} from 'jsdom';
let dom:JSDOM;
const key='instar-conversation-write-ids:http://localhost/dashboard/console/';
const scope='review-effort:erase-header',id='legacy-review-0001';
afterEach(()=>{dom?.window.dispatchEvent(new dom.window.Event('instar-owner-locked'));dom?.window.close();vi.unstubAllGlobals();vi.restoreAllMocks();});
async function settle(){for(let i=0;i<8;i++)await new Promise(resolve=>setTimeout(resolve,0));}
async function mount(discovery:any,status:any){
 vi.resetModules();dom=new JSDOM('<html><body><main></main></body></html>',{url:'http://localhost/dashboard/console/'});
 for(const name of ['window','document','location','sessionStorage'])vi.stubGlobal(name,(dom.window as any)[name]);vi.stubGlobal('requestAnimationFrame',(callback:any)=>setTimeout(callback,0));
 const ui=await import('../../dashboard/console/ui.js');ui.rememberOperatorSession({operatorSessionToken:'review-owner-proof',operatorSessionExpiresAt:new Date(Date.now()+600000).toISOString()});
 sessionStorage.setItem(key,JSON.stringify([{subject:scope,requestId:id}]));
 const {erasureControls}=await import('../../dashboard/console/conversation-erasure.js');
 const control=erasureControls({node:{kind:'effort',key:'review-effort',ref:{kind:'effort',id:'012fdaec-70de-4324-9ef3-22b616fc83ce'}},canErase:true,current:()=>true,unlock:()=>{},refresh:()=>{},send:async(path:string)=>path.endsWith('/discover')?discovery:status});
 document.querySelector('main')!.append(control!);control!.click();await settle();
}
describe('independent privacy continuity review',()=>{
 it('retains an unknown legacy UUID until matching published discovery even when status reports completion',async()=>{
  await mount({ok:false,status:404,data:{code:'erasure-not-found'}},{ok:true,data:{requestId:id,localHidden:true,liveGraphStoresPurged:true,capturedGraphCopiesComplete:true,fleetComplete:true,waitingCopyCount:0,memberBackupDebtCount:0,witnessPurge:{walPurged:true,externalBackupsVerified:true}}});
  expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual([{subject:scope,requestId:id}]);
 });
 it('does not treat an empty header target as matching published discovery',async()=>{
  await mount({ok:true,data:{requestId:id,target:{sourceKind:'header',sourceId:''},continuity:{publication:'published'}}},{ok:false,status:503,data:{}});
  expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual([{subject:scope,requestId:id}]);
 });
});
