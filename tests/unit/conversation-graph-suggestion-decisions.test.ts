/**
 * The owner's Conversations suggestion decisions on every machine
 * (docs/specs/conversation-graph-suggestions-replicated-decisions.md): the row schema (exact shapes, the
 * request id bound to its suggestion, the snapshot bound to its id), the fold (earliest wins, rejected and
 * accepted beat accepting, order-independent), the outbox (only proven sends count, boot re-offer, the drain
 * and its breaker), and the service overlay (a peer's decisions hide, continue and keep members out; the
 * overlay never reaches the local file; backfill of earlier decisions once).
 */
import { describe, it, expect, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { nodeKey, type ConversationRef, type ProjectionItem } from '../../src/core/conversationGraph.js';
import { projectSuggestionId, suggestionId, suggestionCreateRequestId } from '../../src/core/ConversationGraphSuggestions.js';
import {
  SuggestionDecisionStore, SUGGESTION_DECISIONS_KIND_REGISTRATION, SUGGESTION_DECISIONS_STORE_KEY, SuggestionDecisionDrain,
  validateSuggestionDecisionRow, foldSuggestionDecisions, deriveSuggestionDecisionRecordKey, suggestionDecisionStoreSchema,
  buildSuggestionDecisionRecordData, wireSuggestionDecisionStore, DRAIN_TICKS_BEFORE_REPORT,
  type SuggestionDecisionRow,
} from '../../src/core/ConversationGraphSuggestionDecisions.js';
import { ConversationGraphSuggestionService, SUGGESTIONS_STATE_FILE, backfillSuggestionDecisions } from '../../src/server/ConversationGraphSuggestionService.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/conversation-graph-suggestion-decisions.test.ts' }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-decisions-')); dirs.push(d); return d; };

const tg = (topicId: number): ConversationRef => ({ kind: 'conversation', platform: 'telegram', chatId: '-1001', topicId });
const groupId = (...topics: number[]) => suggestionId(topics.map((t) => nodeKey(tg(t))));
const accepting = (topics: number[], o: Partial<SuggestionDecisionRow> = {}): SuggestionDecisionRow => {
  const id = groupId(...topics);
  return { suggestionId: id, decision: 'accepting', atMs: 1000, createRequestId: suggestionCreateRequestId(id), snapshot: { title: 'Rollout', members: topics.map(tg) }, ...o };
};
const item = (topicId: number, title = `Topic ${topicId}`): ProjectionItem => ({
  ref: tg(topicId), title, kind: 'conversation', role: 'unassigned', primaryPath: [], visibleChildCount: 0,
  digestVersion: null, sourceFreshness: `2026-11-11T10:${String(topicId % 60).padStart(2, '0')}:00.000Z`,
});
const reply = (groups: unknown[]) => JSON.stringify({ groups });

describe('the create request id', () => {
  it('is derived from the suggestion id with the conversation-groups-phone formula', () => {
    const id = groupId(11, 12);
    const want = `sga-${crypto.createHash('sha256').update(`conversation-group-accept\n${id}\ncreate\n`).digest('hex').slice(0, 40)}`;
    expect(suggestionCreateRequestId(id)).toBe(want);
    expect(suggestionCreateRequestId(groupId(11, 13))).not.toBe(want);
  });
});

