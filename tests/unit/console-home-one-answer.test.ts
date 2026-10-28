/**
 * Console Home: one answer to "what needs you", in words the operator can read.
 *
 * Operator report (topic 127504, 2026-10-27): the headline said "One thing
 * needs you." while the "What needs you" card underneath said "Nothing needs
 * you" — the headline counted promises waiting on the operator, the card only
 * counted the attention queue. And the card printed "No answer from
 * m_a804869356b259820b3236e7c5a2ae7d. 420 routine notices kept in the log."
 *
 * Two rules under test:
 *  1. The card and the headline count the same things, so they cannot disagree.
 *  2. No Home builder ever puts an internal id, a placeholder value, or a
 *     known internal phrase in front of the operator — checked over every
 *     builder and a spread of inputs, not one hand-picked string.
 */
import { describe, it, expect } from 'vitest';
import {
  failure, buildReach, buildNeeds, buildDoing, buildPromised, buildRunning, buildAllowed,
  headline, combineNeeds, machineNames, machineLabel, unreachedLine,
} from '../../dashboard/console/home-model.js';

const NOW = Date.parse('2026-10-27T17:00:00Z');
const ok = (data: unknown) => ({ ok: true, data });
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
const RAW_ID = 'm_a804869356b259820b3236e7c5a2ae7d';

const item = (over: Record<string, unknown> = {}) => ({ id: Math.random().toString(36), title: 'Approve the deploy', status: 'OPEN', priority: 'URGENT', createdAt: minsAgo(5), ...over });
const promise = (over: Record<string, unknown> = {}) => ({ id: Math.random().toString(36), status: 'pending', createdAt: minsAgo(30), agentResponse: 'Merge each PR as soon as you approve it.', ...over });

describe('one answer to "what needs you"', () => {
  it('the reported case: a promise waits on the operator and the queue is empty — card and headline agree', () => {
    const needs = buildNeeds(ok({ items: [item({ priority: 'LOW', category: 'telegram-origin' })], pool: { failed: [] } }), NOW);
    const promised = buildPromised(ok({ enabled: true, scope: 'mesh', commitments: [promise({ blockedOn: 'user-authorization', viewSource: 'replica', originMachineId: 'm2', stalenessMs: 1000 })] }), NOW, 1);
    expect(needs.value).toBe('Nothing needs you'); // the old card alone
    const card = combineNeeds(needs, promised);
    const h = headline({ needs: card, promised, reach: { state: 'ok' } });
    expect(h.text).toBe('One thing needs you.');
    expect(card.value).toBe('1 thing');
    expect(card.count).toBe(1);
    expect(card.rows[0].main).toContain('Merge each PR');
    expect(card.rows[0].sub).toMatch(/^a promise · waiting on your authorization/);
    expect(card.line).toContain('Includes 1 promise waiting on you');
  });
  it('queue items and waiting promises are counted once, never twice', () => {
    const needs = buildNeeds(ok({ items: [item(), item({ title: 'Rotate the key', category: 'security', source: 'agent' })], pool: { failed: [] } }), NOW);
    const promised = buildPromised(ok({ enabled: true, scope: 'mesh', commitments: [promise({ blockedOn: 'user-input', viewSource: 'replica', originMachineId: 'm2', stalenessMs: 1000 })] }), NOW, 1);
    const card = combineNeeds(needs, promised);
    expect(card.count).toBe(3);
    expect(headline({ needs: card, promised }).text).toBe('3 things need you.');
  });
  it('nothing anywhere: both say so', () => {
    const needs = buildNeeds(ok({ items: [], pool: { failed: [] } }), NOW);
    const promised = buildPromised(ok({ enabled: true, scope: 'mesh', commitments: [promise({ viewSource: 'replica', originMachineId: 'm2', stalenessMs: 1000 })] }), NOW, 1);
    const card = combineNeeds(needs, promised);
    expect(card.value).toBe('Nothing needs you');
    expect(headline({ needs: card, promised, reach: { state: 'ok' }, doing: { state: 'ok' } }).text).toBe('All quiet.');
  });
  it('promises that could not be read never let the card claim "Nothing needs you"', () => {
    const needs = buildNeeds(ok({ items: [], pool: { failed: [] } }), NOW);
    const card = combineNeeds(needs, buildPromised(failure('no answer within 5 seconds'), NOW));
    expect(card.value).not.toBe('Nothing needs you');
    expect(card.state).toBe('partial');
    expect(card.line).toContain("Couldn't check for promises waiting on you");
  });
  it('while promises are still loading the queue renders on its own, and the headline waits', () => {
    const needs = buildNeeds(ok({ items: [item()], pool: { failed: [] } }), NOW);
    expect(combineNeeds(needs, { state: 'loading' })).toBe(needs);
    expect(headline({ needs, promised: { state: 'loading' } }).text).toBe('Checking in…');
  });
  it("a queue that couldn't be read stays \"can't tell\" after combining", () => {
    const needs = buildNeeds(failure('the server answered 500'), NOW);
    expect(combineNeeds(needs, buildPromised(ok({ enabled: true, commitments: [] }), NOW)).state).toBe('unknown');
  });
});

