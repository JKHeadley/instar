/**
 * Console Home coherence invariant (operator report 2026-10-26: the headline said
 * "10 things need you." while the "What needs you" card directly below said
 * "Nothing needs you — 357 routine notices kept in the log.").
 *
 * The whole Home model is rendered over realistic source combinations and the
 * invariant is asserted on every one:
 *   1. the headline's number equals the "What needs you" card's count;
 *   2. no element says nothing / quiet while anything needs the operator;
 *   3. while a counting source is loading or has failed, neither the headline
 *      nor the card claims "nothing".
 * It also pins the operator's card-face rule: housekeeping (routine-notice
 * counts, "kept in the log", "listed separately", coverage notes) lives in the
 * card's Details fold, never on its face or in the headline.
 */
import { describe, it, expect } from 'vitest';
import {
  failure, buildReach, buildNeeds, combineNeeds, buildDoing, buildPromised, buildRunning, buildAllowed, headline,
} from '../../dashboard/console/home-model.js';

const NOW = Date.parse('2026-10-26T18:00:00Z');
const ok = (data: unknown) => ({ ok: true, data });
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
const LOADING = { state: 'loading' };

// ── realistic sources ──
const routine = Array.from({ length: 357 }, (_, n) => ({ id: `r${n}`, title: `Worktree scan ${n}`, status: 'OPEN', priority: 'LOW', category: 'worktree', createdAt: minsAgo(n) }));
const attentionEmpty = ok({ items: routine, pool: { failed: [] } });
const attentionTwo = ok({ items: [...routine,
  { id: 'a1', title: 'Approve the deploy', status: 'OPEN', priority: 'HIGH', source: 'agent', createdAt: minsAgo(4) },
  { id: 'a2', title: 'Rotate the leaked token', status: 'OPEN', priority: 'URGENT', category: 'security', createdAt: minsAgo(40) },
], pool: { failed: [] } });
const attentionPartial = ok({ items: routine, pool: { failed: [{ nickname: 'Laptop' }] } });

const commitment = (n: number, over: Record<string, unknown> = {}) => ({
  id: `CMT-${n}`, status: 'pending', owner: 'user', blockedOn: 'user-input', createdAt: minsAgo(n * 30),
  agentResponse: `Waiting for your answer on question ${n}`, userRequest: `question ${n}`,
  viewSource: n % 2 ? 'replica' : 'own', originMachineId: n % 2 ? 'm2' : undefined, stalenessMs: n % 2 ? 60_000 : undefined, ...over,
});
const promisesTen = ok({ enabled: true, scope: 'mesh', commitments: [
  ...Array.from({ length: 10 }, (_, i) => commitment(i + 1)),
  commitment(20, { owner: 'agent', blockedOn: 'none', agentResponse: 'Report back on the build' }),
  commitment(21, { createdAt: minsAgo(60 * 24 * 30) }),   // stale: listed under See all, not counted
] });
const promisesNone = ok({ enabled: true, scope: 'mesh', commitments: [
  { id: 'CMT-9', status: 'pending', owner: 'agent', blockedOn: 'none', createdAt: minsAgo(60), agentResponse: 'Report back', viewSource: 'replica', originMachineId: 'm2', stalenessMs: 1000 },
] });

const others = () => ({
  reach: buildReach(ok({ telegramOrigin: { heldForward: { count: 0, observedAt: NOW - 1000, expiredUnreported: 0 } } }), NOW),
  doing: buildDoing(ok({ sessions: [{ name: 'Fix it', status: 'running', startedAt: minsAgo(20), machineNickname: 'Mac Studio' }], pool: { failed: [] } }), NOW),
  running: buildRunning(ok({ machines: [{ machineId: 'm1', nickname: 'Mac Studio', online: true, routerReceivedAt: minsAgo(0.5), loadAvg: 1, hardware: { cpuCores: 16 } }, { machineId: 'm2', nickname: 'Mac Mini', online: true, routerReceivedAt: minsAgo(0.5), loadAvg: 1, hardware: { cpuCores: 8 } }] }), NOW),
  allowed: buildAllowed(ok({ summary: { onConfirmed: 9, onUnverified: 0, onStale: 0, onBlind: 0, onDryRun: 2, offDeviant: 0, offDarkDefault: 3, offRuntimeDivergent: 0, errored: 0, missing: 0 }, guards: [] }), ok({ mandates: [] }), NOW),
});

type Card = { state: string; value?: string; line?: string; count?: number; pending?: boolean; details?: string[] };
function home(attnRes: unknown, promRes: unknown) {
  const attn = attnRes === 'loading' ? LOADING : buildNeeds(attnRes as never, NOW);
  const promised = promRes === 'loading' ? LOADING : buildPromised(promRes as never, NOW, 1);
  const cards: Record<string, Card> = { needs: combineNeeds(attn, promised), promised, ...others() };
  return { cards, h: headline(cards) };
}