describe('row validation', () => {
  it('accepts each decision shape and both request id formats', () => {
    const id = groupId(11, 12);
    expect(validateSuggestionDecisionRow({ suggestionId: id, decision: 'rejected', atMs: 5 })).toEqual({ suggestionId: id, decision: 'rejected', atMs: 5 });
    expect(validateSuggestionDecisionRow({ suggestionId: id, decision: 'accepted', atMs: 5 })).not.toBeNull();
    expect(validateSuggestionDecisionRow({ suggestionId: id, decision: 'accepted', atMs: 5, result: { group: { kind: 'effort', id: crypto.randomUUID() }, moved: 2, skipped: 0, placedElsewhere: false } })).not.toBeNull();
    expect(validateSuggestionDecisionRow(accepting([11, 12]))).not.toBeNull();
    expect(validateSuggestionDecisionRow(accepting([11, 12], { createRequestId: `suggestion-${crypto.randomUUID()}` }))).not.toBeNull();
  });

  it('refuses extra fields, bad ids, request ids or snapshots that are not bound to the suggestion, and misplaced fields', () => {
    const id = groupId(11, 12);
    expect(validateSuggestionDecisionRow({ suggestionId: id, decision: 'rejected', atMs: 5, title: 'x' })).toBeNull();
    expect(validateSuggestionDecisionRow({ suggestionId: 'sg-nope', decision: 'rejected', atMs: 5 })).toBeNull();
    expect(validateSuggestionDecisionRow({ suggestionId: id, decision: 'maybe', atMs: 5 })).toBeNull();
    expect(validateSuggestionDecisionRow({ suggestionId: id, decision: 'rejected', atMs: 1.5 })).toBeNull();
    expect(validateSuggestionDecisionRow({ suggestionId: id, decision: 'rejected', atMs: 5, createRequestId: suggestionCreateRequestId(id) })).toBeNull();
    // Another suggestion's derived id: it could steer Continue into that suggestion's group.
    expect(validateSuggestionDecisionRow(accepting([11, 12], { createRequestId: suggestionCreateRequestId(groupId(11, 13)) }))).toBeNull();
    expect(validateSuggestionDecisionRow(accepting([11, 12], { createRequestId: 'sga-' + '0'.repeat(40) }))).toBeNull();
    // A snapshot whose members do not hash to the id.
    expect(validateSuggestionDecisionRow(accepting([11, 12], { snapshot: { title: 'Rollout', members: [tg(11), tg(13)] } }))).toBeNull();
    expect(validateSuggestionDecisionRow(accepting([11, 12], { snapshot: { title: 'Bad\nname', members: [tg(11), tg(12)] } }))).toBeNull();
    expect(validateSuggestionDecisionRow(accepting([11, 12], { snapshot: { title: 'x'.repeat(61), members: [tg(11), tg(12)] } }))).toBeNull();
    expect(validateSuggestionDecisionRow(accepting([11, 12], { snapshot: undefined }))).toBeNull();
    expect(validateSuggestionDecisionRow(accepting([11, 12], { createRequestId: undefined }))).toBeNull();
    expect(validateSuggestionDecisionRow({ suggestionId: id, decision: 'accepted', atMs: 5, result: { group: null, moved: 99, skipped: 0, placedElsewhere: false } })).toBeNull();
  });

  it('binds a project snapshot to its front door', () => {
    const front = tg(21);
    const id = projectSuggestionId(nodeKey(front));
    const row: SuggestionDecisionRow = { suggestionId: id, decision: 'accepting', atMs: 1, createRequestId: suggestionCreateRequestId(id), snapshot: { title: 'Project: X', members: [front, tg(22)], frontDoor: front } };
    expect(validateSuggestionDecisionRow(row)).not.toBeNull();
    expect(validateSuggestionDecisionRow({ ...row, snapshot: { ...row.snapshot!, frontDoor: tg(22) } })).toBeNull();
    expect(validateSuggestionDecisionRow({ ...row, snapshot: { title: 'Project: X', members: [tg(22)], frontDoor: front } })).toBeNull();
  });

  it('registers the kind; the schema keeps a valid row and refuses deletes and junk; record keys hash the whole row', () => {
    expect(SUGGESTION_DECISIONS_KIND_REGISTRATION).toMatchObject({ kind: 'conversation-graph-suggestion-record', store: 'conversationGraphSuggestions' });
    const row = accepting([11, 12]);
    expect(suggestionDecisionStoreSchema.validate({ row }, {} as never)).toEqual({ row });
    expect(suggestionDecisionStoreSchema.validate({ row, op: 'delete' }, {} as never)).toBeNull();
    expect(suggestionDecisionStoreSchema.validate({ row: { ...row, atMs: -1 } }, {} as never)).toBeNull();
    expect(deriveSuggestionDecisionRecordKey(row)).not.toBe(deriveSuggestionDecisionRecordKey({ ...row, atMs: 1001 }));
    const data = buildSuggestionDecisionRecordData(row)({ physical: 1, logical: 0, node: 'm1' } as never, 'm1');
    expect(data).toMatchObject({ row, recordKey: deriveSuggestionDecisionRecordKey(row), op: 'put', origin: 'm1' });
  });

});

