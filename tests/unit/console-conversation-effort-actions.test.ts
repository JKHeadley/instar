import {afterEach,describe,it,expect,vi} from 'vitest';
import {JSDOM} from 'jsdom';
let dom:JSDOM;
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
async function settle(){for(let i=0;i<8;i++)await tick();}
const effort={kind:'effort',id:'012fdaec-70de-4324-9ef3-22b616fc83ce'},other={kind:'conversation',platform:'slack',channelId:'CABC',threadTs:'123.456'};
const correction={moveEligible:true,replacesPlacementEventIds:['place-old-0001'],replacesFrontDoorEventIds:['door-old-0001'],headerVersion:0,headerForgotten:false};
const rawNode=(ref:any=effort,extra:any={})=>({partial:false,node:{ref,title:ref.kind==='effort'?'An effort':'A conversation'},children:{items:[],nextCursor:null},correction,...extra});
afterEach(async()=>{if(dom){dom.window.dispatchEvent(new dom.window.Event('instar-owner-locked'));dom.window.close();}vi.unstubAllGlobals();vi.restoreAllMocks();});
async function boot(handler:(path:string,body?:any)=>any,canCorrect=true){
 vi.resetModules();dom=new JSDOM('<html><body><main></main></body></html>',{url:'http://localhost/dashboard/console/'});
 for(const key of ['window','document','location','sessionStorage'])vi.stubGlobal(key,(dom.window as any)[key]);vi.stubGlobal('requestAnimationFrame',(cb:any)=>setTimeout(cb,0));
 const ui=await import('../../dashboard/console/ui.js');ui.rememberOperatorSession({operatorSessionToken:'never-store-owner-proof',operatorSessionExpiresAt:new Date(Date.now()+600000).toISOString()});
 const {effortActionControls}=await import('../../dashboard/console/conversation-effort-actions.js'),{encodeNodeRef}=await import('../../dashboard/console/conversations-model.js');
 const calls:Array<{path:string;body?:any}>=[],unlock=vi.fn(),refresh=vi.fn();
 const send=async(path:string,body?:any)=>{calls.push({path,...(body?{body:structuredClone(body)}:{})});return await handler(path,body);};
 const mount=(nodeMode=false)=>{const controls=effortActionControls({canCorrect,node:nodeMode?{ref:effort,key:encodeNodeRef(effort),kind:'effort',title:'An effort'}:null,correction:nodeMode?correction:null,send,current:()=>true,unlock,refresh});if(controls)document.querySelector('main')!.append(controls);return controls;};
 const button=(text:string)=>[...document.querySelectorAll('[role=dialog] button'),...document.querySelectorAll('button')].find(b=>b.textContent===text) as HTMLButtonElement;
 return{mount,button,calls,ui,unlock,refresh,encodeNodeRef};
}
const ok=(data:any)=>({ok:true,status:200,data});
describe('owner effort sheets and opaque request continuity',()=>{
 it('has no controls without actual owner-corrections capability',async()=>{const f=await boot(()=>ok({}),false);expect(f.mount()).toBeNull();expect(f.mount(true)).toBeNull();expect(f.calls).toEqual([]);});
 it('creates only an empty anchor, then separately saves a name and never stores or downgrades its draft',async()=>{
  let posted=0,checks=0;
  const f=await boot((path,body)=>{if(path.endsWith('/pending'))return ok({items:[]});if(path.includes('/nodes/'))return ok(rawNode());if(body){posted++;return{ok:true,status:202,data:{state:'saved-pending',custody:{kind:'external-custody'},waitingMachines:[{name:'Sleeping laptop'}]}};}if(path.includes('/changes/')){checks++;return checks===1?ok({state:'committed',effort,requestId:decodeURIComponent(path.split('/').at(-1)!)}):{ok:false,status:0,data:{}};}return ok({});});
  f.mount();f.button('Create effort').click();await settle();f.button('Create effort').click();await settle();
  const panel=()=>document.querySelector('[role=dialog]')!;expect(posted).toBe(1);expect(f.calls.find(c=>c.body)?.body.change).toEqual({kind:'create-effort',projectScope:[]});expect(panel().querySelector('input')).toBeNull();expect(panel().textContent).toContain('Saved independently, waiting for sync with Sleeping laptop');expect(f.button('Retry same request')).toBeUndefined();
  f.button('Check status').click();await settle();const name=panel().querySelector('input') as HTMLInputElement;expect(name).not.toBeNull();expect(panel().textContent).toContain('Effort created. Its name is saved separately.');
  name.value='private draft canary';panel().querySelector('form')!.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));await settle();
  const title=f.calls.filter(c=>c.body?.change?.kind==='set-effort-title')[0];expect(title.body.change).toEqual({kind:'set-effort-title',effort,baseVersion:0,title:'private draft canary'});expect(name.value).toBe('private draft canary');expect(title.body.requestId).not.toBe(f.calls.find(c=>c.body)?.body.requestId);
  expect([...Array(sessionStorage.length)].map((_,i)=>sessionStorage.getItem(sessionStorage.key(i)!)).join('')).not.toMatch(/private draft canary|never-store-owner-proof/);
  f.button('Check status').click();await settle();expect(panel().textContent).toContain('Saved independently. The current sync status could not be checked.');expect(f.button('Retry same request')).toBeUndefined();
  document.querySelector<HTMLButtonElement>('.sheet-close')!.click();expect(name.value).toBe('');f.mount(true);f.button('Rename effort').click();await settle();expect(f.calls.filter(c=>c.body?.change?.kind==='set-effort-title')).toHaveLength(1);expect(panel().querySelector('input')).toBeNull();
 });
 it('blocks new actions until asynchronous pending restoration completes',async()=>{
  let release!:(value:any)=>void;const pending=new Promise(resolve=>{release=resolve;});const f=await boot(path=>path.endsWith('/pending')?pending:ok(rawNode()));f.mount(true);f.button('Rename effort').click();await settle();expect(document.querySelector('[role=dialog] input')).toBeNull();expect(f.calls.some(c=>c.body)).toBe(false);
  release(ok({items:[{operationKey:'graph-event:pending-move-01',subject:effort,kind:'set-primary-placement',requestId:'earlier-move-0001',state:'saved-pending'}]}));await settle();expect(document.querySelector('[role=dialog]')?.textContent).toContain('An earlier change');expect(document.querySelector('[role=dialog] input')).toBeNull();
 });
 it('uses exact typed front-door refs and fresh placement heads without alias or path inference',async()=>{
  const f=await boot((path,body)=>{if(path.endsWith('/pending'))return ok({items:[]});if(path.includes('/roots?'))return ok({partial:false,items:[{ref:other,title:'The worker',source:{platform:'slack',conversationId:-7,machine:'original-machine',title:'The worker'}}],nextCursor:null});if(body)return ok({state:'committed'});return ok(rawNode(path.includes(f.encodeNodeRef(other))?other:effort));});
  f.mount(true);f.button('Choose front door').click();await settle();f.button('The worker').click();await settle();f.button('Confirm front door').click();await settle();expect(f.calls.find(c=>c.body)?.body.change).toEqual({kind:'set-front-door',effort,conversation:other,replacesFrontDoorEventIds:['door-old-0001'],observedPlacementEventIds:['place-old-0001']});expect(document.querySelector('[role=dialog]')?.textContent).toContain('Front door updated.');
 });
 it.each([undefined,'not-recorded'])('retains uncertain IDs except explicit pre-admission refusal (%s)',async requestState=>{
  const f=await boot((path,body)=>body?{ok:false,status:409,data:{code:'header-version-conflict',...(requestState?{requestState}:{})}}:path.endsWith('/pending')?ok({items:[]}):ok(rawNode()));f.mount(true);f.button('Rename effort').click();await settle();const input=document.querySelector('[role=dialog] input') as HTMLInputElement;input.value='a name';document.querySelector('form')!.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));await settle();const tracked=JSON.parse(sessionStorage.getItem(sessionStorage.key(0)!)!);expect(tracked).toHaveLength(requestState?0:1);
 });
 it('clears detached draft/body on owner lock and ignores late private completion',async()=>{
  let release!:(value:any)=>void;const wait=new Promise(resolve=>{release=resolve;});const f=await boot((path,body)=>body?wait:path.endsWith('/pending')?ok({items:[]}):ok(rawNode()));f.mount(true);f.button('Rename effort').click();await settle();const input=document.querySelector('[role=dialog] input') as HTMLInputElement;input.value='clear this draft';document.querySelector('form')!.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));await settle();f.ui.forgetOperatorSession();window.dispatchEvent(new dom.window.Event('instar-owner-locked'));expect(input.value).toBe('');expect(document.querySelector('[role=dialog]')).toBeNull();release(ok({state:'committed'}));await settle();expect(document.body.textContent).not.toContain('Name saved');expect(f.unlock).toHaveBeenCalled();
 });
 it('does not post when opaque ID storage is unavailable and keeps keyboard focus inside the narrow sheet',async()=>{
  const f=await boot(path=>path.endsWith('/pending')?ok({items:[]}):ok(rawNode()));f.mount(true);f.button('Rename effort').click();await settle();const input=document.querySelector('[role=dialog] input') as HTMLInputElement;input.value='draft kept here';vi.spyOn(dom.window.Storage.prototype,'setItem').mockImplementation(()=>{throw new Error('blocked');});const save=f.button('Save name');save.focus();save.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));expect(document.activeElement).toBe(document.querySelector('.sheet-close'));expect(input.style.maxWidth).toBe('100%');document.querySelector('form')!.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));await settle();expect(f.calls.some(c=>c.body)).toBe(false);expect(input.value).toBe('draft kept here');
 });
});
