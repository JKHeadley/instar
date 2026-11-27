import express, { type Request } from 'express';
import request from 'supertest';
import { registerWorkBoardRoutes, type WorkBoardRouteDeps, type ResolvedCaller } from '../../src/server/workBoardRoutes.js';
import { describe, it, expect } from 'vitest';
import type { HlcTimestamp } from '../../src/core/HybridLogicalClock.js';
import { WorkBoardService, resolveWorkBoardSettings, type WorkPrincipal } from '../../src/core/WorkBoardService.js';
import { workCardRecordStoreSchema, type UnionEntry } from '../../src/core/WorkCardStore.js';
import { sourceCardQuery, sourceCardsJson } from '../../src/core/workSourceCards.js';
const OWNER: WorkPrincipal = {kind:'person',personKey:'justin',proof:'pin',isOwner:true};
const viewer={isOwner:true,isAgent:false,personKey:'justin'};
function makeService(over: Partial<{ maxAgentCardsPerDay: number; softOpenCards: number }> = {}) {
  const journal: UnionEntry[] = [];
  let clock = Date.parse('2026-11-12T20:00:00Z');
  let logical = 0;
  const settings = resolveWorkBoardSettings({ maxAgentCardsPerDay: over.maxAgentCardsPerDay ?? 200, softOpenCards: over.softOpenCards ?? 30 });
  const svc = new WorkBoardService({
    machineId: 'm_a',
    emit: (_key, build) => {
      const hlc: HlcTimestamp = { physical: clock, logical: logical++, node: 'm_a' };
      const data = build(hlc, 'm_a');
      if (!data) return { outcome: 'skipped' };
      if (!workCardRecordStoreSchema.validate(data, { countDroppedField: () => {}, countJailReject: () => {} } as never)) return { outcome: 'dropped:invalid' };
      journal.push({ data, origin: 'm_a' });
      return { outcome: 'emitted', seq: journal.length, hlc };
    },
    loadUnion: () => journal,
    now: () => clock,
    settings: () => settings,
    ownerPersonKey: () => 'justin',
    detectCredential: (t) => (/sk-ant-[A-Za-z0-9]{10,}/.test(t) ? 'anthropic-api-key' : null),
    dayOf: (ms) => ({ day: new Date(ms).toISOString().slice(0, 10), resetsAt: new Date(Math.ceil(ms / 86_400_000) * 86_400_000).toISOString() }),
    displayName: (k) => (k === 'justin' ? 'Justin' : k),
  });
  return { svc, journal, advance: (ms: number) => { clock += ms; } };
}

const card = { title: 'Pick a venue', need: 'Choose one', doneWhen: [{ id: 'd1', text: 'Booked', certify: 'agent-may-certify' }], outward: false };


describe('source conversation card projection', () => {
 it('filters before board limits, pages stably and excludes redacted cards before counts', () => {
  const {svc}=makeService({softOpenCards:2});
  const ids:string[]=[];
  for(let n=0;n<57;n++) { const r=svc.createCard(OWNER,{...card,title:`Card ${n}`,source:{conversationKey:'telegram:42',messageId:String(n)}}); if(!r.ok)throw Error('fixture'); ids.push(r.cardId); }
  expect(svc.tap(OWNER,ids[0],{action:'redact'}).ok).toBe(true);
  expect(svc.createCard(OWNER,{...card,source:{conversationKey:'telegram:420',messageId:'other'}}).ok).toBe(true);
  const first=sourceCardsJson(svc,viewer,'telegram:42',0,k=>k);
  const second=sourceCardsJson(svc,viewer,'telegram:42',1,k=>k);
  expect(first).toMatchObject({total:56,nextPage:1,newestHlc:svc.newestHlc()});
  expect(first.cards).toHaveLength(50);expect(second.cards).toHaveLength(6);expect(second.nextPage).toBeNull();
  const shown=[...first.cards,...second.cards].map(c=>c.id as string);
  expect(new Set(shown).size).toBe(56);expect(shown).not.toContain(ids[0]);
  expect(shown).toEqual([...shown].sort());
  expect(sourceCardsJson(svc,viewer,'telegram:42',2,k=>k)).toMatchObject({cards:[],total:56,nextPage:null});
  expect(sourceCardsJson(svc,viewer,'telegram:4',0,k=>k)).toMatchObject({cards:[],total:0,nextPage:null});
 });
 it('detects a delayed lower-HLC peer edit even when the maximum HLC and count stay unchanged',()=>{
  const {svc,journal,advance}=makeService();
  const made=svc.createCard(OWNER,{...card,source:{conversationKey:'telegram:42',messageId:'m'}});if(!made.ok)throw Error('fixture');
  advance(100);expect(svc.edit({kind:'agent'},made.cardId,{title:'Changed later'}).ok).toBe(true);
  const delayed=journal.pop()!;svc.rebuild();advance(1000);svc.createCard(OWNER,card);
  const before=sourceCardsJson(svc,viewer,'telegram:42',0,k=>k);
  svc.apply([delayed]);const after=sourceCardsJson(svc,viewer,'telegram:42',0,k=>k);
  expect(after.cards[0].title).toBe('Changed later');expect(after.total).toBe(before.total);expect(after.newestHlc).toEqual(before.newestHlc);expect(after.sourceRevision).not.toBe(before.sourceRevision);
 });
 it('keeps open cards before a newer archived card',()=>{
  const {svc,advance}=makeService();const open=svc.createCard(OWNER,{...card,source:{conversationKey:'telegram:42',messageId:'m1'}});advance(1000);
  const closed=svc.createCard(OWNER,{...card,source:{conversationKey:'telegram:42',messageId:'m2'}});if(!open.ok||!closed.ok)throw Error('fixture');
  expect(svc.tap(OWNER,closed.cardId,{action:'archive'}).ok).toBe(true);
  expect(sourceCardsJson(svc,viewer,'telegram:42',0,k=>k).cards.map(c=>c.id)).toEqual([open.cardId,closed.cardId]);
 });
 it('refuses source association projection for members, including shared cards',()=>{
  expect(()=>sourceCardsJson(makeService().svc,{isOwner:false,isAgent:false,personKey:'adriana'},'telegram:42',0,k=>k)).toThrow('owner-required');
 });
 it('returns the current journal version even for an empty exact match',()=>{
  const {svc}=makeService();expect(sourceCardsJson(svc,viewer,'app:x',0,k=>k).newestHlc).toBeNull();
  svc.createCard(OWNER,card);expect(sourceCardsJson(svc,viewer,'app:x',0,k=>k).newestHlc).toEqual(svc.newestHlc());
 });
});
describe('explicit source query',()=>{
 it('leaves ordinary board queries alone',()=>expect(sourceCardQuery({donePage:'1'})).toEqual({kind:'board'}));
 it('keeps exact opaque source keys and defaults only the page',()=>{
  expect(sourceCardQuery({sourceConversationKey:'app:some key'})).toEqual({kind:'source',key:'app:some key',page:0});
  expect(sourceCardQuery({sourceConversationKey:'telegram:42',sourcePage:'2'})).toEqual({kind:'source',key:'telegram:42',page:2});
 });
 it.each([{},[],['telegram:42'],'',' '.repeat(2),'x'.repeat(201),'x\n'])('rejects malformed source keys %j',key=>{
  expect(sourceCardQuery({sourceConversationKey:key})).toEqual({kind:'invalid'});
 });
 it.each(['-1','1.2','01','1e2','Infinity','9007199254740991',[],['1'],{},1])('rejects malformed pages %j',page=>{
  expect(sourceCardQuery({sourceConversationKey:'telegram:42',sourcePage:page})).toEqual({kind:'invalid'});
 });
 it('refuses page-only queries',()=>expect(sourceCardQuery({sourcePage:'1'})).toEqual({kind:'invalid'}));
});


