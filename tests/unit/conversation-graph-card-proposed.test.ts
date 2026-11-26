/**
 * Work-front-doors stage 2b (spec §3.2): a work card's conversation is PROPOSED under the effort that holds
 * its project's conversation, from the card record, until the card-record graph authority exists. An owner
 * placement wins; the viewer filter decides what is visible; nothing here writes a graph event.
 */
import { describe, it, expect } from 'vitest';
import { ConversationGraphReadModel, MAX_PROPOSED_CARDS, type GraphReadSource, type GraphViewer } from '../../src/core/conversationGraphRead.js';
import { nodeKey, type ConversationRef, type ConversationSource, type EffortRef, type GraphEvent, type NodeRef, type ProjectionItem } from '../../src/core/conversationGraph.js';

const tg = (topicId: number): ConversationRef => ({ kind: 'conversation', platform: 'telegram', chatId: '-1001', topicId });
const effortA: EffortRef = { kind: 'effort', id: '00000000-0000-4000-8000-00000000000a' };
const effortB: EffortRef = { kind: 'effort', id: '00000000-0000-4000-8000-00000000000b' };
const base = { authority: 'owner', principal: 'owner', receipt: { kind: 'owner-proof', id: 'r1' }, machineId: 'm1', schemaVersion: 1 };
const create = (e: EffortRef, n: number) => ({ ...base, eventId: `evt-create-${n}`, op: 'create-effort', subject: e, projectScope: [], headerId: `hdr-${n}`, createdAt: `2026-11-16T10:0${n}:00.000Z` });
const place = (subject: NodeRef, parent: EffortRef, n: number) => ({ ...base, eventId: `evt-place-${n}`, op: 'set-primary-placement', subject, parent, relation: 'coordinates', replacesPlacementEventIds: [], createdAt: `2026-11-16T11:0${n}:00.000Z` });
const conv = (r: ConversationRef, title: string): ConversationSource => ({ ref: r, conversationId: (r as { topicId: number }).topicId, title, lastActivity: '2026-11-16T09:00:00.000Z' });

function model(events: unknown[], cards: Array<{ card: ConversationRef; project: ConversationRef }> | undefined) {
  const source: GraphReadSource = {
    readiness: () => ({ ready: true }), certifiedEvents: () => events as GraphEvent[], verify: () => true,
    conversations: () => [conv(tg(5), 'Shop launch'), conv(tg(7), 'Pick the launch date'), conv(tg(8), 'Order the boxes'), conv(tg(9), 'Other project')],
    effortTitle: () => 'Project', replication: () => ({ replicaLag: false, eventGap: false, evidenceMissing: false }),
    now: () => new Date('2026-11-16T12:00:00.000Z'), correctionsReady: () => true,
    ...(cards ? { cardPlacements: () => cards } : {}),
  };
  return new ConversationGraphReadModel(source);
}
const owner: GraphViewer = { principalKey: 'owner', grantVersion: 'g', mayView: () => true, hasFullCorrectionScope: () => true };
const proposedOf = (r: { body: Record<string, unknown> }) => ((r.body.proposed as { items: ProjectionItem[] } | undefined)?.items ?? []).map((i) => (i.ref as { topicId: number }).topicId);

describe('cards proposed under their project (stage 2b)', () => {
  const events = [create(effortA, 1), create(effortB, 2), place(tg(5), effortA, 1), place(tg(9), effortB, 2)];

  it('a card whose project conversation sits in this effort is proposed here, labelled by the card record', () => {
    const m = model(events, [{ card: tg(7), project: tg(5) }]);
    const r = m.node(owner, effortA, {}) as { status: number; body: Record<string, unknown> };
    expect(r.status).toBe(200);
    expect(proposedOf(r)).toEqual([7]);
    expect((r.body.proposed as { by: string }).by).toBe('card-record');
    // It is not a child (no placement was written), and the other effort shows nothing.
    expect(((r.body.children as { items: ProjectionItem[] }).items).map((i) => nodeKey(i.ref))).not.toContain(nodeKey(tg(7)));
    expect(proposedOf(m.node(owner, effortB, {}) as { body: Record<string, unknown> })).toEqual([]);
  });

  it('an owner placement wins: a card conversation placed anywhere is not proposed', () => {
    const m = model([...events, place(tg(7), effortB, 3)], [{ card: tg(7), project: tg(5) }]);
    expect(proposedOf(m.node(owner, effortA, {}) as { body: Record<string, unknown> })).toEqual([]);
  });

  it('a project conversation in no effort proposes nothing; a card the viewer may not see is left out', () => {
    const unplaced = model([create(effortA, 1)], [{ card: tg(7), project: tg(5) }]);
    expect(proposedOf(unplaced.node(owner, effortA, {}) as { body: Record<string, unknown> })).toEqual([]);
    const m = model(events, [{ card: tg(7), project: tg(5) }, { card: tg(8), project: tg(5) }]);
    const guest: GraphViewer = { ...owner, mayView: (ref: NodeRef) => nodeKey(ref) !== nodeKey(tg(8)) };
    expect(proposedOf(m.node(guest, effortA, {}) as { body: Record<string, unknown> })).toEqual([7]);
    // Both ends: a viewer who may not see the project conversation learns nothing through its cards.
    const noProject: GraphViewer = { ...owner, mayView: (ref: NodeRef) => nodeKey(ref) !== nodeKey(tg(5)) };
    expect((m.node(noProject, effortA, {}) as { body: Record<string, unknown> }).body.proposed).toBeUndefined();
  });

  it('no card source, or none for this project: the page is unchanged (no proposed field)', () => {
    expect((model(events, undefined).node(owner, effortA, {}) as { body: Record<string, unknown> }).body.proposed).toBeUndefined();
    expect((model(events, []).node(owner, effortA, {}) as { body: Record<string, unknown> }).body.proposed).toBeUndefined();
    expect(MAX_PROPOSED_CARDS).toBe(50);
  });
});
