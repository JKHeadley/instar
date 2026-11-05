/**
 * The pure core of the Conversations hierarchy read slice (src/core/conversationGraph.ts):
 * - opaque refs round-trip and have exactly one spelling per subject;
 * - untrusted events are validated, and junk is refused;
 * - the reducer depends only on the event SET (order and duplicates never change the result);
 * - user placements beat agent/inference placements; incompatible user placements are a visible
 *   conflict that keeps the last agreed parent; a resolution clears it;
 * - cycles and duplicate ids with different bytes are quarantined, never applied;
 * - the projection filters BEFORE it counts, searches or paths, so a hidden node leaves no trace;
 * - the source descriptor copies the flat row's id and machine exactly.
 */
import { describe, it, expect } from 'vitest';
import {
  encodeRef, decodeRef, validateGraphEvent, reduceGraph, GraphProjection,
  type GraphEvent, type ConversationSource,
} from '../../src/core/conversationGraph.js';

let seq = 0;
function ev(partial: Partial<GraphEvent> & Pick<GraphEvent, 'op' | 'subject'>): GraphEvent {
  seq += 1;
  return {
    schemaVersion: 1,
    eventId: partial.eventId ?? `evt-${String(seq).padStart(6, '0')}`,
    replacesPlacementEventIds: [],
    source: 'user',
    actor: 'owner',
    machineId: 'm1',
    createdAt: `2026-11-05T09:${String(10 + (seq % 49)).padStart(2, '0')}:00.000Z`,
    ...partial,
  } as GraphEvent;
}

const TG = (n: number) => `telegram:${n}`;
function convo(ref: string, title: string, lastActivity: string | null, extra: Partial<ConversationSource> = {}): ConversationSource {
  const platform = ref.split(':')[0] as ConversationSource['platform'];
  return { ref, platform, conversationId: Number(ref.split(':')[1]) || ref, title, lastActivity, ...extra };
}

describe('refs', () => {
  it('round-trips and is canonical', () => {
    const o = encodeRef(TG(42));
    expect(decodeRef(o)).toBe(TG(42));
    expect(o).toMatch(/^[A-Za-z0-9_-]+$/);
  });
  it('refuses a non-canonical spelling of the same ref', () => {
    const alt = Buffer.from(JSON.stringify({ v: 1, ref: TG(42) }), 'utf8').toString('base64url');
    expect(alt).not.toBe(encodeRef(TG(42)));
    expect(decodeRef(alt)).toBeNull();
  });
  it('refuses junk and unknown forms', () => {
    for (const bad of ['', '!!', encodeRef('telegram:abc'), Buffer.from('{"v":2,"ref":"telegram:1"}').toString('base64url'), 'x'.repeat(500)]) {
      expect(decodeRef(bad)).toBeNull();
    }
  });
});

describe('validateGraphEvent', () => {
  it('accepts a well-formed placement and refuses malformed ones', () => {
    const good = ev({ op: 'place', subject: TG(2), parent: 'effort:alpha' });
    expect(validateGraphEvent(JSON.parse(JSON.stringify(good)))).not.toBeNull();
    expect(validateGraphEvent({ ...good, parent: TG(2) })).toBeNull(); // self-parent
    expect(validateGraphEvent({ ...good, parent: 'nope' })).toBeNull();
    expect(validateGraphEvent({ ...good, schemaVersion: 2 })).toBeNull();
    expect(validateGraphEvent({ ...good, source: 'admin' })).toBeNull();
    expect(validateGraphEvent({ ...good, createdAt: 'yesterday' })).toBeNull();
    expect(validateGraphEvent({ ...good, op: 'delete' })).toBeNull();
    expect(validateGraphEvent({ ...ev({ op: 'define-effort', subject: TG(1), title: 'x' }) })).toBeNull(); // effort op on a conversation
  });
});

describe('reduceGraph', () => {
  it('depends only on the event set, not order or duplicates', () => {
    const e1 = ev({ op: 'define-effort', subject: 'effort:alpha', title: 'Alpha' });
    const e2 = ev({ op: 'place', subject: TG(1), parent: 'effort:alpha' });
    const e3 = ev({ op: 'place', subject: TG(2), parent: TG(1), source: 'delegation' });
    const a = reduceGraph([e1, e2, e3]);
    const b = reduceGraph([e3, e2, e1, e2, e3]);
    expect(b.revision).toBe(a.revision);
    expect([...b.parentOf]).toEqual([...a.parentOf]);
    expect(a.parentOf.get(TG(2))).toBe(TG(1));
  });

  it('a user placement beats a concurrent inferred one without erasing it', () => {
    const inf = ev({ op: 'place', subject: TG(3), parent: 'effort:a', source: 'inference' });
    const usr = ev({ op: 'place', subject: TG(3), parent: 'effort:b', source: 'user' });
    const g = reduceGraph([inf, usr]);
    expect(g.parentOf.get(TG(3))).toBe('effort:b');
    expect(g.conflicts).toEqual([]);
    expect(g.placementSource.get(TG(3))?.source).toBe('user');
  });

  it('incompatible user heads are a conflict that keeps the last agreed parent; a resolution clears it', () => {
    const base = ev({ op: 'place', subject: TG(4), parent: 'effort:a' });
    const u1 = ev({ op: 'place', subject: TG(4), parent: 'effort:b', replacesPlacementEventIds: [base.eventId] });
    const u2 = ev({ op: 'place', subject: TG(4), parent: 'effort:c', replacesPlacementEventIds: [base.eventId] });
    const g = reduceGraph([base, u1, u2]);
    expect(g.conflicts).toHaveLength(1);
    expect(g.conflicts[0].lastAgreedParent).toBe('effort:a');
    expect(g.parentOf.get(TG(4))).toBe('effort:a');
    const res = ev({ op: 'place', subject: TG(4), parent: 'effort:c', replacesPlacementEventIds: [u1.eventId, u2.eventId] });
    const g2 = reduceGraph([base, u1, u2, res]);
    expect(g2.conflicts).toEqual([]);
    expect(g2.parentOf.get(TG(4))).toBe('effort:c');
  });

  it('two user heads that agree are not a conflict', () => {
    const u1 = ev({ op: 'place', subject: TG(5), parent: 'effort:a' });
    const u2 = ev({ op: 'place', subject: TG(5), parent: 'effort:a' });
    expect(reduceGraph([u1, u2]).conflicts).toEqual([]);
  });

  it('quarantines a placement that would close a cycle and keeps the previous forest', () => {
    const p1 = ev({ op: 'place', subject: TG(10), parent: TG(11) });
    const p2 = ev({ op: 'place', subject: TG(11), parent: TG(10) });
    const g = reduceGraph([p1, p2]);
    expect(g.quarantined.map((q) => q.reason)).toContain('placement-would-create-cycle');
    // exactly one of the two was applied; no subject is its own ancestor
    const applied = [TG(10), TG(11)].filter((s) => g.parentOf.get(s));
    expect(applied).toHaveLength(1);
  });

  it('quarantines both copies of a duplicate id with different bytes', () => {
    const a = ev({ op: 'place', subject: TG(6), parent: 'effort:a', eventId: 'dup-event-1' });
    const b = { ...a, parent: 'effort:b' };
    const g = reduceGraph([a, b]);
    expect(g.quarantined).toEqual([{ eventId: 'dup-event-1', reason: 'duplicate-event-id-different-payload' }]);
    expect(g.parentOf.has(TG(6))).toBe(false);
  });
});