const NOTHING = /\bnothing\b|\bquiet\b|\bidle\b/i;
const HOUSEKEEPING = /routine notice|kept in the log|listed separately|untouched for|only this machine|coverage/i;

function assertInvariant({ cards, h }: ReturnType<typeof home>) {
  const needs = cards.needs;
  const m = /^(\d+|One) things? needs? you\.$/.exec(h.text);
  if (needs.state === 'loading' || needs.pending) {
    expect(h.text).toBe('Checking in…');
  } else if (m) {
    expect(m[1] === 'One' ? 1 : Number(m[1])).toBe(needs.count);
  } else {
    expect(needs.count).toBe(0);
  }
  const needsSomething = (needs.count ?? 0) > 0;
  const faces = [h.text, h.sub || '', needs.value || '', needs.line || '', cards.promised.value || '', cards.promised.line || ''];
  if (needsSomething) for (const f of faces) expect(f, f).not.toMatch(NOTHING);
  // The face never carries housekeeping; the headline sub-line never does either.
  for (const c of Object.values(cards)) {
    expect(c.line || '', c.line).not.toMatch(HOUSEKEEPING);
    expect(c.value || '', c.value).not.toMatch(HOUSEKEEPING);
  }
  expect(h.sub || '').not.toMatch(HOUSEKEEPING);
}

describe('Home coherence: headline count === What needs you count', () => {
  it('attention empty (357 routine notices) + 10 promises waiting: the reported case', () => {
    const r = home(attentionEmpty, promisesTen);
    assertInvariant(r);
    expect(r.cards.needs.count).toBe(10);
    expect(r.h.text).toBe('10 things need you.');
    expect(r.cards.needs.value).toBe('10 things');
    expect(r.cards.promised.line).toBe('10 of them are waiting on you, listed under What needs you.');
    // Routine notices and the stale promise are one tap deeper.
    expect(r.cards.needs.details!.join(' ')).toContain('357 routine notices kept in the log');
    expect(r.cards.needs.details!.join(' ')).toContain('older promise');
  });

  it('the promise rows are plain, newest first, stale ones only under See all', () => {
    const { cards } = home(attentionEmpty, promisesTen);
    const n = cards.needs as unknown as { rows: { main: string; sub: string }[]; all: { main: string; sub: string; stale?: boolean }[] };
    expect(n.rows[0].main).toBe('Waiting for your answer on question 1');
    expect(n.rows[0].sub.startsWith('A decision I’m waiting on you for')).toBe(true);
    expect(n.all).toHaveLength(11);
    expect(n.all[10].stale).toBe(true);
  });

  it('attention items + no promises waiting', () => {
    const r = home(attentionTwo, promisesNone);
    assertInvariant(r);
    expect(r.h.text).toBe('2 things need you.');
  });

  it('both sources contribute to one count', () => {
    const r = home(attentionTwo, promisesTen);
    assertInvariant(r);
    expect(r.cards.needs.count).toBe(12);
    expect(r.h.text).toBe('12 things need you.');
  });

  it('nothing anywhere: a calm card with no housekeeping on its face', () => {
    const r = home(attentionEmpty, promisesNone);
    assertInvariant(r);
    expect(r.cards.needs.value).toBe('Nothing needs you');
    expect(r.cards.needs.line).toBe('');
    expect(r.h.text).toBe('All quiet.');
  });

  it('promises failed, attention empty: never "nothing needs you"', () => {
    const r = home(attentionEmpty, failure('the server answered 500'));
    assertInvariant(r);
    expect(r.cards.needs.value).not.toMatch(/Nothing needs you/);
    expect(r.h.text).not.toBe('All quiet.');
  });

  it('attention failed, promises waiting: the known promises still count, marked partial', () => {
    const r = home(failure('timeout'), promisesTen);
    assertInvariant(r);
    expect(r.cards.needs.count).toBe(10);
    expect(r.cards.needs.state).toBe('partial');
    expect(r.h.sub).toContain('There may be more');
  });

  it('both failed: "Can\'t tell", never "nothing"', () => {
    const r = home(failure('x'), failure('y'));
    assertInvariant(r);
    expect(r.cards.needs.value).toBe("Can't tell");
  });

  it('a source still loading: neither headline nor card claims anything', () => {
    for (const [a, p] of [['loading', promisesTen], [attentionEmpty, 'loading'], [attentionTwo, 'loading'], ['loading', 'loading']] as const) {
      const r = home(a, p);
      assertInvariant(r);
      expect(r.h.text).toBe('Checking in…');
      expect(r.cards.needs.value || '').not.toMatch(NOTHING);
    }
  });

  it('a peer that did not answer the attention read: nothing is not claimed', () => {
    const r = home(attentionPartial, promisesNone);
    assertInvariant(r);
    expect(r.cards.needs.value).toBe('Nothing I can see');
    expect(r.h.text).not.toBe('All quiet.');
  });
});
