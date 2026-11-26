/**
 * Two machines, one owner (docs/specs/conversation-graph-suggestions-replicated-decisions.md): each machine has
 * its own state dir, suggestion service, decision store (built by the real boot wiring) and the real suggestion
 * router over HTTP. A fake journal carries each machine's emitted rows to the other machine's commit path
 * (`ingestReplicatedAll`), only when delivered, so replication lag is explicit.
 */
import { describe, it, expect, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { ConversationRef, ProjectionItem } from '../../src/core/conversationGraph.js';
import { suggestionCreateRequestId } from '../../src/core/ConversationGraphSuggestions.js';
import { wireSuggestionDecisionStore, SUGGESTION_DECISIONS_STORE_KEY, type SuggestionDecisionStore } from '../../src/core/ConversationGraphSuggestionDecisions.js';
import { ConversationGraphSuggestionService, SUGGESTIONS_STATE_FILE } from '../../src/server/ConversationGraphSuggestionService.js';
import { createConversationGraphSuggestionRouter } from '../../src/server/conversationGraphSuggestionRoutes.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/conversation-graph-suggestions-replicated.test.ts' }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-repl-')); dirs.push(d); return d; };

const tg = (topicId: number): ConversationRef => ({ kind: 'conversation', platform: 'telegram', chatId: '-1001', topicId });
const item = (topicId: number): ProjectionItem => ({
  ref: tg(topicId), title: `Topic ${topicId}`, kind: 'conversation', role: 'unassigned', primaryPath: [], visibleChildCount: 0,
  digestVersion: null, sourceFreshness: `2026-11-11T10:${String(topicId % 60).padStart(2, '0')}:00.000Z`,
});
const reply = (groups: unknown[]) => JSON.stringify({ groups });

/** The journal between machines: rows emitted on one side wait in flight until delivered to the other. */
class FakeJournal {
  readonly streams = new Map<string, Array<{ recordKey: string; data: Record<string, unknown> }>>();
  readonly inFlight: Array<{ from: string; data: Record<string, unknown> }> = [];
  readonly stores = new Map<string, SuggestionDecisionStore>();
  emitterFor(machine: string) {
    return {
      emit: (_store: string, recordKey: string | null | undefined, build: (hlc: never, origin: string) => Record<string, unknown> | null) => {
        const data = build({ physical: Date.now(), logical: 0, node: machine } as never, machine)!;
        const own = this.streams.get(machine) ?? [];
        own.push({ recordKey: String(recordKey), data });
        this.streams.set(machine, own);
        this.inFlight.push({ from: machine, data });
        return { outcome: 'emitted' } as never;
      },
    };
  }
  peerStreamsFor() {
    return {
      listRecordKeys: () => [...new Set([...this.streams.values()].flat().map((r) => r.recordKey))],
      loadOriginRecords: (_s: string, rk: string) => [...this.streams.entries()].flatMap(([origin, rows]) => rows.filter((r) => r.recordKey === rk).map((r) => ({ origin, data: r.data }))),
    };
  }
  /** Deliver every in-flight row to every other machine's commit path (what the applier's observer does). */
  deliver(): void {
    const batch = this.inFlight.splice(0);
    for (const [machine, store] of this.stores) {
      const rows = batch.filter((b) => b.from !== machine).map((b) => (b.data as { row?: unknown }).row);
      if (rows.length) store.ingestReplicatedAll(rows);
    }
  }
}

const OWNER = { kind: 'owner' } as never;
function machineOn(journal: FakeJournal, id: string, answer: string, stateDir = tmp()) {
  const wired = wireSuggestionDecisionStore({ stateDir, emitter: journal.emitterFor(id), peerStreams: journal.peerStreamsFor(), ownMachineId: id, report: () => undefined, setTimer: () => ({}) });
  journal.stores.set(id, wired.store);
  const prompts: string[] = [];
  const service = new ConversationGraphSuggestionService({
    stateDir, now: () => new Date('2026-11-17T20:00:00Z'), decisions: wired.store,
    intelligence: { evaluate: async (p) => { prompts.push(p); return answer; } }, evidence: () => ({ project: null, text: '' }),
  });
  const inventory = { items: [item(11), item(12), item(13), item(14)] };
  const model = { unassignedConversations: () => inventory.items } as never;
  const app = express();
  app.use(express.json(), createConversationGraphSuggestionRouter({ model, service, resolveViewer: () => OWNER }));
  return { app, service, store: wired.store, prompts, stateDir, inventory };
}

const list = async (app: express.Express) => (await request(app).get('/conversation-graph/suggestions')).body as { items: Array<{ id: string; title: string; accepting: boolean }> };

describe('a rejection on one machine is honored on every machine', () => {
  it('reject on A; after delivery B neither offers it nor sends it to its model again', async () => {
    const journal = new FakeJournal();
    const answer = reply([{ name: 'Rollout', members: ['c1', 'c2'] }]);
    const A = machineOn(journal, 'mA', answer), B = machineOn(journal, 'mB', answer);
    await list(A.app); await A.service.settled();
    await list(B.app); await B.service.settled();
    const id = (await list(A.app)).items[0].id;
    expect((await list(B.app)).items.map((i) => i.id)).toEqual([id]); // same grouping built on both
    expect((await request(A.app).post(`/conversation-graph/suggestions/${id}/reject`).send({})).status).toBe(200);
    expect((await list(B.app)).items.map((i) => i.id)).toEqual([id]); // not delivered yet: ordinary lag
    journal.deliver();
    expect((await list(B.app)).items).toEqual([]);
    expect((await request(B.app).post(`/conversation-graph/suggestions/${id}/start`).send({})).status).toBe(404);
    // B's own file never took A's decision.
    expect(JSON.parse(fs.readFileSync(path.join(B.stateDir, SUGGESTIONS_STATE_FILE), 'utf8')).rejected[id]).toBeUndefined();
    // Re-delivery and a replay of A's whole stream change nothing.
    journal.inFlight.push(...(journal.streams.get('mA') ?? []).map((r) => ({ from: 'mA', data: r.data })));
    journal.deliver();
    expect(B.store.rows()).toHaveLength(1);
  });
});

