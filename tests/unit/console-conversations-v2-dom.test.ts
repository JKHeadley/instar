import {afterEach,describe,it,expect,vi} from 'vitest';
import {JSDOM} from 'jsdom';
let dom:JSDOM;
const effort={kind:'effort',id:'012fdaec-70de-4324-9ef3-22b616fc83ce'},queue='queued:owner-change:'+ 'b'.repeat(64);
const settle=async()=>{for(let n=0;n<10;n++)await new Promise(resolve=>setTimeout(resolve,0));};
afterEach(()=>{dom?.window.dispatchEvent(new dom.window.Event('instar-owner-locked'));dom?.window.close();vi.restoreAllMocks();vi.unstubAllGlobals();});
const pending=(n=1)=>({wireVersion:2,operationKey:n===1?queue:'queued:owner-change:'+n.toString(16).padStart(64,'0'),requestId:'recorded-request-'+n,state:'recorded-local',cancelEligible:true,details:'available',custody:{kind:'recorded-here',machine:{name:'Studio'}},localIntent:{v:1,change:{kind:'set-effort-title',effort,baseVersion:0,title:'PENDING-PRIVATE-NAME-'+n}}});
const node=()=>({partial:false,node:{ref:effort,title:'Canonical effort'},children:{items:[],nextCursor:null},correction:{moveEligible:true,replacesPlacementEventIds:[],replacesFrontDoorEventIds:[],headerVersion:0}});
async function boot(handler:(path:string,body?:any)=>any){
 vi.resetModules();dom=new JSDOM('<html><body><main></main></body></html>',{url:'http://localhost/dashboard/console/#/work/conversations'});
 for(const k of ['window','document','location','localStorage','sessionStorage'])vi.stubGlobal(k,(dom.window as any)[k]);vi.stubGlobal('requestAnimationFrame',(f:any)=>setTimeout(f,0));dom.window.scrollTo=vi.fn();
 const calls:any[]=[];vi.stubGlobal('fetch',async(path:string,opts:any={})=>{const body=opts.body?JSON.parse(opts.body):undefined;calls.push({path,body});const response=await handler(path,body);return{status:response?.status||200,ok:(response?.status||200)<400,json:async()=>response?.data||{}};});
 const ui=await import('../../dashboard/console/ui.js');ui.rememberOperatorSession({operatorSessionToken:'actual-owner-canary',operatorSessionExpiresAt:new Date(Date.now()+600000).toISOString()});
 const {renderConversations}=await import('../../dashboard/console/conversations.js');const main=document.querySelector('main')!;
 return{calls,ui,main,render:()=>renderConversations(main),button:(text:string)=>[...document.querySelectorAll('[role=dialog] button'),...document.querySelectorAll('button')].find(b=>b.textContent===text) as HTMLButtonElement};
}
describe('owned-custody v2 mounted dashboard',()=>{
 it('keeps local title out of the canonical tree, cancels via queued operationKey and never stores private payload',async()=>{
  const f=await boot(path=>path.startsWith('/conversation-graph/pending')?{data:{items:[pending()],total:1,nextOffset:null}}:path.endsWith('/cancel')?{data:{state:'canceled-local',requestId:'recorded-request-1'}}:{data:{partial:false,items:[{ref:effort,title:'Canonical effort'}],nextCursor:null}});
  await f.render();expect(f.main.querySelector('.rows.conversation-rows')?.textContent).toContain('Canonical effort');expect(f.main.querySelector('.rows.conversation-rows')?.textContent).not.toContain('PENDING-PRIVATE');
  expect(f.main.querySelector('[aria-label="Changes waiting to sync"]')?.textContent).toContain('Pending name: PENDING-PRIVATE-NAME-1');expect(f.main.textContent).toContain('Not yet saved independently');expect(f.main.querySelectorAll('.conversation-sync')).toHaveLength(1);
  f.button('Cancel change').click();await settle();expect(f.calls.some(c=>c.path===`/conversation-graph/changes/${encodeURIComponent(queue)}/cancel`)).toBe(true);
  expect(JSON.stringify({...sessionStorage})).not.toContain('PENDING-PRIVATE');expect(JSON.stringify({...sessionStorage})).not.toContain('actual-owner-canary');
 });
 it('pages pending64 separately and suppresses quarantined details even if an invalid server includes a title',async()=>{
  const first=Array.from({length:64},(_,n)=>({...pending(n+1),details:'quarantined'}));
  const f=await boot(path=>path.includes('/pending?offset=64')?{data:{items:[pending(65)],total:65,nextOffset:null}}:path.includes('/pending')?{data:{items:first,total:65,nextOffset:64}}:{data:{partial:false,items:[],nextCursor:null}});
  await f.render();expect(f.main.textContent).not.toContain('PENDING-PRIVATE');f.button('Show more pending changes').click();await settle();expect(f.main.textContent).toContain('PENDING-PRIVATE-NAME-65');expect(f.main.querySelectorAll('.conversation-pending-row')).toHaveLength(65);
 });
 it('says plainly when this machine has not joined, and keeps the general wording otherwise',async()=>{
  const {localOnlyWords,localOnlyEnvelope}=await import('../../dashboard/console/conversations-model.js');
  const base={status:503,data:{code:'conversation-graph-pending',reason:'owned-custody-pending',capabilities:{recordLocal:true,canonical:false}}};
  expect(localOnlyEnvelope(base)).toBe(true);expect(localOnlyWords(base)).toBe('Working locally. The agreed view is unavailable.');
  const joined={...base,data:{...base.data,awaitingJoin:true}};expect(localOnlyEnvelope(joined)).toBe(true);expect(localOnlyWords(joined)).toContain('has not joined');
 });
 it('offers local create only for the explicit authorized preprofile envelope and never fabricates an empty canonical tree',async()=>{
  const f=await boot(path=>path.includes('/pending')?{data:{items:[],total:0,nextOffset:null}}:{status:503,data:{code:'conversation-graph-pending',reason:'owned-custody-pending',capabilities:{recordLocal:true,canonical:false}}});
  await f.render();expect(f.button('Create effort')).toBeDefined();expect(f.main.textContent).toContain('agreed view is unavailable');expect(f.main.textContent).not.toContain('No efforts');expect(f.main.querySelector('.conversation-rows')).toBeNull();
 });
 it('keeps the way to finish a stopped removal when the agreed view is unavailable',async()=>{
  const member=(machineId:string,name:string,self:boolean)=>({machineId,name,self});
  const f=await boot(path=>path.includes('/member-loss/status')?{data:{state:'failed',held:true,removed:['m_gone'],failure:'stopped',members:[member('m_gone','Gone',false),member('m_me','Here',true)],resume:{requestId:'remove-m_gone-1',removedMachineIds:['m_gone']},cancellable:false}}:path.includes('/pending')?{data:{items:[],total:0,nextOffset:null}}:{status:503,data:{code:'conversation-graph-pending',reason:'owned-custody-pending',capabilities:{recordLocal:true,canonical:false}}});
  await f.render();await settle();expect(f.main.textContent).toContain('agreed view is unavailable');expect(f.button('Finish removing')).toBeDefined();
 });
 it('records here without offering a retry and uses operationKey-only cancellation',async()=>{
  const f=await boot((path,body)=>path.includes('/pending')?{data:{items:[],total:0,nextOffset:null}}:path.includes('/nodes/')?{data:node()}:path.endsWith('/changes')?{status:202,data:{...pending(),requestId:body.requestId}}:path.endsWith('/cancel')?{data:{state:'canceled-local'}}:path.includes('/changes/')?{status:404,data:{}}:{data:{partial:false,items:[],nextCursor:null,capabilities:{ownerCorrections:true}}});
  const {effortActionControls}=await import('../../dashboard/console/conversation-effort-actions.js');const {encodeNodeRef}=await import('../../dashboard/console/conversations-model.js');const controls=effortActionControls({canCorrect:true,node:{kind:'effort',key:encodeNodeRef(effort),ref:effort},correction:node().correction,send:async(path:string,body?:any)=>{const raw=await (globalThis.fetch as any)(path,{...(body?{body:JSON.stringify(body)}:{})});return{ok:raw.ok,status:raw.status,data:await raw.json()};},current:()=>true,unlock:()=>{},refresh:()=>{}});f.main.append(controls!);
  f.button('Rename effort').click();await settle();const input=document.querySelector('[role=dialog] input') as HTMLInputElement;expect(input,document.body.textContent||'').not.toBeNull();input.value='DRAFT-PRIVATE';document.querySelector('form')!.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));await settle();expect(document.querySelector('[role=dialog]')?.textContent).toContain('Recorded here on Studio');
  f.button('Check status').click();await settle();expect(f.button('Retry same request')).toBeUndefined();expect(document.querySelector('[role=dialog]')?.textContent).toContain('Recorded here');expect(JSON.stringify({...sessionStorage})).not.toContain('DRAFT-PRIVATE');
 });
 it('dismisses only presentation, reads fresh canonical heads and retains the old UUID alongside an explicit new edit',async()=>{
  let writes=0;
  const f=await boot((path,body)=>path.includes('/pending')?{data:{items:[],total:0,nextOffset:null}}:path.includes('/nodes/')?{data:node()}:path.endsWith('/changes')?{status:202,data:{...pending(),requestId:body.requestId}}:{status:404,data:{}});
  const {effortActionControls}=await import('../../dashboard/console/conversation-effort-actions.js');const {encodeNodeRef}=await import('../../dashboard/console/conversations-model.js');const continuity=await import('../../dashboard/console/conversation-write-continuity.js');
  const scope=encodeNodeRef(effort)+':rename';continuity.track(scope,{body:{requestId:'old-unknown-request-01'}});
  const controls=effortActionControls({canCorrect:true,node:{kind:'effort',key:encodeNodeRef(effort),ref:effort},correction:node().correction,current:()=>true,unlock:()=>{},refresh:()=>{},send:async(path:string,body?:any)=>{if(body)writes++;const raw=await (globalThis.fetch as any)(path,{...(body?{body:JSON.stringify(body)}:{})});return{ok:raw.ok,status:raw.status,data:await raw.json()};}});f.main.append(controls!);
  f.button('Rename effort').click();await settle();expect(writes).toBe(0);f.button('Dismiss notice and refresh').click();await settle();expect(continuity.ledger()).toMatchObject([{requestId:'old-unknown-request-01',dismissed:true}]);
  const start=f.calls.length;f.button('Rename effort').click();await settle();expect(f.calls.slice(start).some(c=>c.path.includes('/nodes/'))).toBe(true);expect(document.querySelector('[role=dialog]')?.textContent).toContain('An earlier request is unresolved');
  const input=document.querySelector('[role=dialog] input') as HTMLInputElement;input.value='NEW-PRIVATE-NAME';document.querySelector('form')!.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));await settle();
  expect(writes).toBe(1);expect(continuity.ledger()).toHaveLength(2);expect(continuity.ledger()[0].requestId).toBe('old-unknown-request-01');expect(JSON.stringify(continuity.ledger())).not.toContain('NEW-PRIVATE');
 });

 it('clears the mounted private local overlay synchronously on owner lock',async()=>{
  const f=await boot(path=>path.includes('/pending')?{data:{items:[pending()],total:1,nextOffset:null}}:{data:{partial:false,items:[],nextCursor:null}});
  await f.render();expect(f.main.textContent).toContain('PENDING-PRIVATE');f.ui.forgetOperatorSession();expect(f.main.textContent).not.toContain('PENDING-PRIVATE');expect(f.main.textContent).toContain('Unlock');
 });
 it.each([false,true])('never settles status-only not-recorded regardless of echoed UUID (%s)',async echoed=>{
  const f=await boot(path=>path.includes('/changes/')?{status:404,data:{requestState:'not-recorded',...(echoed?{requestId:'still-unknown-request-01'}:{})}}:path.includes('/nodes/')?{data:node()}:{data:{items:[],total:0,nextOffset:null}});
  const continuity=await import('../../dashboard/console/conversation-write-continuity.js');const {encodeNodeRef}=await import('../../dashboard/console/conversations-model.js');const {effortActionControls}=await import('../../dashboard/console/conversation-effort-actions.js');
  const key=encodeNodeRef(effort);continuity.track(key+':rename',{body:{requestId:'still-unknown-request-01'}});
  const control=effortActionControls({canCorrect:true,node:{kind:'effort',key,ref:effort},correction:node().correction,current:()=>true,unlock:()=>{},refresh:()=>{},send:async(path:string)=>{const raw=await (globalThis.fetch as any)(path);return{ok:raw.ok,status:raw.status,data:await raw.json()};}});f.main.append(control!);
  f.button('Rename effort').click();await settle();expect(continuity.ledger()).toHaveLength(1);expect(f.calls.some(c=>c.body)).toBe(false);expect(f.button('Dismiss notice and refresh')).toBeDefined();
 });

 it('reconciles a promoted operation by request identity across live pending pages',async()=>{
  const promoted={...pending(),operationKey:'graph-event:promoted-change-0001',state:'saved-pending',custody:{kind:'copied-on-owned-machine',machine:{name:'Owned peer'}}};
  const f=await boot(path=>path.includes('/pending?offset=64')?{data:{items:[promoted],total:1,nextOffset:null}}:path.includes('/pending')?{data:{items:[pending()],total:65,nextOffset:64}}:{data:{partial:false,items:[],nextCursor:null}});
  await f.render();f.button('Show more pending changes').click();await settle();expect(f.main.querySelectorAll('.conversation-pending-row')).toHaveLength(1);expect(f.main.textContent).toContain('Saved independently on Owned peer');expect(f.button('Refresh pending changes')).toBeDefined();
 });

 it('shows intended move paths from exact authorized typed targets without moving canonical rows',async()=>{
  const destination={...effort,id:'112fdaec-70de-4324-9ef3-22b616fc83ce'},ancestor={...effort,id:'212fdaec-70de-4324-9ef3-22b616fc83ce'};
  const moved={...pending(),localIntent:{v:1,change:{kind:'set-primary-placement',subject:effort,parent:destination,replacesPlacementEventIds:[]}}};
  const f=await boot(path=>{
   if(path.includes('/pending'))return{data:{items:[moved],total:1,nextOffset:null}};
   if(path.includes('/nodes/')){const ref=JSON.parse(Buffer.from(decodeURIComponent(path.split('/').at(-1)!), 'base64url').toString());return{data:{partial:false,node:{ref,title:ref.id===destination.id?'Target effort':'Source effort'},path:[{ref:ancestor,title:'Project path'}],children:{items:[],nextCursor:null}}};}
   return{data:{partial:false,items:[],nextCursor:null}};
  });
  await f.render();f.button('Show intended placement').click();await settle();expect(f.main.textContent).toContain('Pending move: Project path / Source effort → Project path / Target effort');expect(f.main.querySelector('.conversation-rows')?.textContent).not.toContain('Source effort');
 });

 it('retains Move continuity for a matching UUID on status404 not-recorded',async()=>{
  const id='move-still-unknown-01';const f=await boot(()=>({status:404,data:{requestId:id,requestState:'not-recorded'}}));
  const c=await import('../../dashboard/console/conversation-write-continuity.js');const {encodeNodeRef}=await import('../../dashboard/console/conversations-model.js');const {correctionControls}=await import('../../dashboard/console/conversation-corrections.js');const key=encodeNodeRef(effort);c.track(key,{body:{requestId:id}});
  const control=correctionControls({node:{kind:'effort',key,ref:effort,title:'Effort',primaryPath:[]},correction:node().correction,current:()=>true,unlock:()=>{},refresh:()=>{},send:async()=>({ok:false,status:404,data:{requestId:id,requestState:'not-recorded'}})});f.main.append(control!);f.button('Move').click();await settle();expect(c.ledger()).toHaveLength(1);expect(c.ledger()[0].requestId).toBe(id);
 });
 it('retains Earlier unresolved continuity for matching UUID status404 not-recorded',async()=>{
  const id='earlier-unknown-0001';const f=await boot(path=>path.includes('/pending')?{data:{items:[],total:0,nextOffset:null}}:path.includes('/changes/')?{status:404,data:{requestId:id,requestState:'not-recorded'}}:{data:{partial:false,items:[],nextCursor:null}});
  const c=await import('../../dashboard/console/conversation-write-continuity.js');c.track('earlier-subject',{body:{requestId:id}});await f.render();
  ([...document.querySelectorAll('button')].find(button=>button.textContent?.startsWith('Check earlier request')) as HTMLButtonElement).click();await settle();expect(c.ledger()).toHaveLength(1);expect(c.ledger()[0].requestId).toBe(id);
 });

});
