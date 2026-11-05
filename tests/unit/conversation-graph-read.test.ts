/**
 * ConversationGraphReadModel + router (v3 §7.3–7.5):
 * - readiness comes from the source; not ready → 503 and nothing else is computed;
 * - the viewer filter runs before sort/search/count/path/children/page;
 * - cursors bind a frozen authorized snapshot: unrelated graph events never invalidate a page;
 *   grant change / expiry / malformed / foreign scope → 409; revocation mid-snapshot drops the row;
 * - children page past 50; hidden and absent nodes are both 404;
 * - the router: non-owner 403, bad ref 404, bad view 400, NodeRef objects in bodies.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { ConversationGraphReadModel, type GraphReadSource, type GraphViewer } from '../../src/core/conversationGraphRead.js';
import { createConversationGraphRouter } from '../../src/server/conversationGraphRoutes.js';
import { encodeRouteRef, nodeKey, type GraphEvent, type NodeRef, type EffortRef, type ConversationRef, type ConversationSource } from '../../src/core/conversationGraph.js';

const effort = (n: number): EffortRef => ({ kind: 'effort', id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` });
const tg = (topicId: number): ConversationRef => ({ kind: 'conversation', platform: 'telegram', chatId: '-1001234567890', topicId });
let seq = 0;
function ev(op: 'create' | 'place', subject: NodeRef, parent: NodeRef | null = null): GraphEvent {
  seq += 1;
  const base = { schemaVersion: 1 as const, eventId: `evt-${String(seq).padStart(6, '0')}`, subject, authority: 'owner' as const, principal: 'owner', receipt: { kind: 'owner-proof' as const, id: `r${seq}` }, machineId: 'm1', createdAt: `2026-11-05T10:${String(seq % 60).padStart(2, '0')}:00.000Z` };
  if (op === 'create') return { ...base, op: 'create-effort', projectScope: [], headerId: `hdr-${(subject as EffortRef).id.replace(/-/g, '')}` } as GraphEvent;
  return { ...base, op: 'set-primary-placement', parent, relation: parent ? (parent.kind === 'effort' ? (subject.kind === 'effort' ? 'contains' : 'coordinates') : 'delegates-to') : null, replacesPlacementEventIds: [] } as GraphEvent;
}

function makeSource(over: Partial<GraphReadSource> & { events?: GraphEvent[]; convs?: ConversationSource[] } = {}) {
  const state = { events: over.events ?? [] as GraphEvent[], convs: over.convs ?? [] as ConversationSource[], now: new Date('2026-11-05T11:00:00.000Z') };
  const src: GraphReadSource = {
    readiness: over.readiness ?? (() => ({ ready: true })),
    certifiedEvents: () => state.events,
    verify: () => true,
    conversations: () => state.convs,
    effortTitle: (e) => (nodeKey(e) === nodeKey(effort(1)) ? 'Launch' : 'Other'),
    replication: over.replication ?? (() => ({ replicaLag: true, eventGap: false, evidenceMissing: false })),
    now: () => state.now,
  };
  return { src, state };
}
const conv = (r: ConversationRef, i: number): ConversationSource => ({ ref: r, conversationId: (r as { topicId: number }).topicId, title: `Chat ${i}`, lastActivity: `2026-11-05T09:${String(i % 60).padStart(2, '0')}:00.000Z` });
const owner = (grant = 'g1', hidden: string[] = []): GraphViewer => ({ principalKey: 'owner', grantVersion: grant, mayView: (r) => !hidden.includes(nodeKey(r)) });

describe('ConversationGraphReadModel', () => {
  it('answers 503 with the source reason when not ready, before anything else', () => {
    let called = false;
    const { src } = makeSource({ readiness: () => ({ ready: false, reason: 'witness-not-provisioned' }) });
    src.certifiedEvents = () => { called = true; return []; };
    const m = new ConversationGraphReadModel(src);
    expect(m.roots(owner(), { view: 'all' })).toEqual({ status: 503, body: { code: 'conversation-graph-not-ready', reason: 'witness-not-provisioned' } });
    expect(m.node(owner(), effort(1), {})).toMatchObject({ status: 503 });
    expect(called).toBe(false);
  });

  it('reports every replication flag as a partial reason and never claims complete', () => {
    const { src } = makeSource({ replication: () => ({ replicaLag: true, eventGap: true, evidenceMissing: true }) });
    const r = new ConversationGraphReadModel(src).roots(owner(), { view: 'all' });
    expect(r.status).toBe(200);
    expect((r.body as { partial: boolean }).partial).toBe(true);
    expect((r.body as { partialReasons: unknown }).partialReasons).toEqual([{ reason: 'event-gap' }, { reason: 'evidence-missing' }, { reason: 'replica-lag' }]);
  });

  it('pages a frozen snapshot; an unrelated graph event does not invalidate the cursor', () => {
    const convs = Array.from({ length: 120 }, (_, i) => conv(tg(i + 1), i));
    const { src, state } = makeSource({ convs });
    const m = new ConversationGraphReadModel(src);
    const p1 = m.roots(owner(), { view: 'all' });
    const b1 = p1.body as { items: Array<{ ref: NodeRef }>; nextCursor: string };
    expect(b1.items).toHaveLength(50);
    state.events = [...state.events, ev('create', effort(9))]; // unrelated change
    const p2 = m.roots(owner(), { view: 'all', cursor: b1.nextCursor });
    const b2 = p2.body as { items: Array<{ ref: NodeRef }>; nextCursor: string | null };
    expect(p2.status).toBe(200);
    expect(b2.items).toHaveLength(50);
    const p3 = m.roots(owner(), { view: 'all', cursor: b2.nextCursor! });
    const b3 = p3.body as { items: unknown[]; nextCursor: string | null };
    expect(b3.items).toHaveLength(20);
    expect(b3.nextCursor).toBeNull();
    const seen = [...b1.items, ...b2.items, ...(b3.items as Array<{ ref: NodeRef }>)].map((i) => nodeKey(i.ref));
    expect(new Set(seen).size).toBe(120); // no dup, no skip, and the new effort did not shift pages
  });

  it('refuses a cursor after a grant change, after expiry, or when malformed or from another scope', () => {
    const { src, state } = makeSource({ convs: Array.from({ length: 60 }, (_, i) => conv(tg(i + 1), i)) });
    const m = new ConversationGraphReadModel(src, { snapshotTtlMs: 1000 });
    const c = (m.roots(owner(), { view: 'all' }).body as { nextCursor: string }).nextCursor;
    expect(m.roots(owner('g2'), { view: 'all', cursor: c })).toEqual({ status: 409, body: { code: 'cursor-stale', reason: 'grant-changed' } });
    expect(m.roots(owner(), { view: 'overview', cursor: c })).toEqual({ status: 409, body: { code: 'cursor-stale', reason: 'cursor-invalid' } });
    expect(m.roots(owner(), { view: 'all', cursor: 'not!a!cursor' })).toEqual({ status: 409, body: { code: 'cursor-stale', reason: 'cursor-invalid' } });
    state.now = new Date(state.now.getTime() + 5000);
    expect(m.roots(owner(), { view: 'all', cursor: c })).toEqual({ status: 409, body: { code: 'cursor-stale', reason: 'snapshot-expired' } });
  });

  it('drops only the rows revoked inside the snapshot window', () => {
    const convs = Array.from({ length: 60 }, (_, i) => conv(tg(i + 1), i));
    const { src } = makeSource({ convs });
    const m = new ConversationGraphReadModel(src);
    const revoked = new Set<string>();
    const viewer: GraphViewer = { principalKey: 'owner', grantVersion: 'g1', mayView: (r) => !revoked.has(nodeKey(r)) };
    const p1 = m.roots(viewer, { view: 'all' }).body as { items: Array<{ ref: NodeRef }>; nextCursor: string };
    const served = new Set(p1.items.map((i) => nodeKey(i.ref)));
    const remaining = convs.map((c) => nodeKey(c.ref)).filter((k) => !served.has(k));
    revoked.add(remaining[0]); // revoke one row that page 2 would have served
    const p2 = m.roots(viewer, { view: 'all', cursor: p1.nextCursor }).body as { items: Array<{ ref: NodeRef }> };
    expect(p2.items).toHaveLength(remaining.length - 1);
    expect(p2.items.map((i) => nodeKey(i.ref))).not.toContain(remaining[0]);
  });

  it('provenance is withheld when the placement\'s parent is hidden', () => {
    const E = effort(1);
    const { src } = makeSource({ events: [ev('create', E), ev('place', tg(1), E)], convs: [conv(tg(1), 1)] });
    const m = new ConversationGraphReadModel(src);
    expect((m.node(owner(), tg(1), {}).body as { provenance: unknown[] }).provenance).toHaveLength(1);
    const hidden = m.node(owner('g1', [nodeKey(E)]), tg(1), {}).body as { provenance: unknown[]; node: { role: string } };
    expect(hidden.provenance).toEqual([]);
    expect(hidden.node.role).toBe('unassigned');
  });

  it('remembers a snapshot only when there is a next page', () => {
    const { src } = makeSource({ convs: [conv(tg(1), 1)] });
    const m = new ConversationGraphReadModel(src);
    for (let i = 0; i < 5; i++) m.roots(owner(), { view: 'all' });
    expect((m as unknown as { snapshots: Map<string, unknown> }).snapshots.size).toBe(0);
  });

  it('pages children past 50, and treats hidden and absent nodes alike', () => {
    const E = effort(1);
    const events = [ev('create', E), ...Array.from({ length: 70 }, (_, i) => ev('place', tg(i + 1), E))];
    const convs = Array.from({ length: 70 }, (_, i) => conv(tg(i + 1), i));
    const { src } = makeSource({ events, convs });
    const m = new ConversationGraphReadModel(src);
    const n1 = m.node(owner(), E, {});
    const b1 = n1.body as { node: { visibleChildCount: number; title: string }; children: { items: unknown[]; nextCursor: string } };
    expect(b1.node.visibleChildCount).toBe(70);
    expect(b1.node.title).toBe('Launch');
    expect(b1.children.items).toHaveLength(50);
    const n2 = m.node(owner(), E, { cursor: b1.children.nextCursor }).body as { children: { items: unknown[]; nextCursor: string | null } };
    expect(n2.children.items).toHaveLength(20);
    expect(n2.children.nextCursor).toBeNull();
    expect(m.node(owner('g1', [nodeKey(E)]), E, {})).toEqual({ status: 404, body: { code: 'not-found' } });
    expect(m.node(owner(), effort(77), {})).toEqual({ status: 404, body: { code: 'not-found' } });
  });

  it('a hidden child changes the count and the pages, never just the page', () => {
    const E = effort(1);
    const events = [ev('create', E), ev('place', tg(1), E), ev('place', tg(2), E)];
    const { src } = makeSource({ events, convs: [conv(tg(1), 1), conv(tg(2), 2)] });
    const b = new ConversationGraphReadModel(src).node(owner('g1', [nodeKey(tg(2))]), E, {}).body as { node: { visibleChildCount: number }; children: { items: Array<{ ref: NodeRef }> } };
    expect(b.node.visibleChildCount).toBe(1);
    expect(b.children.items.map((i) => nodeKey(i.ref))).toEqual([nodeKey(tg(1))]);
  });
});

describe('conversation graph routes', () => {
  function app(viewer: GraphViewer | null, ready = true) {
    const E = effort(1);
    const { src } = makeSource({ events: [ev('create', E), ev('place', tg(1), E)], convs: [conv(tg(1), 1)], readiness: () => (ready ? { ready: true } : { ready: false, reason: 'no-a-proof' }) });
    const a = express();
    a.use(createConversationGraphRouter({ model: new ConversationGraphReadModel(src), resolveViewer: () => viewer }));
    return a;
  }

  it('refuses a non-owner on both surfaces', async () => {
    for (const p of ['/conversation-graph/roots', '/mobile/conversation-graph/roots']) {
      const r = await request(app(null)).get(p);
      expect(r.status).toBe(403);
      expect(r.body).toEqual({ code: 'hierarchy-owner-only' });
    }
  });

  it('answers 503 until ready', async () => {
    const r = await request(app(owner(), false)).get('/conversation-graph/roots');
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ code: 'conversation-graph-not-ready', reason: 'no-a-proof' });
  });

  it('returns NodeRef objects, and resolves a node by its route ref', async () => {
    const a = app(owner());
    const roots = await request(a).get('/conversation-graph/roots?view=overview');
    expect(roots.status).toBe(200);
    expect(roots.body.items[0].ref).toEqual(effort(1));
    const node = await request(a).get(`/mobile/conversation-graph/nodes/${encodeRouteRef(effort(1))}`);
    expect(node.status).toBe(200);
    expect(node.body.children.items[0].ref).toEqual(tg(1));
    expect(node.body.children.items[0].source).toEqual({ platform: 'telegram', conversationId: 1, title: 'Chat 1' });
  });

  it('a bad ref is 404 and a bad view is 400', async () => {
    const a = app(owner());
    expect((await request(a).get('/conversation-graph/nodes/not-a-ref')).status).toBe(404);
    expect((await request(a).get('/conversation-graph/roots?view=everything')).status).toBe(400);
  });

  it('refuses repeated or oversized query values instead of treating them as absent', async () => {
    const a = app(owner());
    expect((await request(a).get('/conversation-graph/roots?q=a&q=b')).status).toBe(400);
    expect((await request(a).get(`/conversation-graph/roots?q=${'x'.repeat(201)}`)).status).toBe(400);
    const r = await request(a).get('/conversation-graph/roots?cursor=c&cursor=c');
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ code: 'cursor-stale', reason: 'cursor-invalid' });
    expect((await request(a).get(`/conversation-graph/nodes/${encodeRouteRef(effort(1))}?cursor=${'c'.repeat(300)}`)).status).toBe(409);
    expect((await request(a).get(`/mobile/conversation-graph/nodes/${encodeRouteRef(effort(1))}?cursor=c&cursor=c`)).status).toBe(409);
  });
});
