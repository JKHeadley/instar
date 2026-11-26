/**
 * The phone tree read (work-front-doors stage 2 "Mobile hierarchy routes"; hierarchy v3 §7.4):
 * - root efforts with children nested, front door and Project label, from the one viewer-filtered projection;
 * - a hidden node is never nested, counted, proposed or used to label a project;
 * - depth, per-node and response limits say so with childrenComplete:false;
 * - pages over root efforts with the same signed, viewer-bound snapshot cursor;
 * - the router: phone only, owner only, unreadable projects become projects:'unknown'.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { ConversationGraphReadModel, TREE_CHILD_LIMIT, TREE_MAX_DEPTH, type GraphReadSource, type GraphViewer, type TreeNode } from '../../src/core/conversationGraphRead.js';
import { createConversationGraphRouter } from '../../src/server/conversationGraphRoutes.js';
import { treeProjects } from '../../src/core/workFrontDoorsGraph.js';
import { encodeRouteRef, nodeKey, type GraphEvent, type NodeRef, type EffortRef, type ConversationRef, type ConversationSource } from '../../src/core/conversationGraph.js';

const effort = (n: number): EffortRef => ({ kind: 'effort', id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` });
const tg = (topicId: number): ConversationRef => ({ kind: 'conversation', platform: 'telegram', chatId: '-1001234567890', topicId });
const app = (key: string): ConversationRef => ({ kind: 'conversation', platform: 'app', conversationKey: key });
let seq = 0;
function base(subject: NodeRef) {
  seq += 1;
  return { schemaVersion: 1 as const, eventId: `evt-${String(seq).padStart(6, '0')}`, subject, authority: 'owner' as const, principal: 'owner', receipt: { kind: 'owner-proof' as const, id: `r${seq}` }, machineId: 'm1', createdAt: `2026-11-05T10:${String(seq % 60).padStart(2, '0')}:00.000Z` };
}
const create = (e: EffortRef): GraphEvent => ({ ...base(e), op: 'create-effort', projectScope: [], headerId: 'hdr-' + e.id.replace(/-/g, '') } as GraphEvent);
const place = (subject: NodeRef, parent: NodeRef): GraphEvent => ({ ...base(subject), op: 'set-primary-placement', parent,
  relation: parent.kind === 'effort' ? (subject.kind === 'effort' ? 'contains' : 'coordinates') : 'delegates-to', replacesPlacementEventIds: [] } as GraphEvent);
const frontDoor = (e: EffortRef, c: ConversationRef, placement: GraphEvent): GraphEvent => ({ ...base(e), op: 'set-front-door', frontDoor: c,
  replacesFrontDoorEventIds: [], observedPlacementEventIds: [placement.eventId] } as GraphEvent);

const conv = (r: ConversationRef, i: number): ConversationSource => ({ ref: r, conversationId: r.platform === 'telegram' ? (r as { topicId: number }).topicId : (r as { conversationKey: string }).conversationKey,
  title: `Chat ${i}`, lastActivity: `2026-11-05T09:${String(i % 60).padStart(2, '0')}:00.000Z` });

function source(events: GraphEvent[], convs: ConversationSource[], extra: Partial<GraphReadSource> = {}): GraphReadSource {
  return {
    readiness: () => ({ ready: true }),
    certifiedEvents: () => events,
    verify: () => true,
    conversations: () => convs,
    effortTitle: (e) => `Effort ${parseInt(e.id.slice(-12), 10)}`,
    replication: () => ({ replicaLag: false, eventGap: false, evidenceMissing: false }),
    now: () => new Date('2026-11-05T11:00:00.000Z'),
    ...extra,
  };
}
const owner = (grant = 'g1', hidden: NodeRef[] = []): GraphViewer => ({ principalKey: 'owner', grantVersion: grant, mayView: (r) => !hidden.some((h) => nodeKey(h) === nodeKey(r)) });

/** Launch (E1, front door C1, worker C2) contains Design (E2, worker C3); C4 is unassigned. */
function launch() {
  const E1 = effort(1), E2 = effort(2), C1 = tg(101), C2 = tg(102), C3 = app('8dd76d04-3e1d-4784-9f9e-d70635910f3c'), C4 = tg(104);
  const p1 = place(C1, E1);
  const events = [create(E1), create(E2), p1, frontDoor(E1, C1, p1), place(C2, E1), place(E2, E1), place(C3, E2)];
  return { E1, E2, C1, C2, C3, C4, events, convs: [conv(C1, 1), conv(C2, 2), conv(C3, 3), conv(C4, 4)] };
}
const body = (r: ReturnType<ConversationGraphReadModel['tree']>) => { expect(r.status).toBe(200); return r.body as { items: TreeNode[]; root?: TreeNode; nextCursor: string | null; projects: string; partial: boolean; limits: Record<string, number> }; };
const find = (nodes: TreeNode[] | undefined, ref: NodeRef): TreeNode | undefined => {
  for (const n of nodes ?? []) {
    if (nodeKey(n.ref) === nodeKey(ref)) return n;
    const hit = find(n.children, ref) ?? find(n.proposed, ref); if (hit) return hit;
  }
  return undefined;
};

