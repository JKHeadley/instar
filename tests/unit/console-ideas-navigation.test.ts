import { JSDOM } from 'jsdom';
import { describe, it, afterEach, vi } from 'vitest';
import { renderIdeas } from '../../dashboard/console/ideas.js';
import { askPin, closeSheet } from '../../dashboard/console/ui.js';
import assert from 'node:assert/strict';
const originalFetch = globalThis.fetch;
const originalTimeout = globalThis.setTimeout;
let latestDom;
afterEach(() => { closeSheet(); latestDom?.window.close(); vi.unstubAllGlobals(); globalThis.fetch = originalFetch; globalThis.setTimeout = originalTimeout; });
const results=[];const tick=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
const summary=()=>({neverRun:true,funnel:{seen:0,verified:0,decided:0,adopted:0,audited:0,bands:{now:0}},admission:[],ideas:[{id:'fixture',band:'plan',claim:'Suggestion',project:'Fixture',bandReason:'Review'}],watchlist:[],proposals:[]});
function page(){const dom=new JSDOM('<main></main>',{url:'https://fixture.invalid/dashboard',pretendToBeVisual:true});for (const [key,value] of Object.entries({window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage,requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window)})) vi.stubGlobal(key,value);latestDom=dom;return {dom,main:document.querySelector('main')};}
describe('Ideas decision source lifetime', () => {
for(const delay of ['plan','unlock'])for(const target of ['another page','newer Ideas view','detached main'])for(const accepted of [true,false]){
it(`keeps a late ${delay} response from opening a dialog after ${target}, address accepted=${accepted}`, async () => {
 const {dom,main}=page();let finish;const pending=new Promise(r=>finish=r);const calls=[];
 const api={get:async()=>({ok:true,data:summary()})};
 globalThis.fetch=async(path)=>{calls.push(path);return {ok:true,status:200,json:async()=>{if((delay==='plan'&&path.endsWith('/plan'))||(delay==='unlock'&&path.endsWith('/unlock-check')))await pending;return path.endsWith('/plan')?{renderedText:'Decline fixture',planId:'fixture',nonce:'fixture'}:{accepted,reason:'Fixture refusal'};}};};
 await renderIdeas(main,api);[...main.querySelectorAll('button')].find(b=>b.textContent==='Decline').click();await tick();
 if(target==='another page'){const next=document.createElement('main');next.textContent='Accounts';document.body.replaceChildren(next);}
 if(target==='newer Ideas view')await renderIdeas(main,api);
 if(target==='detached main')main.remove();
 finish();await tick();
 assert.equal(document.querySelector('[aria-label="Dashboard PIN"]'),null);
 assert.equal(document.querySelector('[role="dialog"]'),null);
 assert.equal(calls.filter(p=>p.endsWith('/commit')).length,0);
 if(target==='another page')assert.equal(document.body.textContent,'Accounts');
 results.push({delay,target,accepted,pass:true});closeSheet();dom.window.close();
});
}
for(const mode of ['submit','cancel','plan error','commit error']){
it(`preserves the current decision behavior: ${mode}`, async () => {
 const {dom,main}=page();const calls=[];
 globalThis.fetch=async(path,opts)=>{calls.push({path,body:opts?.body});return {ok:true,status:mode==='plan error'&&path.endsWith('/plan')?503:mode==='commit error'&&path.endsWith('/commit')?503:200,json:async()=>path.endsWith('/plan')?{renderedText:'Decline fixture',planId:'fixture',nonce:'fixture',error:'Fixture plan failed'}:path.endsWith('/commit')?{error:'Fixture commit failed'}:{accepted:true}};};
 await renderIdeas(main,{get:async()=>({ok:true,data:summary()})});[...main.querySelectorAll('button')].find(b=>b.textContent==='Decline').click();await tick();
 if(mode==='plan error'){assert.match(main.textContent,/Fixture plan failed/);assert.equal(document.querySelector('.pin-form'),null);}
 else{
  assert.ok(document.querySelector('.pin-form'));
  if(mode==='cancel'){closeSheet();await tick();assert.equal(calls.filter(c=>c.path.endsWith('/commit')).length,0);}
  else{const input=document.querySelector('.pin-input');input.value='fixture-only';document.querySelector('.pin-form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));await tick();const commits=calls.filter(c=>c.path.endsWith('/commit'));assert.equal(commits.length,1);assert.deepEqual(JSON.parse(commits[0].body),{pin:'fixture-only',planId:'fixture',nonce:'fixture'});assert.match(main.textContent,mode==='submit'?/Done\./:/Fixture commit failed/);}
 }
 results.push({mode,pass:true});closeSheet();dom.window.close();
});
}
// Saved decisions complete exactly once, and their delayed repaint belongs only to the original card.
for(const timing of ['during commit','after commit'])for(const target of ['another page','newer Ideas view','detached main','active view']){
it(`finishes one commit and keeps refresh with its source: ${target}, ${timing}`, async () => {
 const {dom,main}=page();let finish;const pending=new Promise(r=>finish=r);let reads=0;let commits=0;const timers=[];
 const nativeTimeout=globalThis.setTimeout;
 const api={get:async()=>{reads++;return {ok:true,data:summary()};}};
 globalThis.fetch=async(path)=>({ok:true,status:200,json:async()=>{if(path.endsWith('/commit')){commits++;await pending;return {ok:true};}return path.endsWith('/plan')?{renderedText:'Decline fixture',planId:'fixture',nonce:'fixture'}:{accepted:true};}});
 await renderIdeas(main,api);[...main.querySelectorAll('button')].find(b=>b.textContent==='Decline').click();await tick();
 document.querySelector('.pin-input').value='fixture-only';
 globalThis.setTimeout=(fn,ms,...args)=>ms===600?(timers.push(fn),1):nativeTimeout(fn,ms,...args);
 document.querySelector('.pin-form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));await tick();
 assert.equal(commits,1);
 const navigate=async()=>{if(target==='another page'){const next=document.createElement('main');next.textContent='Accounts';document.body.replaceChildren(next);}if(target==='newer Ideas view')await renderIdeas(main,api);if(target==='detached main')main.remove();};
 if(timing==='during commit')await navigate();
 finish();await tick();assert.equal(timers.length,1);
 if(timing==='after commit')await navigate();
 const requests=reads,before=document.body.innerHTML;
 for(const timer of timers)timer();await tick();
 assert.equal(commits,1);
 if(target==='active view'){assert.equal(reads,requests+1);assert.match(main.textContent,/Suggestion/);}else{assert.equal(reads,requests);assert.equal(document.body.innerHTML,before);}
 results.push({timing,target,commitRefresh:true,pass:true});globalThis.setTimeout=nativeTimeout;closeSheet();dom.window.close();
});
}
// Existing callers may omit the optional lifecycle callback.
it('preserves callers that omit the optional source callback', async () => {
 const {dom}=page();globalThis.fetch=async()=>({ok:true,json:async()=>({accepted:true})});const result=askPin({title:'Default caller'});await tick();assert.ok(document.querySelector('.pin-form'));closeSheet();assert.equal(await result,null);results.push({mode:'default helper compatibility',pass:true});dom.window.close();
});
});