describe('machines are named, never shown by id', () => {
  it('names come from the pool; an unnamed machine is described, not identified', () => {
    const names = machineNames(ok({ machines: [{ machineId: 'm1', nickname: 'Mac Mini' }, { machineId: RAW_ID }] }));
    expect(machineLabel({ machineId: 'm1' }, names)).toBe('Mac Mini');
    expect(machineLabel({ machineId: RAW_ID }, names)).toBe('a machine with no name on file');
    expect(unreachedLine([{ machineId: RAW_ID }], names, 'items')).toBe("Couldn't reach a machine with no name on file, so its items may be missing.");
    expect(unreachedLine([{ machineId: 'm1' }, { machineId: 'm3', nickname: 'Laptop' }], names, 'sessions')).toBe("Couldn't reach Mac Mini and Laptop, so their sessions may be missing.");
  });
  it('the reported line is gone', () => {
    const items = [...Array.from({ length: 420 }, () => item({ priority: 'LOW', category: 'telegram-origin' }))];
    const m = buildNeeds(ok({ items, pool: { failed: [{ machineId: RAW_ID, error: 'offline' }] } }), NOW, {});
    expect(m.line).toBe("Couldn't reach a machine with no name on file, so its items may be missing.");
  });
});

// ── The structural guard: every Home builder, many inputs, no internal text ──
const FORBIDDEN: Array<[RegExp, string]> = [
  [/\bm_[0-9a-f]{6,}/i, 'a raw machine id'],
  [/\b[0-9a-f]{24,}\b/i, 'a raw hex id'],
  [/\b(undefined|null|NaN|\[object Object\])\b/, 'a placeholder value'],
  [/routine notice|kept in the log|I'm carrying|No answer from/i, 'an internal phrase'],
  [/\b\d+ need you\b/, 'a count with no noun ("1 need you")'],
  [/\b(stalenessMs|viewSource|originMachineId|blockedOn|machineId|leaseHolder|telegram-origin)\b/, 'an internal field name'],
];

function strings(v: unknown, out: string[] = [], key = ''): string[] {
  // Collect only what the page renders: text fields, not ids or row keys.
  if (typeof v === 'string') { if (!['key', 'state', 'tone', 'valueTone', 'href', 'coverage'].includes(key)) out.push(v); }
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out, key));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (k !== 'machines' && k !== 'detail') strings(x, out, k);
  return out;
}

const darkPeer = { failed: [{ machineId: RAW_ID, error: 'offline' }] };
const healthyPeer = { failed: [] };
const pool = ok({ selfMachineId: 'm1', machines: [
  { machineId: 'm1', nickname: 'Mama PC', online: true, routerReceivedAt: minsAgo(0.5) },
  { machineId: RAW_ID, online: false, selfReportedLastSeen: minsAgo(60) },
] });