describe('ConversationGraphReadModel.tree', () => {
  it('answers 503 with the source reason before computing anything', () => {
    const src = source([], []);
    src.readiness = () => ({ ready: false, reason: 'not-yet' });
    src.certifiedEvents = () => { throw new Error('must not project'); };
    expect(new ConversationGraphReadModel(src).tree(owner(), {})).toEqual({ status: 503, body: { code: 'conversation-graph-off', reason: 'not-yet' } });
  });

  it('nests root efforts, their conversations and nested efforts, with the front door and route refs', () => {
    const t = launch();
    const b = body(new ConversationGraphReadModel(source(t.events, t.convs)).tree(owner(), { projects: [] }));
    expect(b.items.map((n) => nodeKey(n.ref))).toEqual([nodeKey(t.E1)]); // E2 is nested, C4 stays in the flat list
    const launchNode = b.items[0];
    expect(launchNode).toMatchObject({ title: 'Effort 1', kind: 'effort', role: 'effort', frontDoor: t.C1, visibleChildCount: 3, childrenComplete: true });
    expect(launchNode.routeRef).toBe(encodeRouteRef(t.E1));
    expect(find(b.items, t.C1)).toMatchObject({ role: 'front-door', source: { platform: 'telegram', conversationId: 101 } });
    expect(find(b.items, t.C2)?.role).toBe('worker');
    const design = find(b.items, t.E2)!;
    expect(design).toMatchObject({ title: 'Effort 2', placedBy: 'owner', childrenComplete: true });
    expect(design.children!.map((n) => n.title)).toEqual(['Chat 3']);
    expect(find(b.items, t.C4)).toBeUndefined();
    expect(b).toMatchObject({ projects: 'known', partial: false, limits: { depth: TREE_MAX_DEPTH, childrenPerNode: TREE_CHILD_LIMIT } });
    expect(b.items[0].project).toBeUndefined();
  });

  it('labels a tracked project from its front door, or else a conversation directly in it', () => {
    const t = launch();
    const model = new ConversationGraphReadModel(source(t.events, t.convs));
    const byFrontDoor = body(model.tree(owner(), { projects: [{ ref: t.C1, title: 'Shop launch', conversationKey: 'telegram:101' }] }));
    expect(byFrontDoor.items[0].project).toEqual({ title: 'Shop launch', conversationKey: 'telegram:101' });
    const byChild = body(model.tree(owner(), { projects: [{ ref: t.C3, title: 'Design work', conversationKey: 'app:8dd76d04-3e1d-4784-9f9e-d70635910f3c' }] }));
    expect(byChild.items[0].project).toBeUndefined();
    expect(find(byChild.items, t.E2)?.project).toEqual({ title: 'Design work', conversationKey: 'app:8dd76d04-3e1d-4784-9f9e-d70635910f3c' });
    const unknown = body(model.tree(owner(), { projects: null }));
    expect(unknown.projects).toBe('unknown');
    expect(JSON.stringify(unknown.items)).not.toContain('"project"');
  });

  it('never nests, counts, or labels from a conversation the viewer may not see', () => {
    const t = launch();
    const model = new ConversationGraphReadModel(source(t.events, t.convs));
    const projects = [{ ref: t.C3, title: 'Secret project', conversationKey: 'app:8dd76d04-3e1d-4784-9f9e-d70635910f3c' }, { ref: t.C1, title: 'Hidden front', conversationKey: 'telegram:101' }];
    const b = body(model.tree(owner('limited', [t.C3, t.C1]), { projects }));
    const text = JSON.stringify(b);
    expect(text).not.toContain('8dd76d04');
    expect(text).not.toContain('Secret project');
    expect(text).not.toContain('Hidden front');
    expect(text).not.toContain('"topicId":101');
    expect(b.items[0].frontDoor).toBeUndefined();
    expect(b.items[0].visibleChildCount).toBe(2);
    expect(find(b.items, t.E2)).toMatchObject({ visibleChildCount: 0, children: [], childrenComplete: true });
  });

  it('a hidden effort hides its whole subtree; a visible nested effort becomes a root for that viewer', () => {
    const t = launch();
    const b = body(new ConversationGraphReadModel(source(t.events, t.convs)).tree(owner('limited', [t.E1]), { projects: [] }));
    expect(b.items.map((n) => nodeKey(n.ref))).toEqual([nodeKey(t.E2)]);
    expect(JSON.stringify(b)).not.toContain('Effort 1');
    expect(b.items[0].children!.map((n) => n.title)).toEqual(['Chat 3']);
  });

  it('cuts children past the per-node limit and below the depth limit, and says so', () => {
    const E = effort(1), events: GraphEvent[] = [create(E)], convs: ConversationSource[] = [];
    for (let i = 1; i <= TREE_CHILD_LIMIT + 5; i++) { const c = tg(200 + i); convs.push(conv(c, i)); events.push(place(c, E)); }
    let parent: EffortRef = E;
    const chain: EffortRef[] = [];
    for (let d = 2; d <= TREE_MAX_DEPTH + 2; d++) { const e = effort(d); chain.push(e); events.push(create(e), place(e, parent)); parent = e; }
    const leaf = tg(999); convs.push({ ...conv(leaf, 59), lastActivity: '2026-11-05T10:59:00.000Z' }); events.push(place(leaf, parent));
    const b = body(new ConversationGraphReadModel(source(events, convs)).tree(owner(), { projects: [] }));
    const root = b.items[0];
    expect(root.visibleChildCount).toBe(TREE_CHILD_LIMIT + 6);
    expect(root.children).toHaveLength(TREE_CHILD_LIMIT);
    expect(root.childrenComplete).toBe(false);
    // The chain is the most recently active child, so it is shown first and nests down to the depth limit.
    let node: TreeNode | undefined = root;
    for (let depth = 1; depth < TREE_MAX_DEPTH; depth++) node = node!.children!.find((c) => c.kind === 'effort');
    expect(node!.children).toEqual([]);
    expect(node!.childrenComplete).toBe(false);
    expect(node!.visibleChildCount).toBe(1);
  });

  it('stops at the response budget, saying which nodes were cut, and reads the card record once', () => {
    const events: GraphEvent[] = [], convs: ConversationSource[] = [], placements: Array<{ card: ConversationRef; project: ConversationRef }> = [];
    let topic = 1000;
    for (let e = 1; e <= 30; e++) {
      const E = effort(e); events.push(create(E));
      for (let i = 0; i < 15; i++) { const c = tg(++topic); convs.push(conv(c, e)); events.push(place(c, E)); if (i === 0) {
        const card = app(`00000000-0000-4000-8000-${String(topic).padStart(12, '0')}`); convs.push(conv(card, e)); placements.push({ card, project: c }); } }
    }
    let reads = 0;
    const b = body(new ConversationGraphReadModel(source(events, convs, { cardPlacements: () => { reads++; return placements; } })).tree(owner(), { projects: [] }));
    expect(reads).toBe(1);
    const count = (nodes: TreeNode[]): number => nodes.reduce((n, x) => n + 1 + count(x.children ?? []) + (x.proposed?.length ?? 0), 0);
    expect(count(b.items)).toBeLessThanOrEqual(400 + 30);
    expect(b.items).toHaveLength(30);
    const cutChildren = b.items.filter((n) => n.childrenComplete === false);
    expect(cutChildren.length).toBeGreaterThan(0);
    for (const n of b.items) {
      if (n.childrenComplete !== false) expect(n.children).toHaveLength(15);
      if (n.proposedComplete === false) expect(n.proposed ?? []).toHaveLength(0);
    }
    expect(b.items.some((n) => n.proposedComplete === false)).toBe(true);
  });

  it('pages root efforts with a viewer-bound cursor and puts the root conversation on the first page only', () => {
    const events: GraphEvent[] = [];
    for (let i = 1; i <= 60; i++) events.push(create(effort(i)));
    const cos = tg(7);
    const model = new ConversationGraphReadModel(source(events, [conv(cos, 1)]), { rootConversation: () => cos });
    const first = body(model.tree(owner(), { projects: [] }));
    expect(first.items).toHaveLength(50);
    expect(first.root).toMatchObject({ ref: cos, routeRef: encodeRouteRef(cos) });
    expect(first.nextCursor).toBeTruthy();
    const second = body(model.tree(owner(), { cursor: first.nextCursor, projects: [] }));
    expect(second.items).toHaveLength(10);
    expect(second.root).toBeUndefined();
    expect(new Set([...first.items, ...second.items].map((n) => nodeKey(n.ref))).size).toBe(60);
    expect(model.tree(owner('g2'), { cursor: first.nextCursor })).toEqual({ status: 409, body: { code: 'cursor-stale', reason: 'grant-changed' } });
    // A roots cursor is not a tree cursor.
    const rootsCursor = (model.roots(owner(), { view: 'all' }).body as { nextCursor: string }).nextCursor;
    expect(model.tree(owner(), { cursor: rootsCursor })).toEqual({ status: 409, body: { code: 'cursor-stale', reason: 'cursor-invalid' } });
  });

  it('nests proposed card conversations, only when the project conversation is visible', () => {
    const t = launch();
    const card = app('9ee76d04-3e1d-4784-9f9e-d70635910f3c');
    const src = source(t.events, [...t.convs, conv(card, 9)], { cardPlacements: () => [{ card, project: t.C2 }] });
    const model = new ConversationGraphReadModel(src);
    expect(body(model.tree(owner(), { projects: [] })).items[0].proposed?.map((n) => n.ref)).toEqual([card]);
    const hidden = body(model.tree(owner('limited', [t.C2]), { projects: [] }));
    expect(hidden.items[0].proposed).toBeUndefined();
    expect(JSON.stringify(hidden)).not.toContain('9ee76d04');
  });
});

