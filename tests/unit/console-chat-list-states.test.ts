// @ts-nocheck — browser-native modules; test the shipped interactive renderer.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
let dom, page;
const calls=[];
const row={id:'11111111-1111-4111-8111-111111111111',platform:'app',title:'My conversation',lastActivity:'2026-11-23T20:00:00Z',lastPreview:'A saved message'};
const ok=(conversations=[],nextCursor=null)=>({ok:true,status:200,data:{conversations,nextCursor}});
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
async function boot(handler, configure){
 vi.useFakeTimers();vi.resetModules();calls.length=0;
 dom=new JSDOM('<!doctype html><body><main></main></body>',{url:'http://localhost/dashboard/console/#/work/chats',pretendToBeVisual:true});
 for(const key of ['window','document','location','history','localStorage','sessionStorage'])vi.stubGlobal(key,dom.window[key]);
 vi.stubGlobal('navigator',{locks:{request:async()=>undefined}});
 vi.stubGlobal('BroadcastChannel',class {postMessage(){}close(){}});
 vi.stubGlobal('requestAnimationFrame',f=>setTimeout(f,0));
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:false,status:404,json:async()=>({})})));
 const device={record:{machineId:'m1',deviceId:'fixture-device',status:'active'},clock:{skewMinutes:()=>0},
  status:async()=>({ok:true,data:{machineId:'m1'}}),load:async()=>device.record,
  call:vi.fn(async(method,path,opts)=>{calls.push({method,path,opts});return path.startsWith('/mobile/conversations?')?handler(path):{ok:false,status:404,data:{}};})};
 const module=await import('../../dashboard/console/browser-device.js');vi.spyOn(module,'createBrowserDevice').mockReturnValue(device);
 const {renderChats}=await import('../../dashboard/console/chats.js');
 const main=document.querySelector('main');page=renderChats(main,{get:async()=>({ok:false,status:404})});configure?.(page);
 await vi.advanceTimersByTimeAsync(1);return {main,page,device};
}
afterEach(()=>{page?.dispose();dom?.window.close();vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers();});
describe('Interactive Conversations list read states',()=>{
 it('shows an immediate loading state and explains a ten-second wait without claiming emptiness',async()=>{
  const wait=deferred();const {main}=await boot(()=>wait.promise);
  expect(main.textContent).toContain('Loading conversations');
  expect(main.textContent).not.toContain('No conversations yet');
  await vi.advanceTimersByTimeAsync(10000);
  expect(main.textContent).toContain('Taking longer');
  wait.resolve(ok());await vi.advanceTimersByTimeAsync(1);
  expect(main.textContent).toContain('No conversations yet');
  expect(main.textContent).not.toContain('Taking longer');
 });
 it('offers retry after an unavailable read and does not call a generic503 switched off',async()=>{
  let fail=true;const {main}=await boot(()=>fail?{ok:false,status:503,data:{error:'work-card-visibility-unavailable'}}:ok([row]));
  expect(main.textContent).not.toContain('switched off');
  const retry=main.querySelector('.chat-list-retry');expect(retry).toBeTruthy();expect(retry.hidden).toBe(false);
  fail=false;retry.click();await vi.advanceTimersByTimeAsync(1);
  expect(main.textContent).toContain(row.title);expect(retry.hidden).toBe(true);
  expect(calls.every(c=>c.method==='GET')).toBe(true);
 });
 it('uses switched-off wording only for the explicit feature-off response',async()=>{
  const {main}=await boot(()=>({ok:false,status:503,data:{error:'native-conversations-off'}}));
  expect(main.textContent).toContain('switched off');
  expect(main.querySelector('.chat-list-retry')?.hidden).toBe(false);
 });
 it('distinguishes an empty filtered page from an empty entire list and follows its cursor',async()=>{
  const {main}=await boot(path=>path.includes('cursor=')?ok([row]):ok([],'older-page'));
  expect(main.textContent).not.toContain('No conversations yet');
  expect(main.textContent).toContain('More pages are available');
  main.querySelector('.chat-more').click();await vi.advanceTimersByTimeAsync(1);
  expect(main.textContent).toContain(row.title);
  expect(calls.some(c=>c.path.includes('cursor=older-page'))).toBe(true);
 });
 it('retains visible conversations on refresh failure and makes the failed read recoverable',async()=>{
  let answer=ok([row]);const {main,page}=await boot(()=>answer);
  answer={ok:false,status:500,data:{}};await page.loadList(false);
  expect(main.querySelector('.chat-row-title')?.textContent).toBe(row.title);
  expect(main.querySelector('.chat-list-retry')?.hidden).toBe(false);
 });
 it('does not call malformed success or unanswered machines an empty entire list',async()=>{
  const {main}=await boot(()=>({ok:true,status:200,data:{unexpected:true}}));
  expect(main.textContent).not.toContain('No conversations yet');
  expect(main.querySelector('.chat-list-retry')?.hidden).toBe(false);
 });
 it('ignores a delayed list response after the page is disposed',async()=>{
  const wait=deferred();const {main,page}=await boot(()=>wait.promise);
  page.dispose();main.replaceChildren(document.createTextNode('Another page'));
  wait.resolve(ok([row]));await vi.advanceTimersByTimeAsync(11000);
  expect(main.textContent).toBe('Another page');
 });
 it('reports an unanswered source as incomplete, not as an empty whole list',async()=>{
  const {main}=await boot(()=>({ok:true,status:200,data:{conversations:[],nextCursor:null,pool:{failed:[{machineId:'m2',reason:'deadline'}]}}}));
  expect(main.textContent).not.toContain('No conversations yet');
  expect(main.textContent).toContain('machines that answered');
  expect(main.textContent).toContain('did not answer');
 });
 it('retries the failed next page without losing rows, pins or its cursor',async()=>{
  let fail=true;
  const first={...ok([row],'older-page'),data:{...ok([row],'older-page').data,pinnedRefs:[{ref:'app:'+row.id,atMs:1}],pinnedRows:[row]}};
  const next={...row,id:'22222222-2222-4222-8222-222222222222',title:'Older conversation'};
  const {main,page}=await boot(path=>path.includes('cursor=')?(fail?{ok:false,status:500,data:{}}:ok([next])):first);
  await page.loadList(true);
  expect(main.textContent).toContain(row.title);expect(page.meta.nextCursor).toBe('older-page');expect(page.listPins).toHaveLength(1);
  fail=false;main.querySelector('.chat-list-retry').click();await vi.advanceTimersByTimeAsync(1);
  expect(main.textContent).toContain(next.title);expect(page.listPins).toHaveLength(1);
  expect(calls.filter(c=>c.path.includes('cursor=older-page'))).toHaveLength(2);
 });
 it('shares an initial manual and scheduled list GET and accounts for each actual read once',async()=>{
  const wait=deferred();const {createScheduler}=await import('../../dashboard/console/chats-model.js');
  const {page}=await boot(()=>wait.promise,p=>{p.leader=true;p.scheduler=createScheduler({budget:10});});
  const joined=page.loadList(false);const scheduled=page.runTask(page.scheduler.tasks().find(t=>t.mode==='list'));
  expect(calls.filter(c=>c.path.startsWith('/mobile/conversations?'))).toHaveLength(1);
  wait.resolve(ok([row]));await vi.advanceTimersByTimeAsync(1);await Promise.all([joined,scheduled]);
  expect(page.scheduler.readsInLastMinute(Date.now())).toBe(calls.filter(c=>c.method==='GET').length);
 });
 it('keeps a newer broadcast when an older successful list read finishes',async()=>{
  const wait=deferred();const {main,page}=await boot(()=>wait.promise);
  const newer={...row,title:'Newer title from another tab'};
  page.onMessage({type:'result',mode:'list',data:ok([newer]).data});
  wait.resolve(ok([row]));await vi.advanceTimersByTimeAsync(1);
  expect(main.querySelector('.chat-row-title').textContent).toBe(newer.title);
 });
 it('does not run an old queued read against a rebuilt list',async()=>{
  const more=deferred();let fresh=false;
  const {main,page}=await boot(path=>path.includes('cursor=')?more.promise:ok([{...row,title:fresh?'New page':'Old page'}],'older-page'));
  const running=page.loadList(true);const queued=page.loadList(false,true);
  page.teardownApp();expect(calls.find(c=>c.path.includes('cursor=')).opts.signal.aborted).toBe(true);fresh=true;page.openApp();await vi.advanceTimersByTimeAsync(1);
  more.resolve(ok([{...row,title:'Late old page'}]));await vi.advanceTimersByTimeAsync(1);await Promise.all([running,queued]);
  expect(main.textContent).toContain('New page');expect(main.textContent).not.toContain('Late old page');
  expect(calls.filter(c=>c.path.startsWith('/mobile/conversations?'))).toHaveLength(3);
 });
 it('turns an indefinitely pending read into a retryable failure and ignores its late result',async()=>{
  const wait=deferred();let retry=false;const {main}=await boot(()=>retry?ok([row]):wait.promise);
  await vi.advanceTimersByTimeAsync(20001);
  const button=main.querySelector('.chat-list-retry');expect(button.hidden).toBe(false);expect(button.disabled).toBe(false);
  expect(calls[0].opts.signal.aborted).toBe(true);
  retry=true;button.click();await vi.advanceTimersByTimeAsync(1);
  wait.resolve(ok([{...row,title:'Too late'}]));await vi.advanceTimersByTimeAsync(1);
  expect(main.querySelector('.chat-row-title').textContent).toBe(row.title);
 });
 it('keeps retry visible while busy and gives focus to the recovered list',async()=>{
  let answer={ok:false,status:500,data:{}};const wait=deferred();const {main}=await boot(()=>answer);
  const retry=main.querySelector('.chat-list-retry');retry.focus();answer=wait.promise;retry.click();
  expect(retry.hidden).toBe(false);expect(retry.disabled).toBe(true);
  wait.resolve(ok([row]));await vi.advanceTimersByTimeAsync(1);
  expect(retry.hidden).toBe(true);expect(document.activeElement).toBe(main.querySelector('.chat-row'));
 });
 it('does not leave an old empty assertion after a refresh fails',async()=>{
  let answer=ok();const {main,page}=await boot(()=>answer);expect(main.textContent).toContain('No conversations yet');
  answer={ok:false,status:500,data:{}};await page.loadList(false);
  expect(main.textContent).not.toContain('No conversations yet');expect(main.querySelector('.chat-list-retry').hidden).toBe(false);
 });
 it('retains and labels cached rows as unavailable after an explicit feature-off read',async()=>{
  let answer=ok([row],'older-page');const {main,page}=await boot(()=>answer);
  answer={ok:false,status:503,data:{error:'native-conversations-off'}};await page.loadList(false);
  expect(main.textContent).toContain('last loaded list');expect(main.querySelector('.chat-row').getAttribute('aria-disabled')).toBe('true');
  expect(main.querySelector('.chat-new').disabled).toBe(true);expect(main.querySelector('.chat-more').hidden).toBe(true);
  answer=ok([row]);main.querySelector('.chat-list-retry').click();await vi.advanceTimersByTimeAsync(1);
  expect(main.querySelector('.chat-new').disabled).toBe(false);expect(main.querySelector('.chat-row').hasAttribute('aria-disabled')).toBe(false);
 });
 it('treats unreadable polling as failure and preserves 429 Retry-After timing',async()=>{
  let answer=ok([row]);const {page}=await boot(()=>answer);
  page.scheduler.setConversations([],Date.now());const task=page.scheduler.tasks().find(t=>t.mode==='list');const finish=vi.spyOn(page.scheduler,'finish');
  answer={ok:true,status:200,data:{unexpected:true}};await page.runTask(task);
  expect(finish.mock.calls.at(-1)[2].status).toBe(0);
  answer={ok:false,status:429,retryAfterMs:45000,data:{}};await page.runTask(task);
  expect(page.scheduler.snapshot().find(t=>t.id==='list').notBefore).toBe(Date.now()+45000);
 });

 it('shows a known pinned conversation on an otherwise empty page and retains it on failure',async()=>{
  let answer={ok:true,status:200,data:{conversations:[],nextCursor:'older-page',pinnedRefs:[{ref:'app:'+row.id,atMs:1}],pinnedRows:[row]}};
  const {main,page}=await boot(()=>answer);
  expect(main.querySelector('.chat-row-title').textContent).toBe(row.title);
  expect(main.textContent).not.toContain('No conversations yet');
  answer={ok:false,status:500,data:{}};await page.loadList(false);
  expect(main.querySelector('.chat-row-title').textContent).toBe(row.title);
  expect(main.textContent).toContain('Your conversations are still shown');
 });

 it('does not let an obsolete 401 status check tear down a recovered list',async()=>{
  const status=deferred();let first=true;
  const {main,device}=await boot(()=>first?{ok:false,status:401,data:{}}:ok([row]),p=>{
    p.device.checkAfter401=()=>status.promise;
  });
  await vi.advanceTimersByTimeAsync(20001);first=false;
  main.querySelector('.chat-list-retry').click();await vi.advanceTimersByTimeAsync(1);
  status.resolve({deleted:true,show:'removed'});await vi.advanceTimersByTimeAsync(1);
  expect(main.querySelector('.chat-row-title').textContent).toBe(row.title);
  expect(main.textContent).not.toContain('Set up this browser');
 });

 it('still explains an authoritative elsewhere status after the record lookup',async()=>{
  const {main}=await boot(()=>({ok:false,status:401,data:{}}),p=>{
    p.device.checkAfter401=async()=>({show:'elsewhere',machineId:'other-machine',nickname:'Sample other computer'});
  });
  expect(main.textContent).toContain('Sample other computer');
  expect(main.textContent).toContain('Set up this browser');
 });

 it('aborts a slow401 check on teardown before reopening the list',async()=>{
  const status=deferred();let first=true;
  const {main,page}=await boot(()=>first?{ok:false,status:401,data:{}}:ok([row]),p=>{p.device.checkAfter401=()=>status.promise;});
  const old=calls.find(c=>c.path.startsWith('/mobile/conversations?'));
  page.teardownApp();expect(old.opts.signal.aborted).toBe(true);first=false;page.openApp();await vi.advanceTimersByTimeAsync(1);
  status.resolve({deleted:true,show:'removed'});await vi.advanceTimersByTimeAsync(1);
  expect(main.querySelector('.chat-row-title').textContent).toBe(row.title);
 });

});

