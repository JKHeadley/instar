/**
 * Dashboard half of the suggestion step (docs/specs/conversation-graph-suggestions.md §4):
 * Accept runs the ordinary owner changes in order, waits for each to commit, resumes from
 * opaque progress after a stall without repeating a step, skips a conversation that can no
 * longer move, and never keeps a title or the owner proof in browser storage.
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

describe('acceptSuggestion',()=>{
 it('creates, names, previews and moves each conversation, then records the acceptance',async()=>{
  const m=await boot();
  const s={id:'sg-0123456789abcdef0123',title:'Conversations rollout',reason:'',members:[{ref:tg(5),key:m.encodeNodeRef(tg(5)),title:'Five'},{ref:tg(6),key:m.encodeNodeRef(tg(6)),title:'Six'}]};
  const calls:Array<{path:string;body?:any}>=[];
  const send=async(path:string,body?:any)=>{calls.push({path,body});
   if(path.endsWith('/start'))return ok({createRequestId:'suggestion-create-0001'});
   if(path==='/conversation-graph/changes')return ok({state:'committed',requestId:body.requestId,...(body.change.kind==='create-effort'?{effort}:{})});
   if(path==='/conversation-graph/preview')return ok({eligible:true});
   if(path.startsWith('/conversation-graph/nodes/')){const ref=JSON.parse(Buffer.from(decodeURIComponent(path.split('/').at(-1)!),'base64url').toString());
    return ok(nodeBody(ref,{eligible:ref.topicId!==6}));}
   if(path.endsWith('/accepted'))return ok({ok:true});
   return ok({},404);};
  const out=await m.acceptSuggestion(s,{send,onStep:()=>{},sleep:async()=>{}});
  expect(out).toMatchObject({done:true,moved:1,skipped:1,effort});
  const changes=calls.filter(c=>c.path==='/conversation-graph/changes').map(c=>c.body.change);
  expect(changes).toEqual([
   {kind:'create-effort',projectScope:[]},
   {kind:'set-effort-title',effort,baseVersion:0,title:'Conversations rollout'},
   {kind:'set-primary-placement',subject:tg(5),parent:effort,replacesPlacementEventIds:['place-head-5']},
  ]);
  expect(calls.find(c=>c.body?.change?.kind==='create-effort')!.body.requestId).toBe('suggestion-create-0001');
  expect(calls.filter(c=>c.path==='/conversation-graph/preview')).toHaveLength(1);
  expect(calls.at(-1)!.path).toBe('/conversation-graph/suggestions/sg-0123456789abcdef0123/accepted');
  expect(sessionStorage.length).toBe(0);
 });

 it('stops while a step is still saving, keeps only opaque progress, and resumes without creating twice',async()=>{
  const m=await boot();
  const s={id:'sg-0123456789abcdef0124',title:'Secret effort name',reason:'',members:[{ref:tg(5),key:m.encodeNodeRef(tg(5)),title:'Five'},{ref:tg(7),key:m.encodeNodeRef(tg(7)),title:'Seven'}]};
  let titleCommitted=false;const creates:string[]=[];
  const send=async(path:string,body?:any)=>{
   if(path.endsWith('/start'))return ok({createRequestId:'suggestion-create-0002'});
   if(path==='/conversation-graph/changes'){
    if(body.change.kind==='create-effort'){creates.push(body.requestId);return ok({state:'committed',requestId:body.requestId,effort});}
    if(body.change.kind==='set-effort-title')return titleCommitted?ok({state:'committed',requestId:body.requestId}):ok({state:'saved-pending',requestId:body.requestId,waitingMachines:[{name:'Laptop'}]},202);
    return ok({state:'committed',requestId:body.requestId});}
   if(path.startsWith('/conversation-graph/changes/'))return titleCommitted?ok({state:'committed'}):ok({state:'saved-pending',waitingMachines:[{name:'Laptop'}]},202);
   if(path==='/conversation-graph/preview')return ok({eligible:true});
   if(path.startsWith('/conversation-graph/nodes/')){const ref=JSON.parse(Buffer.from(decodeURIComponent(path.split('/').at(-1)!),'base64url').toString());return ok(nodeBody(ref));}
   return ok({ok:true});};
  const first=await m.acceptSuggestion(s,{send,onStep:()=>{},wait:5000,sleep:async()=>{}});
  expect(first.done).toBe(false);expect(first.text).toContain('Waiting for Laptop');
  const stored=[...Array(sessionStorage.length)].map((_,i)=>sessionStorage.getItem(sessionStorage.key(i)!)).join('');
  expect(stored).not.toContain('Secret effort name');expect(stored).toContain(effort.id);
  titleCommitted=true;
  const second=await m.acceptSuggestion(s,{send,onStep:()=>{},wait:5000,sleep:async()=>{}});
  expect(second).toMatchObject({done:true,moved:2,skipped:0});
  expect(creates).toHaveLength(1);
 });

 it('a refused step stops the accept and changes nothing after it',async()=>{
  const m=await boot();
  const s={id:'sg-0123456789abcdef0125',title:'X',reason:'',members:[{ref:tg(5),key:m.encodeNodeRef(tg(5)),title:'Five'},{ref:tg(6),key:m.encodeNodeRef(tg(6)),title:'Six'}]};
  const calls:string[]=[];
  const send=async(path:string,body?:any)=>{calls.push(path);
   if(path.endsWith('/start'))return ok({createRequestId:'suggestion-create-0003'});
   if(path==='/conversation-graph/changes')return ok({code:'project-scope-conflict',requestState:'not-recorded'},409);
   return ok({});};
  const out=await m.acceptSuggestion(s,{send,onStep:()=>{},sleep:async()=>{}});
  expect(out.done).toBe(false);expect(out.text).toContain('refused');
  expect(calls).toEqual(['/conversation-graph/suggestions/sg-0123456789abcdef0125/start','/conversation-graph/changes']);
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
});

describe('acceptSuggestion respects what the owner already did',()=>{
 it('reuses the server create id from a fresh tab, keeps an existing name, and skips a conversation placed elsewhere',async()=>{
  const m=await boot();
  const other={kind:'effort',id:'99999999-0000-4000-8000-000000000009'};
  const s={id:'sg-0123456789abcdef0126',title:'Model name',reason:'',members:[{ref:tg(5),key:m.encodeNodeRef(tg(5)),title:'Five'},{ref:tg(8),key:m.encodeNodeRef(tg(8)),title:'Eight'}]};
  const changes:any[]=[];
  const send=async(path:string,body?:any)=>{
   if(path.endsWith('/start'))return ok({createRequestId:'suggestion-create-shared'});
   if(path==='/conversation-graph/changes'){changes.push(body);return ok({state:'committed',requestId:body.requestId,...(body.change.kind==='create-effort'?{effort}:{})});}
   if(path==='/conversation-graph/preview')return ok({eligible:true});
   if(path.startsWith('/conversation-graph/nodes/')){const ref=JSON.parse(Buffer.from(decodeURIComponent(path.split('/').at(-1)!),'base64url').toString());
    if(ref.kind==='effort')return ok({...nodeBody(ref),correction:{...nodeBody(ref).correction,headerVersion:1}});
    return ok(nodeBody(ref,{path:ref.topicId===8?[{ref:other,title:'Owner effort'}]:[]}));}
   return ok({ok:true});};
  const out=await m.acceptSuggestion(s,{send,onStep:()=>{},sleep:async()=>{}});
  expect(out).toMatchObject({done:true,moved:1,skipped:1});
  expect(changes[0]).toEqual({requestId:'suggestion-create-shared',change:{kind:'create-effort',projectScope:[]}});
  expect(changes.some(c=>c.change.kind==='set-effort-title')).toBe(false);
  expect(changes.filter(c=>c.change.kind==='set-primary-placement').map(c=>c.change.subject.topicId)).toEqual([5]);
 });
});
