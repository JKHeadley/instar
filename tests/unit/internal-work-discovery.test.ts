import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import { AppConversationStore } from '../../src/core/AppConversationStore.js';
import { ConversationReadMarkerStore } from '../../src/core/ConversationReadMarkers.js';
import { ConversationUnreadService, type Reader } from '../../src/core/ConversationUnreadService.js';
import { searchLocal, type ConversationSearchRouteDeps } from '../../src/server/mobileConversationSearchRoutes.js';
import { searchMeaningLocal } from '../../src/server/conversationMeaningSearch.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
const INTERNAL='11111111-1111-4111-8111-111111111111';
const REQUEST='22222222-2222-4222-8222-222222222222';
const NORMAL='33333333-3333-4333-8333-333333333333';
const stores:AppConversationStore[]=[],dirs:string[]=[],readers:ConversationUnreadService[]=[];
afterEach(()=>{for(const r of readers)r.stop();readers.length=0;for(const s of stores)s.close();stores.length=0;for(const d of dirs)SafeFsExecutor.safeRmSync(d,{recursive:true,force:true,operation:'tests/unit/internal-work-discovery.test.ts'});dirs.length=0;});
function fixture(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'internal-work-discovery-'));dirs.push(dir);
 const store=new AppConversationStore({stateDir:dir,machineId:()=> 'm1'});stores.push(store);
 for(const [i,key] of [NORMAL,REQUEST,INTERNAL].entries()){
  store.append({eventId:'created-'+i,kind:'created',conversationKey:key,title:i===2?'Internal registry work':'Requested registry work',at:new Date(1000+i*100).toISOString(),machineId:'m1'});
  store.append({eventId:'message-'+i,kind:'message',conversationKey:key,messageId:'msg-'+i,role:'agent',text:'Registry progress',at:new Date(2000+i*100).toISOString(),machineId:'m1'});
 }
 const hidden=new Set([INTERNAL]);store.hiddenConversationKeys=()=>hidden;
 const deps={service:{store,liveConversation:(key:string)=>store.getConversation(key)},machineId:()=> 'm1',config:{},pairing:{}} as unknown as ConversationSearchRouteDeps;
 return {dir,store,hidden,deps};
}
describe('One internal-work classification across human discovery',()=>{
 it('fills visible pages before cutting and retains all execution/history and creation inventory',()=>{
  const {store}=fixture();const first=store.listConversations({limit:1});
  expect(first.conversations.map(c=>c.conversationKey)).toEqual([REQUEST]);expect(first.nextCursor).toBeTruthy();
  expect(store.listConversations({limit:1,cursor:first.nextCursor}).conversations.map(c=>c.conversationKey)).toEqual([NORMAL]);
  expect(store.getConversation(INTERNAL)?.tombstoned).toBe(false);
  expect(store.browseMessages(INTERNAL,null,10).messages).toHaveLength(1);
  expect(store.creationInventoryPage({limit:10}).conversations.map(c=>c.conversationKey)).toContain(INTERNAL);
 });
 it('normalizes exact refs and reflects a real owner-facing transition without deleting old history',()=>{
  const {store,hidden}=fixture();expect(store.isHiddenConversation('app:'+INTERNAL)).toBe(true);
  hidden.clear();expect(store.isHiddenConversation(INTERNAL)).toBe(false);
  expect(store.listConversations().conversations.map(c=>c.conversationKey)).toContain(INTERNAL);
  expect(store.browseMessages(INTERNAL,null,10).messages).toHaveLength(1);
 });
 it('reports classification failure instead of showing internal rows or claiming an empty list',()=>{
  const {store}=fixture();store.hiddenConversationKeys=()=>{throw Error('unreadable classifier');};
  expect(()=>store.listConversations()).toThrow('work-card-visibility-unavailable');
  expect(()=>store.creationInventoryPage({limit:10})).not.toThrow();
 });
 it('excludes internal history from scoped and unscoped keyword discovery',()=>{
  const {deps}=fixture();const access={may:()=>true,mayReadApp:()=>true};
  expect(searchLocal(deps,{terms:['registry'],limit:50,only:'app:'+INTERNAL},access).results).toEqual([]);
  const refs=searchLocal(deps,{terms:['registry'],limit:50,only:null},access).results.map(h=>h.ref);
  expect(refs).toContain('app:'+REQUEST);expect(refs).not.toContain('app:'+INTERNAL);
 });
 it('does not query the meaning index for a hidden ref and rejects stale hidden hits from an index',()=>{
  const {deps}=fixture();const search=vi.fn(()=>[
   {ref:'app:'+INTERNAL,key:'message-2',similarity:.99},
   {ref:'app:'+REQUEST,key:'message-1',similarity:.95},
  ]);
  const meaning={index:{search}} as never,access={may:()=>true,mayReadApp:()=>true},queryVec=new Float32Array([1]);
  expect(searchMeaningLocal(deps,meaning,{queryVec,terms:['registry'],limit:50,only:'app:'+INTERNAL},access).results).toEqual([]);
  expect(search).not.toHaveBeenCalled();
  const refs=searchMeaningLocal(deps,meaning,{queryVec,terms:['registry'],limit:50,only:null},access).results.map(h=>h.ref);
  expect(refs).toContain('app:'+REQUEST);expect(refs).not.toContain('app:'+INTERNAL);
 });
 it('keeps hidden history and a new reply trigger out of the owner unread badge',()=>{
  const {store,dir}=fixture();const markers=new ConversationReadMarkerStore({stateDir:dir});
  markers.setBaseline('owner',0);
  const person={ok:true,role:'owner',userId:null,name:'Justin',telegramUserId:42} as const;
  const unread=new ConversationUnreadService({store:markers,enabled:()=>true,machineId:()=> 'm1',app:store,ownerIdentity:()=>({ownerName:'Justin',telegramOwnerId:42,slackOwnerUserId:null}),personOfReaderKey:()=>person,mayUse:()=>true,authToken:()=> 'fixture-token',now:()=>5000});
  readers.push(unread);const reader:Reader={key:'owner',person,viaDevice:true};
  expect(unread.rowFields(reader,{platform:'app',id:INTERNAL,lastActivity:new Date(2200).toISOString()})).toBeNull();
  expect(unread.badgeFor(reader)).toBe(2);
  expect(unread.badgeFor(reader,{conversationKey:INTERNAL,messageId:'new-not-replicated-yet'})).toBe(2);
  expect(unread.badgeFor(reader,{conversationKey:REQUEST,messageId:'new-not-replicated-yet'})).toBe(3);
 });
});