describe('source query route boundaries', () => {
 function routes(caller:ResolvedCaller, enabled=true) {
  const {svc}=makeService();svc.createCard(OWNER,{...card,source:{conversationKey:'telegram:42',messageId:'m'}});
  let shared!: Parameters<NonNullable<WorkBoardRouteDeps['exposeBoardRead']>>[0];
  const deps={enabled:()=>enabled,svc:()=>svc,controller:()=>null,settings:()=>resolveWorkBoardSettings({}),caller:()=>caller,
   ownerPersonKey:()=> 'justin',displayName:(k:string)=>k,behind:()=>null,lastWrittenOn:()=>null,repliedAfterQuestion:()=>false,
   brokenAttachments:()=>[],exposeBoardRead:(read:typeof shared)=>{shared=read;}} as unknown as WorkBoardRouteDeps;
  const app=express();const router=express.Router();registerWorkBoardRoutes(router,deps);app.use(router);return {app,shared};
 }
 it('both read surfaces use the source projection; the shared Needs-you reader keeps ordinary lanes',async()=>{
  const {app,shared}=routes({kind:'bearer'});
  for(const prefix of ['/work-board','/mobile/work-board']){
   const r=await request(app).get(prefix+'?sourceConversationKey=telegram%3A42');expect(r.status).toBe(200);expect(r.body.total).toBe(1);expect(r.body.cards).toHaveLength(1);expect(r.body.lanes).toBeUndefined();
  }
  const r=shared({query:{sourceConversationKey:'telegram:42'}} as unknown as Request);expect(r.status).toBe(200);expect(r.body).toHaveProperty('lanes');expect(r.body).not.toHaveProperty('cards');
 });
 it.each([
  [{kind:'device',personKey:'member',isOwner:false,mayRead:()=>true},403],
  [{kind:'session',conversationKey:'known'},403],
  [{kind:'none'},401],
 ] as Array<[ResolvedCaller,number]>)('refuses source association to %j',async(caller,status)=>{
  const {app}=routes(caller);const r=await request(app).get('/work-board?sourceConversationKey=telegram%3A42');expect(r.status).toBe(status);expect(r.body).not.toHaveProperty('total');expect(r.body).not.toHaveProperty('cards');
 });
 it('accepts owner device, refuses malformed query and reports feature-off',async()=>{
  const owner:ResolvedCaller={kind:'device',personKey:'justin',isOwner:true,mayRead:()=>true};const {app}=routes(owner);
  expect((await request(app).get('/mobile/work-board?sourceConversationKey=telegram%3A42')).status).toBe(200);
  expect((await request(app).get('/work-board?sourcePage=1')).status).toBe(400);
  expect((await request(app).get('/work-board?sourceConversationKey=one&sourceConversationKey=two')).status).toBe(400);
  const disabled=await request(routes(owner,false).app).get('/work-board?sourceConversationKey=one');expect(disabled.status).toBe(503);expect(disabled.body.error).toBe('work-board-disabled');
 });
});
