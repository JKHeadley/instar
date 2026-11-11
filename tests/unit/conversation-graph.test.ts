/**
 * The pure core of the Conversations hierarchy (src/core/conversationGraph.ts), against
 * docs/specs/conversation-effort-hierarchy-v3.md §3.1–3.3 and §7.5. Each block names the rule it
 * pins; the six reducer defects found in review of 6b7f81aa2 each have a regression here.
 */
import { describe, it, expect } from 'vitest';
import {
  validateNodeRef, encodeRouteRef, decodeRouteRef, nodeKey, validateGraphEvent, reduceGraph, GraphProjection, moveEligibility,
  type NodeRef, type EffortRef, type ConversationRef, type GraphEvent, type Authority, type ConversationSource,
} from '../../src/core/conversationGraph.js';

const VERIFY_ALL = { verify: () => true };
const AT = '2026-11-05T23:59:00.000Z'; // the createdAt a correction will carry
const effort = (n: number): EffortRef => ({ kind: 'effort', id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` });
const tg = (topicId: number, chatId = '-1001234567890'): ConversationRef => ({ kind: 'conversation', platform: 'telegram', chatId, topicId });
const RECEIPT: Record<Authority, GraphEvent['receipt']['kind']> = { owner: 'owner-proof', delegation: 'dispatch-record', import: 'import-record', inference: 'inference-candidate' };

let seq = 0;
function base(subject: NodeRef, authority: Authority, extra: { eventId?: string; at?: string } = {}) {
  seq += 1;
  return {
    schemaVersion: 1 as const,
    eventId: extra.eventId ?? `evt-${String(seq).padStart(6, '0')}`,
    subject, authority, principal: authority === 'owner' ? 'owner' : 'agent',
    receipt: { kind: RECEIPT[authority], id: `r-${seq}` },
    machineId: 'm1',
    createdAt: extra.at ?? `2026-11-05T10:${String(seq % 60).padStart(2, '0')}:00.000Z`,
  };
}
function relation(subject: NodeRef, parent: NodeRef | null) {
  if (!parent) return null;
  if (parent.kind === 'effort') return subject.kind === 'effort' ? 'contains' : 'coordinates';
  return 'delegates-to';
}
function place(subject: NodeRef, parent: NodeRef | null, authority: Authority = 'owner', replaces: string[] = [], extra: { eventId?: string; at?: string } = {}): GraphEvent {
  return { ...base(subject, authority, extra), op: 'set-primary-placement', parent, relation: relation(subject, parent), replacesPlacementEventIds: replaces } as GraphEvent;
}
function create(e: EffortRef): GraphEvent { return { ...base(e, 'owner'), op: 'create-effort', projectScope: [], headerId: `hdr-${e.id.replace(/-/g, '')}` } as GraphEvent; }
function frontDoor(e: EffortRef, conv: ConversationRef | null, observed: string[] = [], replaces: string[] = []): GraphEvent {
  return { ...base(e, 'owner'), op: 'set-front-door', frontDoor: conv, replacesFrontDoorEventIds: replaces, observedPlacementEventIds: observed } as GraphEvent;
}
const parentOf = (g: ReturnType<typeof reduceGraph>, r: NodeRef) => g.parentOf.get(nodeKey(r));

describe('NodeRef (§7.5)', () => {
  const variants: NodeRef[] = [
    effort(1), tg(42),
    { kind: 'conversation', platform: 'slack', channelId: 'C0123ABCD' },
    { kind: 'conversation', platform: 'slack', channelId: 'C0123ABCD', threadTs: '1730000000.123456' },
    { kind: 'conversation', platform: 'app', conversationKey: '8dd76d04-3e1d-4784-9f9e-d70635910f3c' },
  ];
  it('every variant round-trips through the route parameter', () => {
    for (const v of variants) expect(decodeRouteRef(encodeRouteRef(v))).toEqual(v);
  });
  it('only the canonical spelling decodes', () => {
    const alt = Buffer.from(JSON.stringify({ topicId: 42, kind: 'conversation', chatId: '-1001234567890', platform: 'telegram' })).toString('base64url');
    expect(alt).not.toBe(encodeRouteRef(tg(42)));
    expect(decodeRouteRef(alt)).toBeNull(); // same object, different key order: refused
    expect(decodeRouteRef(encodeRouteRef(tg(42)))).toEqual(tg(42));
  });
  it('a Telegram ref carries the chat, so equal topic ids in two groups never collide', () => {
    expect(nodeKey(tg(5, '-1001'))).not.toBe(nodeKey(tg(5, '-1002')));
  });
  it('refuses extra fields, numeric aliases and malformed ids', () => {
    expect(validateNodeRef({ ...tg(1), alias: -7 })).toBeNull();
    expect(validateNodeRef({ kind: 'conversation', platform: 'slack', channelId: '-7' })).toBeNull();
    expect(validateNodeRef({ kind: 'effort', id: 'not-a-uuid' })).toBeNull();
    expect(validateNodeRef({ kind: 'conversation', platform: 'telegram', chatId: -100, topicId: 1 })).toBeNull();
  });
});

describe('validateGraphEvent', () => {
  it('refuses an effort placed under a conversation (defect 6)', () => {
    expect(validateGraphEvent({ ...place(effort(1), tg(1)), relation: 'delegates-to' })).toBeNull();
    expect(validateGraphEvent({ ...place(effort(1), tg(1)), relation: null })).toBeNull();
  });
  it('refuses a receipt that does not match the claimed tier', () => {
    const e = place(tg(1), tg(2), 'delegation');
    expect(validateGraphEvent(e)).not.toBeNull();
    expect(validateGraphEvent({ ...e, receipt: { kind: 'owner-proof', id: 'x' } })).toBeNull();
  });
  it('delegation may only produce delegates-to; create-effort and front door are owner-only', () => {
    expect(validateGraphEvent(place(tg(1), effort(1), 'delegation'))).toBeNull();
    expect(validateGraphEvent({ ...create(effort(1)), authority: 'delegation', receipt: { kind: 'dispatch-record', id: 'x' } })).toBeNull();
  });
  it('identifier fields refuse prose (principal, machineId, receipt id, project scope)', () => {
    const e = place(tg(1), effort(1));
    expect(validateGraphEvent({ ...e, principal: 'Acme merger plan' })).toBeNull();
    expect(validateGraphEvent({ ...e, machineId: 'my secret' })).toBeNull();
    expect(validateGraphEvent({ ...e, receipt: { kind: 'owner-proof', id: 'the plan is x' } })).toBeNull();
    expect(validateGraphEvent({ ...create(effort(1)), projectScope: ['secret project name'] })).toBeNull();
  });
  it('create-effort requires an opaque header id', () => {
    const c = create(effort(1));
    expect(validateGraphEvent(c)).toMatchObject({ headerId: (c as { headerId: string }).headerId });
    expect(validateGraphEvent({ ...c, headerId: undefined })).toBeNull();
    expect(validateGraphEvent({ ...c, headerId: 'Launch plan' })).toBeNull();
  });
  it('carries no free text field', () => {
    expect(validateGraphEvent({ ...create(effort(1)), title: 'secret' } as unknown)).not.toHaveProperty('title');
  });
});

describe('reduceGraph', () => {
  it('unverified authority is never reduced', () => {
    const g = reduceGraph([create(effort(1)), place(tg(1), effort(1))], { verify: () => false });
    expect(g.parentOf.size).toBe(0);
    expect(g.efforts.size).toBe(0);
    expect(g.partial.evidenceMissing).toBe(true);
    expect(new Set(g.setAside.map((s) => s.reason))).toEqual(new Set(['unverified-authority']));
  });

  it('depends only on the event set', () => {
    const evs = [create(effort(1)), place(tg(1), effort(1)), place(tg(2), tg(1), 'delegation')];
    const a = reduceGraph(evs, VERIFY_ALL);
    const b = reduceGraph([...evs].reverse().concat(evs), VERIFY_ALL);
    expect(b.revision).toBe(a.revision);
    expect([...b.parentOf].sort()).toEqual([...a.parentOf].sort());
  });

  it('a delegation event that names an owner head cannot dislodge it (defect 1)', () => {
    const owner = place(tg(2), effort(1));
    const agent = place(tg(2), tg(1), 'delegation', [owner.eventId]);
    const g = reduceGraph([owner, agent], VERIFY_ALL);
    expect(parentOf(g, tg(2))).toEqual(effort(1));
    expect(g.placementSource.get(nodeKey(tg(2)))?.authority).toBe('owner');
  });

  it('last agreed is the newest common ancestor, not the newest replaced event (defect 2)', () => {
    const A = place(tg(3), effort(1));
    const B = place(tg(3), effort(2), 'owner', [A.eventId]);
    const C = place(tg(3), effort(3), 'owner', [A.eventId]);
    const D = place(tg(3), effort(4), 'owner', [B.eventId]);
    const g = reduceGraph([A, B, C, D], VERIFY_ALL);
    expect(g.conflicts).toHaveLength(1);
    expect(g.conflicts[0].heads).toEqual([C.eventId, D.eventId].sort());
    expect(g.conflicts[0].lastAgreed).toEqual(effort(1));
    expect(parentOf(g, tg(3))).toEqual(effort(1));
    const R = place(tg(3), effort(4), 'owner', [C.eventId, D.eventId]);
    const g2 = reduceGraph([A, B, C, D, R], VERIFY_ALL);
    expect(g2.conflicts).toEqual([]);
    expect(parentOf(g2, tg(3))).toEqual(effort(4));
  });

  it('cycle authority: an inferred placement cannot quarantine an owner placement, whatever the key order (defect 3)', () => {
    // Choose refs so the inferred subject sorts first.
    const lowKey = tg(1, '-1000000000001');
    const highKey = tg(1, '-1009999999999');
    const owner = place(highKey, lowKey);            // owner: high under low
    const inferred = place(lowKey, highKey, 'inference'); // inference: low under high (would cycle)
    const g = reduceGraph([inferred, owner], VERIFY_ALL);
    expect(parentOf(g, highKey)).toEqual(lowKey);
    expect(g.setAside).toContainEqual({ eventId: inferred.eventId, reason: 'placement-would-create-cycle' });
  });

  it('a cycling placement falls back to the subject\'s previous placement (defect 3)', () => {
    const p0 = place(tg(10), effort(1));
    const anchor = place(tg(11), tg(10));
    const p1 = place(tg(10), tg(11), 'owner', [p0.eventId]); // would cycle
    const g = reduceGraph([p0, anchor, p1], VERIFY_ALL);
    const ten = parentOf(g, tg(10));
    const eleven = parentOf(g, tg(11));
    // exactly one edge of the would-be cycle survives, and nothing is lost to "unplaced"
    expect([ten, eleven].filter((p) => p !== undefined)).toHaveLength(2);
    expect(nodeKey(ten!) === nodeKey(tg(11)) && nodeKey(eleven!) === nodeKey(tg(10))).toBe(false);
  });

  it('holds an event whose named predecessor is missing (defect 5)', () => {
    const late = place(tg(4), effort(2), 'owner', ['evt-never-seen']);
    const g = reduceGraph([place(tg(4), effort(1)), late], VERIFY_ALL);
    expect(g.setAside).toContainEqual({ eventId: late.eventId, reason: 'missing-replaced-event' });
    expect(g.partial.eventGap).toBe(true);
    expect(parentOf(g, tg(4))).toEqual(effort(1));
  });

  it('quarantines both copies of a duplicate id with different bytes', () => {
    const a = place(tg(6), effort(1), 'owner', [], { eventId: 'dup-event-1' });
    const b = { ...a, parent: effort(2) } as GraphEvent;
    const g = reduceGraph([a, b], VERIFY_ALL);
    expect(g.setAside).toContainEqual({ eventId: 'dup-event-1', reason: 'duplicate-event-id-different-payload' });
    expect(g.parentOf.has(nodeKey(tg(6)))).toBe(false);
  });

  it('the certified front door cannot be moved out of its effort (§3.2 guard)', () => {
    const p = place(tg(7), effort(1));
    const fd = frontDoor(effort(1), tg(7), [p.eventId]);
    const move = place(tg(7), effort(2), 'owner', [p.eventId]);
    const g = reduceGraph([create(effort(1)), p, fd, move], VERIFY_ALL);
    expect(parentOf(g, tg(7))).toEqual(effort(1));
    expect(g.setAside).toContainEqual({ eventId: move.eventId, reason: 'front-door-guard' });
    expect(g.frontDoorOf.get(nodeKey(effort(1)))).toEqual(tg(7));
  });

  it('a front door must be a conversation the effort directly coordinates', () => {
    const elsewhere = place(tg(8), effort(2));
    const fd = frontDoor(effort(1), tg(8), [elsewhere.eventId]);
    const g = reduceGraph([create(effort(1)), elsewhere, fd], VERIFY_ALL);
    expect(g.frontDoorOf.has(nodeKey(effort(1)))).toBe(false);
    expect(g.setAside).toContainEqual({ eventId: fd.eventId, reason: 'front-door-not-coordinated' });
  });
});

describe('second-pass review regressions', () => {
  const W = tg(50);
  it('a forged lower-tier event reusing an owner event id cannot poison it (finding 1)', () => {
    const O = place(W, effort(1));
    const D = place(W, tg(51), 'delegation');
    const forged = { ...place(W, tg(52), 'inference'), eventId: O.eventId } as GraphEvent;
    const g = reduceGraph([O, D, forged], { verify: (e) => e.authority !== 'inference' });
    expect(parentOf(g, W)).toEqual(effort(1));
    expect(g.setAside).not.toContainEqual({ eventId: O.eventId, reason: 'duplicate-event-id-different-payload' });
    expect(g.setAside).toContainEqual({ eventId: O.eventId, reason: 'unverified-authority' }); // the forged copy, reported
  });

  it('an owner correction naming an unverified agent placement is applied, not held (finding 2)', () => {
    const D = place(W, tg(51), 'delegation');
    const O2 = place(W, effort(2), 'owner', [D.eventId]);
    const g = reduceGraph([D, O2], { verify: (e) => e.authority === 'owner' });
    expect(parentOf(g, W)).toEqual(effort(2));
    expect(g.setAside).not.toContainEqual({ eventId: O2.eventId, reason: 'missing-replaced-event' });
  });

  it('a refused front-door move leaves the subject under its effort and the front door intact (finding 3)', () => {
    const a = tg(60);
    const p0 = place(a, effort(1));
    const h1 = place(a, effort(1), 'owner', [p0.eventId]);
    const h2 = place(a, effort(2), 'owner', [p0.eventId]); // owner conflict; last agreed = effort 1
    const fd = frontDoor(effort(1), a, [h1.eventId, h2.eventId]);
    const unlink = place(a, null, 'owner', [h1.eventId, h2.eventId]);
    const g = reduceGraph([create(effort(1)), p0, h1, h2, fd, unlink], VERIFY_ALL);
    expect(parentOf(g, a)).toEqual(effort(1));
    expect(g.frontDoorOf.get(nodeKey(effort(1)))).toEqual(a);
    expect(g.setAside).toContainEqual({ eventId: unlink.eventId, reason: 'front-door-guard' });
    expect(g.setAside.map((x) => x.reason)).not.toContain('front-door-not-coordinated');
  });

  it('a cycle is reported as a conflict with the event that would have closed it (finding 4)', () => {
    const x = place(tg(70), tg(71));
    const y = place(tg(71), tg(70));
    const g = reduceGraph([x, y], VERIFY_ALL);
    const cyc = g.conflicts.filter((c) => c.kind === 'cycle');
    expect(cyc).toHaveLength(1);
    expect(cyc[0].heads).toEqual([y.eventId]); // the newer one is set aside
  });

  it('disagreeing concurrent agent heads resolve to the newest and the loser is reported (finding 5)', () => {
    const d1 = place(tg(80), tg(81), 'delegation');
    const d2 = place(tg(80), tg(82), 'delegation');
    const g = reduceGraph([d1, d2], VERIFY_ALL);
    expect(parentOf(g, tg(80))).toEqual(tg(82));
    expect(g.setAside).toContainEqual({ eventId: d1.eventId, reason: 'concurrent-lower-tier-head' });
    expect(g.conflicts.find((c) => c.kind === 'agent-heads')?.heads).toEqual([d1.eventId, d2.eventId].sort());
  });
});

describe('second-pass re-review regressions', () => {
  it('naming a conversation the owner already moved away does not pull it back (re-review 6)', () => {
    const a = tg(90);
    const o1 = place(a, effort(1));
    const o2 = place(a, effort(2), 'owner', [o1.eventId]);
    const fd = frontDoor(effort(1), a, [o2.eventId]); // chosen after the move, observing it
    const g = reduceGraph([create(effort(1)), o1, o2, fd], VERIFY_ALL);
    expect(parentOf(g, a)).toEqual(effort(2));
    expect(g.setAside).not.toContainEqual({ eventId: o2.eventId, reason: 'front-door-guard' });
    expect(g.setAside).toContainEqual({ eventId: fd.eventId, reason: 'front-door-not-coordinated' });
  });

  it('a cycle found while applying an owner-conflict result is still reported (re-review 4)', () => {
    const x = tg(95);
    const y = tg(96);
    const base = place(x, y);
    const c1 = place(x, effort(1), 'owner', [base.eventId]);
    const c2 = place(x, effort(2), 'owner', [base.eventId]); // conflict; last agreed = y
    const yUnderX = place(y, x); // older-or-equal tier edge that makes "x under y" a cycle
    const g = reduceGraph([yUnderX, base, c1, c2], VERIFY_ALL);
    expect(g.conflicts.some((c) => c.kind === 'cycle')).toBe(true);
  });
});

describe('causal front-door guard', () => {
  it('a backdated or late-replicated placement cannot move a certified front door (re-review 3)', () => {
    const a = tg(110);
    const imp = place(a, effort(1), 'import', [], { at: '2026-11-05T08:00:00.000Z' });
    const fd = { ...frontDoor(effort(1), a, [imp.eventId]), createdAt: '2026-11-05T09:00:00.000Z' } as GraphEvent;
    const late = place(a, tg(111), 'delegation', [imp.eventId], { at: '2026-11-05T08:30:00.000Z' });
    const g = reduceGraph([create(effort(1)), imp, fd, late], VERIFY_ALL);
    expect(parentOf(g, a)).toEqual(effort(1));
    expect(g.setAside).toContainEqual({ eventId: late.eventId, reason: 'front-door-guard' });
    expect(g.frontDoorOf.get(nodeKey(effort(1)))).toEqual(a);
  });
  it('a placement with the same timestamp as the choice is refused too (re-review 4)', () => {
    const a = tg(112);
    const p0 = place(a, effort(1), 'owner', [], { at: '2026-11-05T09:00:00.000Z' });
    const fd = { ...frontDoor(effort(1), a, [p0.eventId]), createdAt: '2026-11-05T09:00:00.000Z' } as GraphEvent;
    const move = place(a, effort(2), 'owner', [p0.eventId], { at: '2026-11-05T09:00:00.000Z' });
    const g = reduceGraph([create(effort(1)), p0, fd, move], VERIFY_ALL);
    expect(parentOf(g, a)).toEqual(effort(1));
  });
  it('choosing a front door must name what it observed; clearing names nothing', () => {
    expect(validateGraphEvent(frontDoor(effort(1), tg(1), []))).toBeNull();
    expect(validateGraphEvent(frontDoor(effort(1), null, ['evt-000001']))).toBeNull();
    expect(validateGraphEvent(frontDoor(effort(1), null, []))).not.toBeNull();
  });
});

describe('certified means guarded', () => {
  it('a front door naming another conversation\'s placement is not certified (re-review 4)', () => {
    const a = tg(120);
    const o1 = place(a, effort(1));
    const other = place(tg(121), effort(1));
    const fd = frontDoor(effort(1), a, [other.eventId]);
    const g = reduceGraph([create(effort(1)), o1, other, fd], VERIFY_ALL);
    expect(g.frontDoorOf.size).toBe(0);
    expect(g.setAside).toContainEqual({ eventId: fd.eventId, reason: 'front-door-observation-invalid' });
  });
  it('a front door whose observed head is unverified here is not certified', () => {
    const a = tg(122);
    const d = place(a, tg(123), 'delegation');
    const o1 = place(a, effort(1), 'owner', [d.eventId]);
    const fd = frontDoor(effort(1), a, [o1.eventId, d.eventId]);
    const g = reduceGraph([create(effort(1)), d, o1, fd], { verify: (e) => e.authority === 'owner' });
    expect(g.frontDoorOf.size).toBe(0);
    expect(parentOf(g, a)).toEqual(effort(1));
  });
});

describe('heads and move eligibility (increment C support)', () => {
  it('exposes every current head, including both sides of an owner conflict', () => {
    const p0 = place(tg(130), effort(1));
    const a = place(tg(130), effort(2), 'owner', [p0.eventId]);
    const b = place(tg(130), effort(3), 'owner', [p0.eventId]);
    const evs = [create(effort(1)), create(effort(2)), create(effort(3)), p0, a, b];
    const g = reduceGraph(evs, VERIFY_ALL);
    expect(g.placementHeads.get(nodeKey(tg(130)))).toEqual([a.eventId, b.eventId].sort());
    const m = moveEligibility(evs, VERIFY_ALL, tg(130), effort(2), AT);
    expect(m).toMatchObject({ eligible: true, resolvesConflict: true });
    expect(m.observedHeads).toEqual([a.eventId, b.eventId].sort());
    const fix = place(tg(130), effort(2), 'owner', m.observedHeads);
    expect(reduceGraph([...evs, fix], VERIFY_ALL).conflicts).toEqual([]);
  });

  it('an owner may correct a wrongly inferred placement even if it only cycles through an agent edge', () => {
    const E1 = effort(1); const E2 = effort(2);
    const agent = place(E2, E1, 'inference'); // inferred: E2 under E1 — wrong
    const evs = [create(E1), create(E2), agent];
    const m = moveEligibility(evs, VERIFY_ALL, E1, E2, AT); // owner: E1 under E2
    expect(m).toMatchObject({ eligible: true });
    const g = reduceGraph([...evs, place(E1, E2, 'owner', m.observedHeads)], VERIFY_ALL);
    expect(parentOf(g, E1)).toEqual(E2);
  });

  it('agrees with the reducer on invalid relations, owner cycles and held front doors', () => {
    const E = effort(1);
    const p = place(tg(140), E);
    const fd = frontDoor(E, tg(140), [p.eventId]);
    const w = place(tg(141), tg(140));
    const w2 = place(tg(142), tg(141));
    const evs = [create(E), create(effort(2)), p, fd, w, w2];
    expect(moveEligibility(evs, VERIFY_ALL, E, tg(140), AT).reason).toBe('relation-invalid');
    expect(moveEligibility(evs, VERIFY_ALL, tg(141), tg(142), AT).reason).toBe('would-create-cycle'); // owner-tier cycle
    expect(moveEligibility(evs, VERIFY_ALL, tg(140), tg(141), AT).reason).toBe('front-door-held');   // the guard is checked first, as in the reducer
    expect(moveEligibility(evs, VERIFY_ALL, tg(140), effort(2), AT)).toMatchObject({ eligible: false, reason: 'front-door-held', frontDoorOf: E });
    expect(moveEligibility(evs, VERIFY_ALL, tg(140), null, AT).reason).toBe('front-door-held');
    expect(moveEligibility(evs, VERIFY_ALL, tg(141), effort(2), AT)).toMatchObject({ eligible: true, observedHeads: [w.eventId] });
    expect(moveEligibility(evs, VERIFY_ALL, tg(150), E, AT)).toMatchObject({ eligible: true, observedHeads: [] });
  });
});

describe('second review round: timestamps, probe identity, provenance after fallbacks', () => {
  it('refuses a timestamp without exactly millisecond precision (string order must equal time order)', () => {
    const e = place(tg(160), effort(1));
    expect(validateGraphEvent({ ...e, createdAt: '2026-11-05T12:00:00Z' })).toBeNull();
    expect(validateGraphEvent({ ...e, createdAt: '2026-11-05T12:00:00.5Z' })).toBeNull();
    expect(validateGraphEvent(e)).not.toBeNull();
  });

  it('the eligibility probe uses the correction\'s own timestamp, so a future-dated event cannot skew it', () => {
    const E1 = effort(1); const E2 = effort(2);
    const future = place(E2, E1, 'owner', [], { at: '2031-01-01T00:00:00.000Z' });
    const evs = [create(E1), create(E2), future];
    const m = moveEligibility(evs, VERIFY_ALL, E1, E2, AT);
    const g = reduceGraph([...evs, { ...place(E1, E2, 'owner', m.observedHeads), createdAt: AT } as GraphEvent], VERIFY_ALL);
    expect(m.eligible).toBe(parentOf(g, E1) !== undefined && nodeKey(parentOf(g, E1)!) === nodeKey(E2));
  });

  it('no real event can carry the probe id or borrow its verification', () => {
    expect(validateGraphEvent({ ...place(tg(161), effort(1)), eventId: 'eligibility.probe' })).toBeNull();
  });

  it('placedBy names the real author after a guard or cycle fallback, never a made-up agreement', () => {
    const E = effort(1);
    const p0 = place(tg(170), E, 'inference');
    const fd = frontDoor(E, tg(170), [p0.eventId]);
    const move = place(tg(170), effort(2), 'owner', [p0.eventId]);
    const g = reduceGraph([create(E), create(effort(2)), p0, fd, move], VERIFY_ALL);
    expect(g.placementSource.get(nodeKey(tg(170)))?.authority).toBe('inference'); // held by the guard where inference put it
    const x = place(tg(171), effort(1), 'inference');
    const y = place(tg(172), tg(171), 'owner');
    const xCycle = place(tg(171), tg(172), 'owner', [x.eventId]); // would cycle; falls back to the inferred parent
    const g2 = reduceGraph([create(E), x, y, xCycle], VERIFY_ALL);
    expect(g2.placementSource.get(nodeKey(tg(171)))?.authority).toBe('inference');
  });
});

describe('GraphProjection (filter first)', () => {
  it('keeps a known unavailable ref without inventing a chat alias and filters it before counts', () => {
    const ref = tg(991);
    const projection = new GraphProjection({ graph: reduceGraph([], VERIFY_ALL), conversations: [],
      unavailableConversations: [ref], effortTitle: () => null, mayView: () => true });
    expect(projection.item(ref)).toMatchObject({ ref, state: 'unavailable', title: 'Unavailable conversation' });
    expect(projection.item(ref)?.source).toBeUndefined();
    expect(projection.list('all', null)).toEqual([ref]);
    const hidden = new GraphProjection({ graph: reduceGraph([], VERIFY_ALL), conversations: [],
      unavailableConversations: [ref], effortTitle: () => null, mayView: () => false });
    expect(hidden.item(ref)).toBeNull();
    expect(hidden.list('all', null)).toEqual([]);
  });
  const E = effort(100);
  const S = effort(200);
  const events = [
    create(E), create(S),
    ...(() => { const p100 = place(tg(100), E); return [p100, frontDoor(E, tg(100), [p100.eventId])]; })(),
    place(tg(101), tg(100), 'delegation'), place(tg(102), tg(100), 'delegation'),
    place(tg(200), S),
  ];
  const graph = reduceGraph(events, VERIFY_ALL);
  const conv = (r: ConversationRef, title: string, at: string | null, id: string | number = (r as { topicId: number }).topicId): ConversationSource => ({ ref: r, conversationId: id, title, lastActivity: at });
  const conversations = [
    conv(tg(100), 'Front door', '2026-11-05T09:00:00.000Z'),
    conv(tg(101), 'Worker visible', '2026-11-05T09:05:00.000Z'),
    conv(tg(102), 'Worker hidden', '2026-11-05T09:06:00.000Z'),
    conv(tg(200), 'Secret worker', '2026-11-05T08:00:00.000Z'),
    conv(tg(300), 'Unassigned chat', '2026-11-05T07:00:00.000Z'),
  ];
  const titles = (e: EffortRef) => (nodeKey(e) === nodeKey(E) ? 'Launch' : nodeKey(e) === nodeKey(S) ? 'Secret plan' : null);
  const make = (mayView: (r: NodeRef) => boolean) => new GraphProjection({ graph, conversations, effortTitle: titles, mayView });
  const not = (...hidden: NodeRef[]) => (r: NodeRef) => !hidden.some((h) => nodeKey(h) === nodeKey(r));

  it('retains a certified visible front-door fact when source content is unavailable without inventing an alias',()=>{
    const p=new GraphProjection({graph,conversations,unavailableConversations:[tg(100)],effortTitle:titles,mayView:()=>true});
    expect(p.item(E)?.metadata).toEqual({frontDoor:tg(100)});
    expect(p.item(tg(100))).toMatchObject({state:'unavailable',role:'front-door'});
    expect(p.item(tg(100))?.source).toBeUndefined();
    const hidden=new GraphProjection({graph,conversations,unavailableConversations:[tg(100)],effortTitle:titles,mayView:not(tg(100))});
    expect(hidden.item(E)?.metadata).toEqual({});
  });

  it('All lists every authorized node, assigned workers included (defect 4)', () => {
    const all = make(() => true).list('all', null).map(nodeKey);
    for (const r of [E, S, tg(100), tg(101), tg(102), tg(200), tg(300)]) expect(all).toContain(nodeKey(r));
  });

  it('Overview lists root efforts only; roles and counts are right for the owner', () => {
    const p = make(() => true);
    expect(p.list('overview', null).map(nodeKey).sort()).toEqual([nodeKey(E), nodeKey(S)].sort());
    expect(p.item(tg(100))?.role).toBe('front-door');
    expect(p.item(tg(101))?.role).toBe('worker');
    expect(p.item(tg(300))?.role).toBe('unassigned');
    expect(p.item(tg(100))?.visibleChildCount).toBe(2);
    expect(p.item(tg(101))?.primaryPath.map((x) => x.title)).toEqual(['Launch', 'Front door']);
  });

  it('metadata.frontDoor appears on the effort only when certified and visible', () => {
    expect(make(() => true).item(E)?.metadata).toEqual({ frontDoor: tg(100) });
    expect(make(not(tg(100))).item(E)?.metadata).toEqual({});
    expect(make(() => true).item(S)?.metadata).toEqual({});
    expect(make(() => true).item(tg(100))?.metadata).toBeUndefined();
    const unverified = new GraphProjection({ graph: reduceGraph(events, { verify: (e) => e.op !== 'set-front-door' }), conversations, effortTitle: titles, mayView: () => true });
    expect(unverified.item(E)?.metadata).toEqual({});
  });

  it('says who placed each node, so an inferred placement is never shown as accepted (§5.1)', () => {
    const p = make(() => true);
    expect(p.item(tg(100))?.placedBy).toBe('owner');
    expect(p.item(tg(101))?.placedBy).toBe('delegation');
    expect(p.item(tg(300))?.placedBy).toBeUndefined(); // a root / unassigned
    const inferred = reduceGraph([...events, place(tg(300), E, 'inference')], VERIFY_ALL);
    const q = new GraphProjection({ graph: inferred, conversations, effortTitle: titles, mayView: () => true });
    expect(q.item(tg(300))?.placedBy).toBe('inference');
  });

  it('a hidden child is not counted, listed, or searchable', () => {
    const p = make(not(tg(102)));
    expect(p.item(tg(100))?.visibleChildCount).toBe(1);
    expect(p.childrenOf(tg(100))).toEqual([tg(101)]);
    expect(p.list('all', 'hidden')).toEqual([]);
    expect(p.item(tg(102))).toBeNull();
  });

  it('an effort whose only children are hidden reveals nothing about them', () => {
    const p = make(not(tg(200)));
    expect(p.item(S)?.visibleChildCount).toBe(0);
    expect(p.childrenOf(S)).toEqual([]);
  });

  it('a hidden parent leaves no trace', () => {
    const p = make(not(S));
    expect(p.item(tg(200))?.primaryPath).toEqual([]);
    expect(p.item(tg(200))?.role).toBe('unassigned');
    expect(JSON.stringify(p.item(tg(200)))).not.toContain('Secret plan');
  });

  it('a forgotten effort header leaves an empty title, never stale text', () => {
    const p = new GraphProjection({ graph, conversations, effortTitle: () => null, mayView: () => true });
    expect(p.item(E)?.title).toBe('');
  });

  it('copies the flat row id and machine exactly into source', () => {
    const slack: ConversationRef = { kind: 'conversation', platform: 'slack', channelId: 'C0123ABCD' };
    const p = new GraphProjection({ graph: reduceGraph([], VERIFY_ALL), conversations: [{ ref: slack, conversationId: -7, machine: 'studio', title: 'Slack thread', lastActivity: null }], effortTitle: () => null, mayView: () => true });
    expect(p.item(slack)?.source).toEqual({ platform: 'slack', conversationId: -7, title: 'Slack thread', machine: 'studio' });
  });

  it('reports partial reasons honestly', () => {
    const unverified = reduceGraph(events, { verify: () => false });
    const p = new GraphProjection({ graph: unverified, conversations, effortTitle: titles, mayView: () => true });
    expect(p.partialReasons().map((r) => r.reason)).toEqual(['replica-lag', 'evidence-missing']);
  });

  it('orders deterministically regardless of inventory order', () => {
    const a = make(() => true).list('all', null);
    const b = new GraphProjection({ graph, conversations: [...conversations].reverse(), effortTitle: titles, mayView: () => true }).list('all', null);
    expect(b).toEqual(a);
  });
});