describe('the fold', () => {
  it('a legacy start beats a derived one whatever the clocks say', () => {
    const legacy = accepting([11, 12], { atMs: 9000, createRequestId: `suggestion-${crypto.randomUUID()}` });
    const derived = accepting([11, 12], { atMs: 100 });
    for (const order of [[legacy, derived], [derived, legacy]]) {
      expect(foldSuggestionDecisions(order).accepting.get(legacy.suggestionId)?.createRequestId).toBe(legacy.createRequestId);
    }
  });

  it('earliest accepting wins in any order; rejected and accepted beat accepting', () => {
    const legacy = accepting([11, 12], { atMs: 500, createRequestId: `suggestion-${crypto.randomUUID()}` });
    const derived = accepting([11, 12], { atMs: 900 });
    for (const order of [[legacy, derived], [derived, legacy]]) {
      expect(foldSuggestionDecisions(order).accepting.get(legacy.suggestionId)?.createRequestId).toBe(legacy.createRequestId);
    }
    const rejected = { suggestionId: legacy.suggestionId, decision: 'rejected' as const, atMs: 2000 };
    const f = foldSuggestionDecisions([derived, rejected]);
    expect(f.rejected.has(legacy.suggestionId)).toBe(true);
    expect(f.accepting.has(legacy.suggestionId)).toBe(false);
  });

  it('keeps the result of the earliest accepted row that has one', () => {
    const id = groupId(11, 12);
    const result = { group: { kind: 'effort' as const, id: crypto.randomUUID() }, moved: 2, skipped: 0, placedElsewhere: false };
    const f = foldSuggestionDecisions([{ suggestionId: id, decision: 'accepted', atMs: 1 }, { suggestionId: id, decision: 'accepted', atMs: 9, result }]);
    expect(f.accepted.get(id)?.atMs).toBe(1);
    expect(f.results.get(id)).toEqual(result);
  });
});

