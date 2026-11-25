import { afterEach, describe, expect, it } from 'vitest';
import { WorkBoardRuntime, type WorkBoardRuntimeSeams } from '../../src/core/WorkBoardRuntime.js';
import { type WorkPrincipal } from '../../src/core/WorkBoardService.js';
import { workCardRecordStoreSchema, requestTextHashOf, requestCardId, isAgentInternalCard, type UnionEntry } from '../../src/core/WorkCardStore.js';
import type { HlcTimestamp } from '../../src/core/HybridLogicalClock.js';
const OWNER: WorkPrincipal={kind:'person',personKey:'justin',proof:'pin',isOwner:true};
const AGENT: WorkPrincipal={kind:'agent'};
const SERVER: WorkPrincipal={kind:'agent',server:true};
const TEXT='Please fix the venue list before Friday.';
function machine(opts: { live?: () => boolean | null; rateLimit?: () => boolean; settings?: Record<string, unknown>; holder?: string } = {}) {
  const journal: UnionEntry[] = [];
  const world = { clock: Date.parse('2026-11-20T20:00:00Z'), logical: 0 };
  const events = new Map<string, Array<{ eventId: string; text: string; at: string; writer: string }>>();
  const briefs: Array<{ ck: string; text: string }> = [];
  const logs: string[] = [];
  let holder = opts.holder ?? 'm1';
  const seams: WorkBoardRuntimeSeams = {
    machineId: 'm1', enabled: () => true, rawSettings: () => opts.settings ?? {}, saveSettings: () => true,
    emit: (_k, build) => {
      const hlc: HlcTimestamp = { physical: world.clock, logical: world.logical++, node: 'm1' };
      const data = build(hlc, 'm1'); if (!data) return { outcome: 'skipped' };
      if (!workCardRecordStoreSchema.validate(data, { countDroppedField: () => {} } as never)) return { outcome: 'dropped:invalid' };
      journal.push({ data, origin: 'm1' }); return { outcome: 'emitted', seq: journal.length, hlc };
    },
    awaitDurable: async () => {}, loadUnion: () => journal, journalBytes: () => 0,
    conversation: {
      create: () => {}, exists: () => true, appendSystemLine: () => {}, remove: () => {}, serves: () => true, aliasFor: () => 7, hasLiveSession: () => false,
      dispatchSystem: async (i) => { briefs.push({ ck: i.conversationKey, text: i.text }); return { outcome: 'spawned' }; },
      injectLive: () => false, attachment: () => null, lastPersonMessageAt: () => null,
      appendNoteEvent: (ck, eventId, text, writer) => {
        if (opts.rateLimit?.()) return 'rate-limited';
        const list = events.get(ck) ?? []; if (list.some((e) => e.eventId === eventId)) return 'duplicate';
        list.push({ eventId, text, at: new Date(world.clock).toISOString(), writer }); events.set(ck, list); return 'appended';
      },
      noteEvent: (ck, eventId) => { const e = events.get(ck)?.find((x) => x.eventId === eventId); return e ? { text: e.text, at: e.at } : null; },
      noteEventIds: (ck) => (events.get(ck) ?? []).map((e) => ({ eventId: e.eventId, at: e.at })),
      recordingSessionLive: (ck) => (opts.live ? opts.live() : false) ?? (ck ? null : null),
    },
    relayReady: () => true, capacityProbe: () => ({ ok: true }), ownerPersonKey: () => 'justin', displayName: () => 'Justin', timezone: () => 'UTC',
    detectCredential: (t) => (/sk-ant-[A-Za-z0-9]{10,}/.test(t) ? 'anthropic-api-key' : null), ledgerNote: () => {}, degradation: () => {},
    leaseHolder: () => holder, now: () => world.clock, log: (e, d) => logs.push(`${e} ${JSON.stringify(d)}`),
  };
  const rt = new WorkBoardRuntime(seams); rt.start();
  const ownerCard = (id = 'CMT-001') => {
    const r = rt.svc.createCard(SERVER, { title: 'Fix the venue list', need: TEXT, doneWhen: [{ id: 'd1', text: 'Tidy', certify: 'agent-may-certify' }], outward: false, source: { conversationKey: 'telegram:42', messageId: '1001' }, requester: { personKey: 'justin', isOwner: true }, requestTextHash: requestTextHashOf(TEXT), recordedAsHash: requestTextHashOf(TEXT), pickupHold: { kind: 'recording-session', conversationKey: 'telegram:42' }, refs: [{ kind: 'commitment', id: `m1:${id}` }] }, { cardId: requestCardId('m1', id) });
    if (!r.ok) throw new Error(r.error); return r.cardId;
  };
  return { rt, journal, events, briefs, logs, world, ownerCard, advance: (ms: number) => { world.clock += ms; }, setHolder: (h: string) => { holder = h; } };
}