describe('treeProjects', () => {
  it('keeps telegram and app project conversations with the Work page key, and drops the rest', () => {
    const slack: ConversationRef = { kind: 'conversation', platform: 'slack', channelId: 'C1' } as ConversationRef;
    expect(treeProjects([{ ref: tg(5), title: 'A' }, { ref: app('aaa76d04-3e1d-4784-9f9e-d70635910f3c'), title: 'B' }, { ref: slack, title: 'C' }])).toEqual([
      { ref: tg(5), title: 'A', conversationKey: 'telegram:5' }, { ref: app('aaa76d04-3e1d-4784-9f9e-d70635910f3c'), title: 'B', conversationKey: 'app:aaa76d04-3e1d-4784-9f9e-d70635910f3c' }]);
  });
});

describe('GET /mobile/conversation-graph/tree', () => {
  const t = launch();
  const model = new ConversationGraphReadModel(source(t.events, t.convs));
  const appWith = (deps: Partial<Parameters<typeof createConversationGraphRouter>[0]>) => {
    const a = express();
    a.use(createConversationGraphRouter({ model, resolveViewer: (_req, surface) => (surface === 'mobile' ? owner() : null), ...deps }));
    return a;
  };
  it('serves the owner phone the tree with project labels', async () => {
    const r = await request(appWith({ projects: () => [{ ref: t.C1, title: 'Shop launch', conversationKey: 'telegram:101' }] })).get('/mobile/conversation-graph/tree');
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body.projects).toBe('known');
    expect(r.body.items[0].project).toEqual({ title: 'Shop launch', conversationKey: 'telegram:101' });
  });
  it('refuses requests without owner admission on both routes', async () => {
    const a = express();
    a.use(createConversationGraphRouter({ model, resolveViewer: () => null }));
    expect((await request(a).get('/mobile/conversation-graph/tree')).body).toEqual({ code: 'hierarchy-owner-only' });
    expect((await request(appWith({})).get('/conversation-graph/tree')).status).toBe(403);
  });
  it('says projects are unknown when they cannot be read, and refuses a bad cursor', async () => {
    const throwing = await request(appWith({ projects: () => { throw new Error('boom'); } })).get('/mobile/conversation-graph/tree');
    expect(throwing.body.projects).toBe('unknown');
    expect((await request(appWith({})).get('/mobile/conversation-graph/tree')).body.projects).toBe('unknown');
    const bad = await request(appWith({})).get('/mobile/conversation-graph/tree?cursor=nope');
    expect(bad.status).toBe(409);
    expect((await request(appWith({})).get('/mobile/conversation-graph/tree?cursor=a&cursor=b')).status).toBe(409);
  });
});