describe('the outbox', () => {
  const okHook = (sent: SuggestionDecisionRow[]) => (row: SuggestionDecisionRow) => { sent.push(row); return 'emitted' as const; };

  it('keeps one winner per decision, never re-emits a landed row, survives reload', () => {
    const dir = tmp();
    const store = new SuggestionDecisionStore({ stateDir: dir });
    const sent: SuggestionDecisionRow[] = [];
    store.setReplicationHook(okHook(sent));
    const id = groupId(11, 12);
    expect(store.record({ suggestionId: id, decision: 'rejected', atMs: 50 })).toBe('recorded');
    expect(store.record({ suggestionId: id, decision: 'rejected', atMs: 80 })).toBe('held');
    expect(store.ingestReplicated({ suggestionId: id, decision: 'rejected', atMs: 10 })).toBe('accepted');
    expect(store.ingestReplicated({ suggestionId: id, decision: 'rejected', atMs: 99 })).toBe('ignored');
    expect(store.ingestReplicated({ suggestionId: id, decision: 'nope', atMs: 99 })).toBe('invalid');
    expect(store.record({ suggestionId: 'bad', decision: 'rejected', atMs: 1 } as never)).toBe('invalid');
    expect(sent).toHaveLength(1);
    expect(store.rows()).toEqual([{ suggestionId: id, decision: 'rejected', atMs: 10 }]);
    const again = new SuggestionDecisionStore({ stateDir: dir });
    expect(again.rows()).toEqual(store.rows());
    expect(again.dueCount()).toBe(0);
  });

  it('only a proven send counts; the boot wiring lands peers\' rows, re-sends own rows missing from the own stream, and leaves the rest due', () => {
    const dir = tmp();
    const pre = new SuggestionDecisionStore({ stateDir: dir });
    pre.setReplicationHook(() => 'emitted');
    pre.record({ suggestionId: groupId(1, 2), decision: 'rejected', atMs: 5 }); // marked sent, but only enqueued
    pre.record({ suggestionId: groupId(5, 6), decision: 'rejected', atMs: 6 }); // marked sent and really in the own stream
    const inOwn = deriveSuggestionDecisionRecordKey({ suggestionId: groupId(5, 6), decision: 'rejected', atMs: 6 });
    const peer = accepting([11, 12]);
    const ownOld = { suggestionId: groupId(3, 4), decision: 'rejected', atMs: 1 };
    const outcomes: string[] = [];
    let outcome = 'unconfirmed';
    const wired = wireSuggestionDecisionStore({
      stateDir: dir, ownMachineId: 'm1', report: () => undefined, setTimer: () => ({}),
      peerStreams: {
        listRecordKeys: () => ['k1', 'k2'],
        loadOriginRecords: (_s, rk) => (rk === 'k1' ? [{ origin: 'm2', data: { row: peer } }]
          : rk === 'k2' ? [{ origin: 'm1', data: { row: ownOld } }]
            : rk === inOwn ? [{ origin: 'm1', data: { row: {} } }] : []),
      },
      emitter: { emit: (store: string) => { outcomes.push(store); return { outcome } as never; } },
    });
    expect(wired.store.fold().accepting.has(peer.suggestionId)).toBe(true); // a peer's row landed
    expect(wired.store.holds(groupId(3, 4), 'rejected')).toBe(false); // own stream rows are not re-landed
    expect(outcomes).toEqual([SUGGESTION_DECISIONS_STORE_KEY]); // only the own row missing from the own stream was sent again
    expect(wired.store.dueCount()).toBe(1); // `unconfirmed` is not proof
    outcome = 'dropped:deduped';
    wired.store.flushEmits();
    expect(wired.store.dueCount()).toBe(0);
  });

  it('the drain backs off to its ceiling, reports once per row, keeps going, and drains once the journal recovers', () => {
    const dir = tmp();
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const reports: string[] = [];
    let outcome = 'disabled';
    const wired = wireSuggestionDecisionStore({
      stateDir: dir, ownMachineId: 'm1', peerStreams: null, report: (_w, d) => reports.push(d),
      setTimer: (fn, ms) => { timers.push({ fn, ms }); return {}; }, clearTimer: () => undefined,
      emitter: { emit: () => ({ outcome }) as never },
    });
    const drain = wired.drain as SuggestionDecisionDrain;
    wired.store.record({ suggestionId: groupId(1, 2), decision: 'rejected', atMs: 5 });
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(10 * 60_000);
    for (let i = 0; i < DRAIN_TICKS_BEFORE_REPORT + 3; i++) timers[i].fn();
    expect(timers.slice(0, 7).map((t) => t.ms)).toEqual([600_000, 1_200_000, 2_400_000, 4_800_000, 9_600_000, 19_200_000, 21_600_000]);
    expect(timers[timers.length - 1].ms).toBe(6 * 60 * 60_000); // the ceiling
    expect(reports).toHaveLength(1); // once per row
    const armed = timers.length;
    wired.store.record({ suggestionId: groupId(3, 4), decision: 'rejected', atMs: 6 }); // a new decision during the ceiling
    expect(timers).toHaveLength(armed + 1);
    expect(timers[timers.length - 1].ms).toBe(10 * 60_000); // re-armed at the base delay, not left at 6 hours
    outcome = 'emitted'; // the journal recovered: no owner action needed
    timers[timers.length - 1].fn();
    expect(wired.store.dueCount()).toBe(0);
    expect(drain.currentDelayMs()).toBe(10 * 60_000);
  });

  it('a capped flush rotates, so rows refused for good never starve the rows behind them', () => {
    const store = new SuggestionDecisionStore({ stateDir: tmp() });
    const refused = new Set<string>();
    store.setReplicationHook((row) => (refused.has(row.suggestionId) ? 'refused' : 'emitted'));
    const ids = Array.from({ length: 5 }, (_, i) => groupId(100 + i, 200 + i));
    for (const id of ids.slice(0, 4)) refused.add(id);
    for (const [i, id] of ids.entries()) store.record({ suggestionId: id, decision: 'rejected', atMs: i + 1 });
    expect(store.dueCount()).toBe(4); // the fifth went out when recorded
    refused.delete(ids[3]);
    store.flushEmits(2); store.flushEmits(2);
    expect(store.dueCount()).toBe(3); // the row behind two permanently refused ones got its turn
  });

  it('an unreadable outbox is reported and starts empty', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'state', 'conversation-graph-suggestion-decisions.json'), '{not json');
    const reports: string[] = [];
    const store = new SuggestionDecisionStore({ stateDir: dir, report: (w) => reports.push(w) });
    expect(store.rows()).toEqual([]);
    expect(reports).toContain('ConversationGraphSuggestions.load');
  });
});