const CASES: Array<[string, () => unknown]> = [
  ['reach failure', () => buildReach(failure('no answer within 5 seconds'), NOW)],
  ['reach held', () => buildReach(ok({ telegramOrigin: { heldForward: { count: 3, oldestSince: minsAgo(40), observedAt: NOW - 1000, expiredUnreported: 2 } } }), NOW)],
  ['needs dark peer', () => buildNeeds(ok({ items: [item(), item({ priority: 'LOW' })], pool: darkPeer }), NOW, machineNames(pool))],
  ['needs empty dark peer', () => buildNeeds(ok({ items: [], pool: darkPeer }), NOW, {})],
  ['needs stale', () => buildNeeds(ok({ items: [item({ createdAt: minsAgo(60 * 24 * 30) })], pool: healthyPeer }), NOW)],
  ['doing dark peer', () => buildDoing(ok({ sessions: [{ name: 'Fix it', status: 'running', startedAt: minsAgo(9), machineNickname: 'Mama PC' }], pool: darkPeer }), NOW, {})],
  ['doing idle dark peer', () => buildDoing(ok({ sessions: [], pool: darkPeer }), NOW, {})],
  ['promised full', () => buildPromised(ok({ enabled: true, scope: 'mesh', commitments: [
    promise({ blockedOn: 'user-authorization', viewSource: 'replica', originMachineId: RAW_ID, stalenessMs: 1000 }),
    promise({ status: 'violated' }), promise({}), promise({ createdAt: minsAgo(60 * 24 * 30) }),
  ] }), NOW, 2)],
  ['promised no age', () => buildPromised(ok({ enabled: true, scope: 'mesh', commitments: [promise({ viewSource: 'replica', originMachineId: RAW_ID, stalenessMs: null })] }), NOW, 1)],
  ['running', () => buildRunning(pool, NOW)],
  ['allowed failure', () => buildAllowed(failure('x'), ok({ mandates: [] }), NOW)],
  ['combined', () => combineNeeds(
    buildNeeds(ok({ items: [item()], pool: darkPeer }), NOW, {}),
    buildPromised(ok({ enabled: true, scope: 'mesh', commitments: [promise({ blockedOn: 'user-input', viewSource: 'replica', originMachineId: RAW_ID, stalenessMs: 1000 })] }), NOW, 1))],
];

describe('no Home builder shows internal text', () => {
  for (const [name, build] of CASES) {
    it(name, () => {
      const model = build() as Record<string, unknown>;
      const shown = strings(model);
      expect(shown.length).toBeGreaterThan(0);
      for (const s of shown) for (const [re, what] of FORBIDDEN) {
        expect(re.test(s), `${name}: ${what} in "${s}"`).toBe(false);
      }
      const h = headline({ x: model } as never);
      for (const s of strings(h)) for (const [re, what] of FORBIDDEN) expect(re.test(s), `${name} headline: ${what} in "${s}"`).toBe(false);
    });
  }
  it('the guard itself catches the reported line (positive control)', () => {
    const reported = `No answer from ${RAW_ID}. 420 routine notices kept in the log.`;
    expect(FORBIDDEN.some(([re]) => re.test(reported))).toBe(true);
    expect(FORBIDDEN.some(([re]) => re.test('1 need you'))).toBe(true);
  });
});

describe('a calm front page', () => {
  it('all machines healthy collapses to one line; a struggling one is listed', () => {
    const m = (n: string, over = {}) => ({ machineId: n, nickname: n, online: true, routerReceivedAt: minsAgo(0.5), ...over });
    const calm = buildRunning(ok({ machines: [m('A'), m('B'), m('C')] }), NOW);
    expect(calm.line).toBe('Every machine is answering.');
    expect(calm.machines).toHaveLength(0);
    const one = buildRunning(ok({ machines: [m('A'), m('B', { routerReceivedAt: minsAgo(60) })] }), NOW);
    expect(one.machines).toHaveLength(2);
  });
  it('a miss untouched for 14+ days is history, not a red row', () => {
    const p = buildPromised(ok({ enabled: true, scope: 'mesh', commitments: [
      promise({ status: 'violated', createdAt: minsAgo(60 * 24 * 70) }),
      promise({ status: 'violated', createdAt: minsAgo(60) }),
    ] }), NOW, 0);
    expect(p.line).toBe('1 recently missed its deadline.');
    expect(p.rows.filter((r: { tone: string }) => r.tone === 'bad')).toHaveLength(1);
  });
  it('a promise waiting on the operator is listed once, in What needs you', () => {
    const p = buildPromised(ok({ enabled: true, scope: 'mesh', commitments: [promise({ blockedOn: 'user-input' }), promise({ status: 'violated', createdAt: minsAgo(60) })] }), NOW, 0);
    expect(p.rows.some((r: { tone: string }) => r.tone === 'attn')).toBe(false);
    const card = combineNeeds(buildNeeds(ok({ items: [], pool: { failed: [] } }), NOW), p);
    expect(card.rows.filter((r: { tone: string }) => r.tone === 'attn')).toHaveLength(1);
  });
  it('the headline names what it cannot fully see', () => {
    expect(headline({ needs: { state: 'ok', count: 0 }, promised: { state: 'partial', count: 0 } }).sub).toBe("Can't fully see promises.");
  });
});