describe('GraphProjection (filter first, then count / search / path)', () => {
  const events = [
    ev({ op: 'define-effort', subject: 'effort:launch', title: 'Launch' }),
    ev({ op: 'define-effort', subject: 'effort:secret', title: 'Secret plan' }),
    ev({ op: 'set-front-door', subject: TG(100), frontDoor: true }),
    ev({ op: 'place', subject: TG(100), parent: 'effort:launch' }),
    ev({ op: 'place', subject: TG(101), parent: TG(100), source: 'delegation' }),
    ev({ op: 'place', subject: TG(102), parent: TG(100), source: 'delegation' }),
    ev({ op: 'place', subject: TG(200), parent: 'effort:secret' }),
  ];
  const graph = reduceGraph(events);
  const conversations = [
    convo(TG(100), 'Front door', '2026-11-05T09:00:00.000Z'),
    convo(TG(101), 'Worker visible', '2026-11-05T09:05:00.000Z'),
    convo(TG(102), 'Worker hidden', '2026-11-05T09:06:00.000Z'),
    convo(TG(200), 'Secret worker', '2026-11-05T08:00:00.000Z'),
    convo(TG(300), 'Unassigned chat', '2026-11-05T07:00:00.000Z'),
  ];

  it('the owner sees everything, with counts and paths', () => {
    const p = new GraphProjection({ graph, conversations, mayView: () => true });
    expect(p.item(TG(100))?.visibleChildCount).toBe(2);
    expect(p.item(TG(100))?.role).toBe('front-door');
    expect(p.item(TG(101))?.primaryPath.map((x) => x.title)).toEqual(['Launch', 'Front door']);
    expect(p.roots('all', null)).toContain(TG(300));
    expect(p.roots('overview', null)).not.toContain(TG(300)); // unassigned stays in All only
  });

  it('a hidden child is not counted, not listed, not searchable', () => {
    const p = new GraphProjection({ graph, conversations, mayView: (r) => r !== TG(102) });
    expect(p.item(TG(100))?.visibleChildCount).toBe(1);
    expect(p.childrenOf(TG(100))).toEqual([TG(101)]);
    expect(p.roots('all', 'hidden')).toEqual([]);
    expect(p.item(TG(102))).toBeNull();
  });

  it('an effort whose only children are hidden reveals nothing about them', () => {
    const p = new GraphProjection({ graph, conversations, mayView: (r) => r !== TG(200) });
    expect(p.item('effort:secret')?.visibleChildCount).toBe(0);
    expect(p.childrenOf('effort:secret')).toEqual([]);
  });

  it('a hidden parent leaves no trace: the child surfaces as a root with an empty path', () => {
    const p = new GraphProjection({ graph, conversations, mayView: (r) => r !== 'effort:secret' });
    expect(p.item(TG(200))?.primaryPath).toEqual([]);
    expect(p.item(TG(200))?.role).toBe('unassigned');
    expect(p.roots('all', null)).toContain(TG(200));
    expect(JSON.stringify(p.item(TG(200)))).not.toContain('Secret plan');
  });

  it('copies the flat row id and machine exactly into the source descriptor', () => {
    const slack = { ref: 'slack:T1:C1', platform: 'slack' as const, conversationId: -7, machine: 'studio', title: 'Slack thread', lastActivity: null };
    const p = new GraphProjection({ graph: reduceGraph([]), conversations: [slack], mayView: () => true });
    expect(p.item('slack:T1:C1')?.source).toEqual({ platform: 'slack', conversationId: -7, title: 'Slack thread', machine: 'studio' });
    expect(p.item('slack:T1:C1')?.source?.conversationId).toBeTypeOf('number');
  });

  it('orders roots newest-activity first, deterministically', () => {
    const p = new GraphProjection({ graph, conversations, mayView: () => true });
    const a = p.roots('all', null);
    const b = new GraphProjection({ graph, conversations: [...conversations].reverse(), mayView: () => true }).roots('all', null);
    expect(b).toEqual(a);
  });
});