describe('the suggestion service with shared decisions', () => {
  const machine = (answer: string, decisions: SuggestionDecisionStore | null, stateDir = tmp()) => {
    const calls: string[] = [];
    const service = new ConversationGraphSuggestionService({
      stateDir, now: () => new Date('2026-11-17T20:00:00Z'), decisions,
      intelligence: { evaluate: async (prompt) => { calls.push(prompt); return answer; } }, evidence: () => ({ project: null, text: '' }),
    });
    return { service, calls, stateDir };
  };
  const inv = [item(11), item(12), item(13), item(14)];
  const file = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, SUGGESTIONS_STATE_FILE), 'utf8'));

  it('records each local decision; the derived request id is the one recorded', async () => {
    const store = new SuggestionDecisionStore({ stateDir: tmp() });
    const { service } = machine(reply([{ name: 'Rollout', members: ['c1', 'c2'] }, { name: 'Docs', members: ['c3', 'c4'] }]), store);
    service.view(inv); await service.settled();
    const [a, b] = service.view(inv).items;
    const started = service.beginAccept(a.id);
    expect(started?.createRequestId).toBe(suggestionCreateRequestId(a.id));
    service.reject(b.id);
    service.accepted(a.id);
    const f = store.fold();
    expect(f.rejected.has(b.id)).toBe(true);
    expect(f.accepted.has(a.id)).toBe(true);
    const row = store.rows().find((r) => r.decision === 'accepting')!;
    expect(row.createRequestId).toBe(started?.createRequestId);
    expect(row.snapshot?.members).toHaveLength(2);
  });

  it('a peer\'s rejection hides the suggestion, keeps it out of the next build, and never reaches the local file', async () => {
    const store = new SuggestionDecisionStore({ stateDir: tmp() });
    const { service, calls, stateDir } = machine(reply([{ name: 'Rollout', members: ['c1', 'c2'] }]), store);
    service.view(inv); await service.settled();
    const id = service.view(inv).items[0].id;
    store.ingestReplicated({ suggestionId: id, decision: 'rejected', atMs: 5 });
    expect(service.view(inv).items.map((i) => i.id)).not.toContain(id);
    expect(service.beginAccept(id)).toBeNull();
    service.refresh(inv); // too soon: unchanged; the rejected filter is exercised through the prompt below
    expect(file(stateDir).rejected[id]).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it('B with an EMPTY list shows Continue for A\'s Accept, keeps its members out of its build and resumes with A\'s request id', async () => {
    const store = new SuggestionDecisionStore({ stateDir: tmp() });
    const { service, calls, stateDir } = machine(reply([]), store);
    const row = accepting([11, 12], { atMs: 7 });
    store.ingestReplicated(row);
    const view = service.view(inv);
    expect(view.items).toHaveLength(1);
    expect(view.items[0]).toMatchObject({ id: row.suggestionId, title: 'Rollout', accepting: true });
    expect(service.beginAccept(row.suggestionId)).toEqual({ createRequestId: row.createRequestId });
    await service.settled();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('Topic 13');
    expect(calls[0]).not.toContain('Topic 11');
    expect(calls[0]).not.toContain('Topic 12');
    // Nothing of A's Accept was written into B's own file.
    const local = file(stateDir);
    expect(local.accepting[row.suggestionId]).toBeUndefined();
    expect(local.suggestions.map((s: { id: string }) => s.id)).not.toContain(row.suggestionId);
  });

  it('a project Accept from another machine keeps its front door and its own member list over the local one', () => {
    const store = new SuggestionDecisionStore({ stateDir: tmp() });
    const front = tg(21);
    const proj = (children: number[]) => ({ key: nodeKey(front), ref: front, title: 'Project 21', children: children.map((c) => ({ key: nodeKey(tg(c)), ref: tg(c), title: 'C' })) });
    const service = new ConversationGraphSuggestionService({ stateDir: tmp(), now: () => new Date('2026-11-17T20:00:00Z'), decisions: store,
      intelligence: null, evidence: () => ({ project: null, text: '' }), projects: () => [proj([23])] });
    const id = projectSuggestionId(nodeKey(front));
    store.ingestReplicated({ suggestionId: id, decision: 'accepting', atMs: 3, createRequestId: suggestionCreateRequestId(id), snapshot: { title: 'Project: Project 21', members: [front, tg(22)], frontDoor: front } });
    const v = service.view([item(21), item(22), item(23)]);
    const card = v.items.find((i) => i.id === id)!;
    expect(card.frontDoor).toEqual(front);
    expect(card.members.map((m) => (m.ref as { topicId: number }).topicId)).toEqual([21, 22]);
  });

  it('a build that started before a peer\'s Accept landed does not publish an overlapping group', async () => {
    const store = new SuggestionDecisionStore({ stateDir: tmp() });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const service = new ConversationGraphSuggestionService({ stateDir: tmp(), now: () => new Date('2026-11-17T20:00:00Z'), decisions: store,
      intelligence: { evaluate: async () => { await gate; return reply([{ name: 'Overlap', members: ['c1', 'c3'] }]); } }, evidence: () => ({ project: null, text: '' }) });
    service.view(inv);
    // Inputs are newest first: c1 = topic 14, c3 = topic 12. The peer's Accept covers 13 and 14.
    store.ingestReplicated(accepting([13, 14], { atMs: 4 }));
    release(); await service.settled();
    const titles = service.view(inv).items.map((i) => i.title);
    expect(titles).toEqual(['Rollout']);
  });

  it('backfills earlier decisions once, keeps an earlier local start over a later landed one, and an unrelated save keeps local entries', async () => {
    const stateDir = tmp();
    // Before the upgrade: decisions in the local file only.
    const before = machine(reply([{ name: 'Rollout', members: ['c1', 'c2'] }, { name: 'Docs', members: ['c3', 'c4'] }]), null, stateDir);
    before.service.view(inv); await before.service.settled();
    const [a, b] = before.service.view(inv).items;
    before.service.reject(b.id);
    // A pre-upgrade start with a random id.
    const raw = file(stateDir);
    raw.accepting[a.id] = { createRequestId: `suggestion-${crypto.randomUUID()}`, startedAt: '2026-11-17T10:00:00.000Z' };
    fs.writeFileSync(path.join(stateDir, SUGGESTIONS_STATE_FILE), JSON.stringify(raw));
    const store = new SuggestionDecisionStore({ stateDir: tmp() });
    // A later start of the same suggestion landed from a peer first.
    store.ingestReplicated(accepting([13, 14], { atMs: Date.parse('2026-11-17T12:00:00.000Z') }));
    const after = machine(reply([]), store, stateDir);
    after.service.view(inv);
    expect(store.fold().rejected.has(b.id)).toBe(true);
    expect(store.fold().accepting.get(a.id)?.createRequestId).toBe(raw.accepting[a.id].createRequestId);
    const n = store.rows().length;
    after.service.view(inv);
    expect(store.rows()).toHaveLength(n); // idempotent
    after.service.reject(groupId(13, 99) as string); // unknown id: no change, no save
    expect(file(stateDir).accepting[a.id].createRequestId).toBe(raw.accepting[a.id].createRequestId);
  });

  it('a peer start that differs from the local request never overwrites the local entry in the file', async () => {
    const stateDir = tmp();
    const store = new SuggestionDecisionStore({ stateDir: tmp() });
    const { service } = machine(reply([{ name: 'Rollout', members: ['c1', 'c2'] }]), store, stateDir);
    service.view(inv); await service.settled();
    const id = service.view(inv).items[0].id;
    service.beginAccept(id);
    const legacy = `suggestion-${crypto.randomUUID()}`;
    store.ingestReplicated(accepting([13, 14], { atMs: 1, createRequestId: legacy })); // c1, c2 = topics 14, 13
    expect(service.beginAccept(id)).toEqual({ createRequestId: legacy }); // the earliest start is continued
    service.reject(groupId(13, 14)); // unknown here: no save
    service.refresh(inv); // a save path: syncProjects/start
    expect(file(stateDir).accepting[id].createRequestId).toBe(suggestionCreateRequestId(id));
  });

  it('a peer\'s Reject of an Accept started here frees its members for the next build', async () => {
    const store = new SuggestionDecisionStore({ stateDir: tmp() });
    let clock = new Date('2026-11-17T20:00:00Z');
    const calls: string[] = [];
    const service = new ConversationGraphSuggestionService({ stateDir: tmp(), now: () => clock, decisions: store,
      intelligence: { evaluate: async (p) => { calls.push(p); return reply([{ name: 'Rollout', members: ['c1', 'c2'] }]); } }, evidence: () => ({ project: null, text: '' }) });
    service.view(inv); await service.settled();
    const id = service.view(inv).items[0].id;
    service.beginAccept(id);
    store.ingestReplicated({ suggestionId: id, decision: 'rejected', atMs: Date.parse('2026-11-17T20:05:00Z') });
    clock = new Date('2026-11-19T20:00:00Z');
    service.view(inv); await service.settled();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('Topic 14'); // c1 of the rejected Accept is offered to the model again
  });

  it('boot backfill shares earlier decisions without any suggestions request being served', async () => {
    const stateDir = tmp();
    const pre = machine(reply([{ name: 'Rollout', members: ['c1', 'c2'] }]), null, stateDir);
    pre.service.view(inv); await pre.service.settled();
    const id = pre.service.view(inv).items[0].id;
    pre.service.reject(id);
    const store = new SuggestionDecisionStore({ stateDir: tmp() });
    const sent: string[] = [];
    store.setReplicationHook((row) => { sent.push(row.suggestionId); return 'emitted'; });
    backfillSuggestionDecisions(stateDir, store);
    expect(sent).toEqual([id]);
    backfillSuggestionDecisions(stateDir, store);
    expect(sent).toEqual([id]); // idempotent
  });

  it('without a store, decisions stay local exactly as before (with the derived request id)', async () => {
    const { service, stateDir } = machine(reply([{ name: 'Rollout', members: ['c1', 'c2'] }]), null);
    service.view(inv); await service.settled();
    const id = service.view(inv).items[0].id;
    expect(service.beginAccept(id)?.createRequestId).toBe(suggestionCreateRequestId(id));
    service.reject(id);
    expect(file(stateDir).rejected[id]).toBeTruthy();
  });
});