const previous = {...row,id:'22222222-2222-4222-8222-222222222222',title:'Answered agent question'};
const keep = {...row,id:'33333333-3333-4333-8333-333333333333',title:'An older conversation'};
const snapshot = (rows, cursor, failed=[]) => ({...ok(rows,cursor),data:{...ok(rows,cursor).data,listCoverageComplete:failed.length===0,pool:{failed}}});
async function openOlder(main) {
  main.querySelector('.chat-more').click();
  await vi.advanceTimersByTimeAsync(1);
  expect(main.textContent).toContain(previous.title);
}
it('refreshes the loaded window and uses its new continuation',async()=>{
  const {main,page}=await boot(path=>{
    if(path.includes('cursor=older')) return snapshot([previous,keep],'old-tail');
    if(path.includes('limit=100')) return snapshot([row,keep],'new-tail');
    if(path.includes('cursor=new-tail')) return snapshot([]);
    return snapshot([row],'older');
  });
  await openOlder(main);
  await page.loadList(false);
  expect(main.textContent).not.toContain(previous.title);
  expect(main.textContent).toContain(keep.title);
  await page.loadList(true);
  expect(calls.at(-1).path).toContain('cursor=new-tail');
  expect(main.querySelector('.chat-more').hidden).toBe(true);
});
it('keeps rows and the cursor when the wider response is partial',async()=>{
  const {main,page}=await boot(path=>{
    if(path.includes('cursor=older')) return snapshot([previous,keep],'old-tail');
    if(path.includes('limit=100')) return snapshot([row],null,[{machineId:'Fixture Mac'}]);
    return snapshot([row],'older');
  });
  await openOlder(main);
  await page.loadList(false);
  expect(main.textContent).toContain(previous.title);
  expect(main.textContent).toContain(keep.title);
  expect(main.textContent).toContain('Fixture Mac');
  expect(page.meta.nextCursor).toBe('old-tail');
});
it('refreshes at its own depth when another tab used a different limit',async()=>{
  const {main,page}=await boot(path=>path.includes('limit=100')?snapshot([row,keep]):path.includes('cursor=older')?snapshot([previous,keep]):snapshot([row],'older'));
  await openOlder(main);
  page.applyResult({mode:'list',listLimit:50,data:snapshot([row],'older').data});
  await vi.advanceTimersByTimeAsync(1);
  expect(main.textContent).not.toContain(previous.title);
  expect(main.textContent).toContain(keep.title);
  expect(calls.filter(c=>c.path.includes('limit=100'))).toHaveLength(1);
});
it('uses a matching broadcast without another signed list read', async()=>{
  const {main,page}=await boot(path=>path.includes('cursor=older')?snapshot([previous,keep]):snapshot([row],'older'));
  await openOlder(main);
  const count=calls.filter(c=>c.path.startsWith('/mobile/conversations?')).length;
  page.applyResult({mode:'list-window',listLimit:100,data:snapshot([row,keep]).data});
  expect(main.textContent).not.toContain(previous.title);
  expect(main.textContent).toContain(keep.title);
  expect(calls.filter(c=>c.path.startsWith('/mobile/conversations?'))).toHaveLength(count);
});
it('does not put widened rows into a tab that never opened them',async()=>{
  const {main,page}=await boot(()=>snapshot([row],'older'));
  page.applyResult({mode:'list-window',listLimit:100,data:snapshot([row,keep]).data});
  await vi.advanceTimersByTimeAsync(1);
  expect(main.textContent).not.toContain(keep.title);
  expect(page.meta.nextCursor).toBe('older');
  expect(calls.filter(c=>c.path.includes('limit=100'))).toHaveLength(0);
});
it('keeps the matching broadcast when the earlier read finishes',async()=>{
  const pending=deferred();
  const {main,page}=await boot(path=>path.includes('limit=100')?pending.promise:path.includes('cursor=older')?snapshot([previous,keep]):snapshot([row],'older'));
  await openOlder(main);
  const refresh=page.loadList(false);
  page.applyResult({mode:'list-window',listLimit:100,data:snapshot([row,keep]).data});
  expect(main.textContent).toContain(keep.title);
  pending.resolve(snapshot([row,previous]));
  await refresh;
  expect(main.textContent).not.toContain(previous.title);
});
it('retains a loaded window when a widened response lacks coverage metadata',async()=>{
  const {main,page}=await boot(path=>path.includes('limit=100')?ok([row],null):path.includes('cursor=older')?snapshot([previous,keep]):snapshot([row],'older'));
  await openOlder(main);
  await page.loadList(false);
  expect(main.textContent).toContain(previous.title);
  expect(main.textContent).toContain('Your last loaded list is still shown');
});
it('sends widened results using a mode that older dashboard tabs ignore', async () => {
  const {main,page}=await boot(path=>path.includes('limit=100')?snapshot([row,keep]):path.includes('cursor=older')?snapshot([previous,keep]):snapshot([row],'older'));
  await openOlder(main);
  const send = vi.spyOn(page, 'post');
  page.scheduler.setConversations([], Date.now());
  const task = page.scheduler.tasks().find(task => task.mode === 'list');
  await page.runTask(task);
  expect(send).toHaveBeenCalledWith(expect.objectContaining({mode:'list-window',listLimit:100}));
  expect(send).not.toHaveBeenCalledWith(expect.objectContaining({mode:'list'}));
});
