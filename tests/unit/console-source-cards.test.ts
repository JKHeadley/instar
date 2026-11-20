import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
// @ts-expect-error Browser module has no declaration.
import { mountSourceCards } from '../../dashboard/console/conversation-source-cards.js';
const key='telegram:42';
const hlc={physical:42,logical:1,node:'m_a'};
const cards=(n:number,start=0)=>Array.from({length:n},(_,i)=>({id:`wc_${(i+start).toString(16).padStart(16,'0')}`,title:`Card ${i+start}`,needLine:'Yours to do',source:{conversationKey:key,messageId:String(i+start)}}));
const ok=(rows:unknown[],total=rows.length,nextPage:number|null=null,version:unknown=hlc)=>({ok:true,status:200,data:{cards:rows,total,nextPage,newestHlc:version,sourceRevision:"a".repeat(64),behind:null}});
const tick=()=>new Promise(r=>setTimeout(r,0));
function rig(){const dom=new JSDOM('<main></main>');vi.stubGlobal('document',dom.window.document);vi.stubGlobal('window',dom.window);dom.window.scrollTo=()=>{};return dom.window.document.querySelector('main')!;}
function button(host:Element,text:string){const b=[...host.querySelectorAll('button')].find(b=>b.textContent===text);expect(b,`button ${text}`).toBeTruthy();b!.click();}
afterEach(()=>vi.unstubAllGlobals());
describe('conversation source cards',()=>{
 it('starts with three, expands deliberately and appends only the same structural HLC',async()=>{
  const host=rig();const read=vi.fn().mockResolvedValueOnce(ok(cards(50),52,1)).mockResolvedValueOnce(ok(cards(2,50),52,null,{...hlc}));
  await mountSourceCards({host,key,read,current:()=>true,unlock:vi.fn()});
  expect(host.querySelectorAll('a')).toHaveLength(3);expect(read).toHaveBeenCalledWith('/work-board?sourceConversationKey=telegram%3A42&sourcePage=0');
  button(host,'Show 47 more here');expect(host.querySelectorAll('a')).toHaveLength(50);
  button(host,'Load more cards');await tick();expect(host.querySelectorAll('a')).toHaveLength(52);expect(host.textContent).toContain('52 of 52');
  expect(host.querySelector('a')!.getAttribute('href')).toBe('#/work/board?card=wc_0000000000000000');
  button(host,'Show fewer');expect(host.querySelectorAll('a')).toHaveLength(3);
 });
 it('refuses to combine changed versions and reloads from the first page',async()=>{
  const host=rig();const read=vi.fn().mockResolvedValueOnce(ok(cards(50),51,1)).mockResolvedValueOnce(ok(cards(1,50),51,null,{...hlc,logical:2})).mockResolvedValueOnce(ok(cards(1)));
  await mountSourceCards({host,key,read,current:()=>true,unlock:vi.fn()});button(host,'Show 47 more here');button(host,'Load more cards');await tick();
  expect(host.textContent).toContain('may be out of date');expect(host.querySelectorAll('a')).toHaveLength(50);button(host,'Reload cards');await tick();
  expect(host.querySelectorAll('a')).toHaveLength(1);expect(host.textContent).not.toContain('may be out of date');expect(read.mock.calls[2][0]).toContain('sourcePage=0');
 });
 it('rejects changed source revision even when HLC and count are identical',async()=>{
  const host=rig();const later=ok(cards(1,50),51);later.data.sourceRevision='b'.repeat(64);
  const read=vi.fn().mockResolvedValueOnce(ok(cards(50),51,1)).mockResolvedValueOnce(later);
  await mountSourceCards({host,key,read,current:()=>true,unlock:vi.fn()});button(host,'Show 47 more here');button(host,'Load more cards');await tick();
  expect(host.textContent).toContain('cards changed');expect(host.querySelectorAll('a')).toHaveLength(50);
 });
 it('distinguishes failed, catching-up, empty and disabled reads',async()=>{
  const host=rig();const read=vi.fn().mockResolvedValueOnce({ok:false,status:500}).mockResolvedValueOnce({...ok([]),data:{...ok([]).data,behind:{machineId:'secret-machine'}}});
  await mountSourceCards({host,key,read,current:()=>true,unlock:vi.fn()});expect(host.textContent).toContain('could not be loaded');expect(host.textContent).not.toContain('No cards');
  button(host,'Try again');await tick();expect(host.textContent).toContain('catching up');expect(host.textContent).not.toContain('secret-machine');expect(host.textContent).not.toContain('No cards');
  await mountSourceCards({host,key,read:async()=>ok([],0,null,null),current:()=>true,unlock:vi.fn()});expect(host.textContent).toContain('No cards');
  await mountSourceCards({host,key,read:async()=>({ok:false,status:503,data:{error:'work-board-disabled'}}),current:()=>true,unlock:vi.fn()});expect(host.textContent).toBe('');
 });
 it('never treats malformed or duplicate pages as an empty or complete list',async()=>{
  const host=rig();const read=vi.fn().mockResolvedValueOnce(ok(cards(50),51,1)).mockResolvedValueOnce(ok(cards(1),51));
  await mountSourceCards({host,key,read,current:()=>true,unlock:vi.fn()});button(host,'Show 47 more here');button(host,'Load more cards');await tick();
  expect(host.textContent).toContain('could not be read');expect(host.querySelectorAll('a')).toHaveLength(50);
  await mountSourceCards({host,key,read:async()=>ok([{...cards(1)[0],source:{conversationKey:'other'}}]),current:()=>true,unlock:vi.fn()});expect(host.textContent).toContain('could not be read');expect(host.querySelectorAll('a')).toHaveLength(0);
 });
 it('does not apply a response after navigation and asks to unlock on refusal',async()=>{
  const host=rig();let resolve!:(v:unknown)=>void;let current=true;const unlock=vi.fn();
  const run=mountSourceCards({host,key,read:()=>new Promise(r=>{resolve=r;}),current:()=>current,unlock});current=false;resolve(ok(cards(1)));await run;expect(host.querySelectorAll('a')).toHaveLength(0);
  await mountSourceCards({host,key,read:async()=>({ok:false,needsUnlock:true}),current:()=>true,unlock});expect(unlock).toHaveBeenCalledOnce();
 });
 it('renders titles as text, never HTML',async()=>{
  const host=rig();await mountSourceCards({host,key,read:async()=>ok([{...cards(1)[0],title:'<img src=x onerror=alert(1)>'}]),current:()=>true,unlock:vi.fn()});expect(host.querySelector('img')).toBeNull();expect(host.textContent).toContain('<img');
 });
});