const runtimes:WorkBoardRuntime[]=[];
afterEach(()=>{for(const rt of runtimes)rt.stop();runtimes.length=0;});
function fresh(){
 const m=machine();runtimes.push(m.rt);
 const seams=(m.rt as unknown as {seams:WorkBoardRuntimeSeams}).seams;
 const created=new Set<string>();
 seams.conversation.create=(_id,ck)=>{created.add(ck);};
 seams.conversation.exists=ck=>created.has(ck);
 seams.conversation.aliasFor=ck=>created.has(ck)?7:null;
 return {...m,seams,created};
}
function internal(m:ReturnType<typeof fresh>){
 const r=m.rt.svc.createCard(AGENT,{title:'Keep registry current',need:'Keep registry current',carrier:'agent',outward:false,doneWhen:[{id:'d1',text:'Checked',certify:'agent-may-certify'}]});
 if(!r.ok)throw Error(r.error);return m.rt.svc.view(r.cardId)!;
}
describe('Internal work does not create empty owner chats',()=>{
 it('scopes parked pickup summaries to the same classified card set', () => {
  const m=fresh(),v=internal(m);
  expect(m.rt.svc.setPolicy(OWNER,'outward-only').ok).toBe(true);
  const pickup=m.rt.svc.view(v.card.cardId)!.pickups.find(p=>p.status==='pending')!;
  expect(pickup).toBeTruthy();
  expect(m.rt.svc.writeSystem('dispatched',v.card.cardId,{for:pickup.cause.id,attempt:1,outcome:'parked',reason:'decision:test'}).ok).toBe(true);
  expect(m.rt.controller.status().parked).toBe(1);
  expect(m.rt.controller.status(v=>!isAgentInternalCard(v.card)).parked).toBe(0);
  expect(m.rt.controller.status(v=>isAgentInternalCard(v.card)).parked).toBe(1);
 });
 it('does not materialize an internal card on create or boot',()=>{
  const m=fresh(),v=internal(m);m.rt.ensureConversation(v.card.cardId);
  expect(m.created.size).toBe(0);
  expect(m.rt.conversationAvailable(v.card.cardId)).toBe(false);
  const reboot=new WorkBoardRuntime(m.seams);runtimes.push(reboot);reboot.start();
  expect(reboot.svc.cardIds()).toContain(v.card.cardId);
  expect(m.created.size).toBe(0);
  expect(reboot.hiddenConversationKeys().has(v.card.conversationKey)).toBe(true);
 });
 it('does not materialize an internal card arriving from a peer',()=>{
  const source=fresh(),v=internal(source),target=fresh();
  target.rt.onCommitted(source.journal.map(x=>({data:x.data})), 'm2');
  expect(target.rt.svc.cardIds()).toContain(v.card.cardId);
  expect(target.created.size).toBe(0);
 });
 it('retains normal conversation creation for verified owner-requested work',()=>{
  const m=fresh();const id=m.ownerCard();m.rt.ensureConversation(id);
  expect(m.created.has(m.rt.svc.view(id)!.card.conversationKey)).toBe(true);
 });
 it('creates the internal worker chat immediately before real dispatch and still hides it from owner discovery',async()=>{
  const m=fresh(),v=internal(m);
  expect(m.rt.svc.setPolicy(OWNER,'outward-only').ok).toBe(true);
  expect(m.created.size).toBe(0);
  await m.rt.controller.tick();
  expect(m.created.has(v.card.conversationKey)).toBe(true);
  expect(m.briefs).toHaveLength(1);
  expect(m.rt.conversationAvailable(v.card.cardId)).toBe(true);
  expect(m.briefs[0].ck).toBe(v.card.conversationKey);
  expect(m.rt.hiddenConversationKeys().has(v.card.conversationKey)).toBe(true);
 });
 it('an allowed progress note materializes internal worker history, but a policy-blocked note does not',()=>{
  const m=fresh(),v=internal(m);
  expect(m.rt.writeNote(AGENT,v.card.cardId,'Started','bearer:agent').ok).toBe(false);
  expect(m.created.size).toBe(0);
  expect(m.rt.svc.setPolicy(OWNER,'outward-only').ok).toBe(true);
  expect(m.rt.writeNote(AGENT,v.card.cardId,'Started','bearer:agent').ok).toBe(true);
  expect(m.created.has(v.card.conversationKey)).toBe(true);
  expect(m.rt.hiddenConversationKeys().has(v.card.conversationKey)).toBe(true);
  expect((m.rt as unknown as { drainNotes(max: number): number }).drainNotes(10)).toBe(1);
  expect(m.rt.conversationAvailable(v.card.cardId)).toBe(true);
  const reboot = new WorkBoardRuntime(m.seams); runtimes.push(reboot); reboot.start();
  expect(reboot.conversationAvailable(v.card.cardId)).toBe(true);
 });
});
