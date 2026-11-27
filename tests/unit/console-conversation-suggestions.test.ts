/**
 * Dashboard half of the suggestion step (docs/specs/conversation-graph-suggestions.md §4,
 * conversation-groups-phone.md §2): Accept is one server step. The page calls it, shows its
 * progress words, calls again while it answers `working`, and says each kind of stop plainly.
 * The steps themselves are tested on the server (conversation-graph-suggestion-accept.test.ts).
 */
import {afterEach,describe,it,expect,vi} from 'vitest';
import {JSDOM} from 'jsdom';
let dom:JSDOM;
afterEach(()=>{dom?.window.close();vi.unstubAllGlobals();vi.restoreAllMocks();});
async function boot(){
 vi.resetModules();dom=new JSDOM('<html><body><main></main></body></html>',{url:'http://localhost/dashboard/console/'});
 for(const key of ['window','document','location','sessionStorage'])vi.stubGlobal(key,(dom.window as any)[key]);
 const mod=await import('../../dashboard/console/conversation-suggestions.js');
 const model=await import('../../dashboard/console/conversations-model.js');
 return{...mod,...model};
}
const effort={kind:'effort',id:'012fdaec-70de-4324-9ef3-22b616fc83ce'};
const tg=(topicId:number)=>({kind:'conversation',platform:'telegram',chatId:'-1001',topicId});
const ok=(data:any,status=200)=>({ok:status<400,status,data});
const nodeBody=(ref:any,{eligible=true,path=[] as any[]}={})=>({partial:false,node:{ref,title:'x'},path,children:{items:[],nextCursor:null},
 correction:{moveEligible:eligible,replacesPlacementEventIds:['place-head-'+(ref.topicId??'e')],...(ref.kind==='effort'?{headerVersion:0,headerForgotten:false,replacesFrontDoorEventIds:[]}:{})}});

describe('acceptSuggestion (one server step)',()=>{
 const s={id:'sg-0123456789abcdef0123',title:'Conversations rollout',reason:'',members:[{ref:tg(5),title:'Five'},{ref:tg(6),title:'Six'}]};
 const path='/conversation-graph/suggestions/sg-0123456789abcdef0123/accept';
 it('one call groups them and the page reports what moved',async()=>{
  const m=await boot();
  const calls:string[]=[];
  const send=async(p:string)=>{calls.push(p);return ok({id:s.id,state:'accepted',group:effort,moved:1,skipped:1,placedElsewhere:false});};
  const out=await m.acceptSuggestion(s,{send,onStep:()=>{},sleep:async()=>{}});
  expect(out).toEqual({done:true,moved:1,skipped:1,effort});
  expect(calls).toEqual([path]);
  expect(sessionStorage.length).toBe(0); // progress lives on the server, never in the browser
 });
 it('calls again while the server answers working, with its words and how long, then stops as a wait',async()=>{
  const m=await boot();
  let n=0;const steps:string[]=[];
  const working=ok({id:s.id,state:'working',step:'naming',text:'Naming it… Saved here. Waiting for Laptop to confirm.',waitingMachines:[{machineId:'m_l',name:'Laptop'}],agentNotAnswering:false,retryAfterMs:2500},202);
  const send=async()=>{n++;return working;};
  const out=await m.acceptSuggestion(s,{send,onStep:(t:string)=>steps.push(t),sleep:async()=>{},wait:10000});
  expect(out).toMatchObject({done:false,kind:'waiting',unreachable:false});
  expect(out.text).toBe('Naming it… Saved here. Waiting for Laptop to confirm. Tap Continue later; nothing is lost.');
  expect(n).toBe(5); // 0, 2.5, 5, 7.5 s, then the stop at 10 s
  expect(steps).toContain('Naming it… Saved here. Waiting for Laptop to confirm. (5 s)');
  expect(steps.some(t=>/\(0 s\)|\(3 s\)/.test(t))).toBe(false);
 });
 it('resumes to done when a later call finishes',async()=>{
  const m=await boot();
  let n=0;
  const send=async()=>++n<3?ok({state:'working',step:'moving',text:'Moving conversation 1 of 2…',waitingMachines:[],agentNotAnswering:false,retryAfterMs:2500},202)
   :ok({state:'accepted',group:effort,moved:2,skipped:0,placedElsewhere:false});
  expect(await m.acceptSuggestion(s,{send,onStep:()=>{},sleep:async()=>{}})).toMatchObject({done:true,moved:2,effort});
  expect(n).toBe(3);
 });
 it('each stop carries its kind: refused, no longer available, locked, not answering',async()=>{
  const m=await boot();
  const run=(r:any)=>m.acceptSuggestion(s,{send:async()=>r,onStep:()=>{},sleep:async()=>{}});
  const refused=await run(ok({state:'refused',step:'creating',code:'project-scope-conflict',text:'This step was refused (project-scope-conflict). Nothing after it was changed.'},409));
  expect(refused).toMatchObject({done:false,kind:'refused'});expect(refused.text).toContain('refused');
  expect(refused).toMatchObject({code:'project-scope-conflict',step:'creating'}); // the card decides Reject from these
  expect(await run(ok({code:'unknown-suggestion'},404))).toMatchObject({kind:'retry',text:'This suggestion is no longer available. Refresh the list.'});
  expect(await run({needsUnlock:true,ok:false,status:401,data:{}})).toMatchObject({kind:'locked'});
  expect(await run(ok({code:'hierarchy-owner-only'},403))).toMatchObject({kind:'locked'});
  const silent=await run(ok({},408));
  expect(silent).toMatchObject({kind:'waiting',unreachable:true});expect(silent.text).not.toContain('no longer available');
 });
 it('a project already inside another one creates nothing',async()=>{
  const m=await boot();
  const out=await m.acceptSuggestion({...s,frontDoor:tg(5)},{send:async()=>ok({state:'accepted',group:null,moved:0,skipped:1,placedElsewhere:true}),onStep:()=>{},sleep:async()=>{}});
  expect(out).toMatchObject({done:true,placedElsewhere:true,effort:null});
 });
});