describe('an Accept started on one machine continues on the other', () => {
  it('start on A; B (which never built it) shows Continue and its start answers A\'s request id', async () => {
    const journal = new FakeJournal();
    const A = machineOn(journal, 'mA', reply([{ name: 'Rollout', members: ['c1', 'c2'] }]));
    const B = machineOn(journal, 'mB', reply([]));
    await list(A.app); await A.service.settled();
    await list(B.app); await B.service.settled();
    expect((await list(B.app)).items).toEqual([]);
    const id = (await list(A.app)).items[0].id;
    const started = await request(A.app).post(`/conversation-graph/suggestions/${id}/start`).send({});
    expect(started.body.createRequestId).toBe(suggestionCreateRequestId(id));
    journal.deliver();
    const onB = await list(B.app);
    expect(onB.items).toEqual([expect.objectContaining({ id, title: 'Rollout', accepting: true })]);
    const continued = await request(B.app).post(`/conversation-graph/suggestions/${id}/start`).send({});
    expect(continued.body.createRequestId).toBe(started.body.createRequestId);
    // B finishes it; A stops offering it.
    expect((await request(B.app).post(`/conversation-graph/suggestions/${id}/accepted`).send({})).status).toBe(200);
    journal.deliver();
    expect((await list(A.app)).items).toEqual([]);
  });

  it('concurrent starts on both machines converge on one request id', async () => {
    const journal = new FakeJournal();
    const answer = reply([{ name: 'Rollout', members: ['c1', 'c2'] }]);
    const A = machineOn(journal, 'mA', answer), B = machineOn(journal, 'mB', answer);
    await list(A.app); await A.service.settled();
    await list(B.app); await B.service.settled();
    const id = (await list(A.app)).items[0].id;
    const a = await request(A.app).post(`/conversation-graph/suggestions/${id}/start`).send({});
    const b = await request(B.app).post(`/conversation-graph/suggestions/${id}/start`).send({});
    journal.deliver();
    const a2 = await request(A.app).post(`/conversation-graph/suggestions/${id}/start`).send({});
    const b2 = await request(B.app).post(`/conversation-graph/suggestions/${id}/start`).send({});
    expect(new Set([a.body.createRequestId, b.body.createRequestId, a2.body.createRequestId, b2.body.createRequestId]).size).toBe(1);
  });
});

describe('decisions made before the upgrade', () => {
  it('migrate once at the first read after the upgrade; B honors them; a second boot sends nothing new', async () => {
    const journal = new FakeJournal();
    const stateDirA = tmp();
    // Before the upgrade A had no store: a rejection and a random-id start in its local file only.
    const pre = new ConversationGraphSuggestionService({ stateDir: stateDirA, now: () => new Date('2026-11-16T09:00:00Z'),
      intelligence: { evaluate: async () => reply([{ name: 'Rollout', members: ['c1', 'c2'] }, { name: 'Docs', members: ['c3', 'c4'] }]) }, evidence: () => ({ project: null, text: '' }) });
    const inv = [item(11), item(12), item(13), item(14)];
    pre.view(inv); await pre.settled();
    const [rollout, docs] = pre.view(inv).items;
    pre.reject(docs.id);
    const raw = JSON.parse(fs.readFileSync(path.join(stateDirA, SUGGESTIONS_STATE_FILE), 'utf8'));
    const legacy = `suggestion-${crypto.randomUUID()}`;
    raw.accepting[rollout.id] = { createRequestId: legacy, startedAt: '2026-11-16T09:30:00.000Z' };
    fs.writeFileSync(path.join(stateDirA, SUGGESTIONS_STATE_FILE), JSON.stringify(raw));

    const A = machineOn(journal, 'mA', reply([]), stateDirA);
    const B = machineOn(journal, 'mB', reply([]));
    await list(A.app); // first read: backfill
    expect(journal.inFlight.map((f) => (f.data as { row: { decision: string } }).row.decision).sort()).toEqual(['accepting', 'rejected']);
    journal.deliver();
    const onB = await list(B.app);
    expect(onB.items).toEqual([expect.objectContaining({ id: rollout.id, accepting: true })]);
    expect((await request(B.app).post(`/conversation-graph/suggestions/${rollout.id}/start`).send({})).body.createRequestId).toBe(legacy);
    expect((await request(B.app).post(`/conversation-graph/suggestions/${docs.id}/start`).send({})).status).toBe(404);

    // A restarts: the boot check finds its rows in its own stream; nothing is sent again.
    const sentBefore = journal.streams.get('mA')!.length;
    const A2 = machineOn(journal, 'mA', reply([]), stateDirA);
    await list(A2.app);
    expect(journal.streams.get('mA')!.length).toBe(sentBefore);
    expect(SUGGESTION_DECISIONS_STORE_KEY).toBe('conversationGraphSuggestions');
  });
});