describe('dashboard models',()=>{
 it('listModel carries the Chief of Staff root on the Overview only',async()=>{
  const m=await boot();
  const data={partial:false,items:[{ref:effort,title:'Launch',kind:'effort',role:'effort'}],root:{ref:tg(141385),title:'Chief of Staff',kind:'conversation',role:'unassigned'},nextCursor:null};
  expect(m.listModel(data,'overview').root?.title).toBe('Chief of Staff');
  expect(m.listModel(data,'all').root).toBeNull();
  expect(m.listModel({...data,root:undefined},'overview').root).toBeNull();
 });
 it('suggestionsModel refuses malformed cards instead of hiding them',async()=>{
  const m=await boot();
  const good={state:'ready',builtAt:null,items:[{id:'sg-0123456789abcdef0123',title:'A',reason:'r',members:[{ref:tg(1),title:'One'},{ref:tg(2),title:''}]}]};
  const model=m.suggestionsModel(good);
  expect(model.ok).toBe(true);expect(model.items[0].members[1].title).toBe('Conversation');
  expect(m.suggestionsModel({...good,items:[{...good.items[0],id:'bad'}]}).ok).toBe(false);
  expect(m.suggestionsModel({...good,items:[{...good.items[0],members:[good.items[0].members[0]]}]}).ok).toBe(false);
  expect(m.suggestionsModel({...good,state:'weird'}).ok).toBe(false);
 });
 it('the model admits a one-member project with its front door, and refuses a front door that is not a member',async()=>{
  const m=await boot();
  const item=(over:any)=>({id:'sg-0123456789abcdef0997',title:'Project: Y',reason:'r',members:[{ref:tg(9),title:'Y'}],accepting:false,...over});
  const okModel=m.suggestionsModel({state:'ready',items:[item({frontDoor:tg(9)})]});
  expect(okModel.ok).toBe(true);
  expect(okModel.items[0].frontDoor).toEqual(tg(9));
  expect(m.suggestionsModel({state:'ready',items:[item({frontDoor:tg(10)})]}).ok).toBe(false);
  expect(m.suggestionsModel({state:'ready',items:[item({})]}).ok).toBe(false); // an ordinary suggestion still needs two
 });
});


describe('a project page lists its proposed cards (work-front-doors stage 2b)',()=>{
 it('nodeModel reads the proposed list, drops a malformed row from it only, and defaults to none',async()=>{
  const m=await boot();
  const body=(over:any)=>({partial:false,node:{ref:effort,title:'Project: Shop'},path:[],children:{items:[{ref:tg(5),title:'Shop'}],nextCursor:null},...over});
  const withCards=m.nodeModel(body({proposed:{by:'card-record',items:[{ref:tg(7),title:'Pick the date'},{ref:{kind:'nope'},title:'bad'}]}}));
  expect(withCards.ok).toBe(true);
  expect(withCards.proposed.map((i:any)=>i.title)).toEqual(['Pick the date']);
  expect(withCards.children.map((i:any)=>i.title)).toEqual(['Shop']);
  expect(m.nodeModel(body({})).proposed).toEqual([]);
 });
});

// Accept all round 4 part 5: with a busy machine a change took 1-2 minutes to confirm. The page waited 60 s per change
// and stopped after two still-waiting projects in a row, so a working run stopped at "10 of 14".
describe('Accept all patience',()=>{
 it('waits 2.5 minutes for each change to be confirmed by default',async()=>{
  const m=await boot();expect(m.ACCEPT_CHANGE_CONFIRM_WAIT_MS).toBe(150000);
  const s={id:'sg-0123456789abcdef0124',title:'Slow confirm',reason:'',members:[]};let polls=0,slept=0;
  const send=async(path:string)=>{expect(path).toMatch(/\/accept$/);polls++;return ok({id:s.id,state:'working',text:'Saved here. Waiting for Mac M5 Pro to confirm.'},202);};
  const out=await m.acceptSuggestion(s,{send,onStep:()=>{},sleep:async(ms:number)=>{slept+=ms;}});
  expect(out).toMatchObject({done:false,kind:'waiting'});expect(slept).toBeGreaterThanOrEqual(150000);expect(slept).toBeLessThan(160000);expect(polls).toBeGreaterThan(50);
 });
 it('stops only after three projects in a row are still waiting; a finished or refused one resets the count',async()=>{
  const m=await boot();const waiting={done:false,kind:'waiting'},done={ok:true},refused={done:false,kind:'refused'};
  let w=0,r:any;
  r=m.acceptAllStep(w,waiting);expect(r).toEqual({waits:1,stop:false});w=r.waits;
  r=m.acceptAllStep(w,waiting);expect(r).toEqual({waits:2,stop:false});w=r.waits;
  r=m.acceptAllStep(w,done);expect(r).toEqual({waits:0,stop:false});w=r.waits;
  r=m.acceptAllStep(w,waiting);w=r.waits;r=m.acceptAllStep(w,refused);expect(r).toEqual({waits:0,stop:false});w=r.waits;
  for(const expected of [1,2])({waits:w}=m.acceptAllStep(w,waiting)),expect(w).toBe(expected);
  expect(m.acceptAllStep(w,waiting)).toEqual({waits:3,stop:true});
 });
});
