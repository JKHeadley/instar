/**
 * My board on the console Work page (docs/specs/work-board-my-board.md; server side in #3447): the read's
 * `myBoard.sections` are drawn first, each card once under its reason with its count, empty sections hidden,
 * "And N more" for a cut, untouched cards tagged "Not started"; the lanes below leave those cards out. An agent
 * that sends no My board (or one this page cannot read) gets the lanes as before.
 */
// @ts-nocheck — the console modules are browser-native ESM (.js), no types.
import path from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { readBoard, readMyBoard, notStartedTag, MY_BOARD_WORDS, NOT_STARTED_WORDS } from '../../dashboard/console/work-model.js';

const CONSOLE = path.resolve(__dirname, '../../dashboard/console');
const H = (c) => c.repeat(64);
const ok = (data) => ({ ok: true, status: 200, data });

function card(id, over = {}) {
  return {
    id, conversationKey: '0b0c0d0e-0f10-5111-8213-141516171819', status: 'needs-approval', lane: 'waiting-on-you',
    turn: 'you', started: false, startedAt: null, closeout: null, needLine: 'Needs your approval', newestAt: '2026-11-18T07:00:00Z',
    title: `Card ${id}`, titleHash: H('a'), need: 'A need.', doneWhen: [], carrier: 'agent', outward: false, materialHash: H('b'),
    approvalRequired: true, approved: false, question: null, questions: [], evidence: [], claim: null, reopens: [], holds: [],
    archives: [], carrierTrail: [], taps: [], pickups: [], ...over,
  };
}
const section = (reason, cardIds, more) => ({ reason, words: MY_BOARD_WORDS[reason], cardIds, notStarted: 0, ...(more ? { more } : {}) });
function boardBody({ waiting = [], agent = [], others = [], myBoard } = {}) {
  return {
    lanes: [{ lane: 'waiting-on-you', cards: waiting }, { lane: 'with-agent', cards: agent }, { lane: 'waiting-on-others', cards: others },
      { lane: 'done', cards: [], total: 0 }, { lane: 'archived', cards: [], total: 0 }],
    waitingOnYou: waiting.length, policy: 'every-agent-card', pickups: null, behind: null, settings: null,
    ...(myBoard ? { myBoard } : {}),
  };
}

describe('reading My board', () => {
  it('draws each section\'s cards from the same read, once each, and leaves empty sections out', () => {
    const a = card('wc_a'); const b = card('wc_b', { status: 'held' }); const c = card('wc_c', { lane: 'with-agent', turn: 'agent' });
    const body = boardBody({ waiting: [a, b], agent: [c], myBoard: { sections: [
      section('approval', ['wc_a', 'wc_missing']), section('reply', []), section('own', ['wc_a']), section('added', [], 2), section('held', ['wc_b']),
    ] } });
    const mine = readMyBoard(body, readBoard(body).lanes);
    expect(mine.sections.map((s) => [s.reason, s.cards.map((x) => x.id), s.more])).toEqual([
      ['approval', ['wc_a'], 0], ['added', [], 2], ['held', ['wc_b'], 0],
    ]);
    expect([...mine.ids].sort()).toEqual(['wc_a', 'wc_b']);
    expect(mine.sections.map((s) => s.lead)).toEqual([true, false, false]);
  });
  it('an older agent, or a My board this page cannot read, means the lanes as before', () => {
    const body = boardBody({ waiting: [card('wc_a')] });
    const lanes = readBoard(body).lanes;
    expect(readMyBoard(body, lanes)).toBeNull();
    expect(readMyBoard({ ...body, myBoard: { sections: 'x' } }, lanes)).toBeNull();
    expect(readMyBoard({ ...body, myBoard: { sections: [{ reason: 'boss', cardIds: [] }] } }, lanes)).toBeNull();
    expect(readMyBoard({ ...body, myBoard: { sections: [{ reason: 'own' }] } }, lanes)).toBeNull();
  });
  it('the agent\'s words, or the known words when it sends none; a bad count is no count', () => {
    const body = boardBody({ waiting: [card('wc_a')], myBoard: { sections: [{ reason: 'own', cardIds: ['wc_a'], more: -3 }, { reason: 'reply', words: 'Your reply', cardIds: [], more: 1.5 }] } });
    const mine = readMyBoard(body, readBoard(body).lanes);
    expect(mine.sections).toHaveLength(1);
    expect(mine.sections[0]).toMatchObject({ words: 'Your cards', more: 0 });
  });
  it('"Not started" only for a card the agent says nobody has touched', () => {
    expect(notStartedTag(card('x'))).toBe(NOT_STARTED_WORDS);
    expect(notStartedTag(card('x', { started: true }))).toBeNull();
    expect(notStartedTag(card('x', { started: undefined }))).toBeNull();
  });
});

// ── the shipped page in jsdom ─────────────────────────────────────────────
function installDom() {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/dashboard/console/#/work/board', pretendToBeVisual: true });
  const w: any = dom.window;
  for (const k of ['document', 'location', 'history', 'HTMLElement', 'Node', 'CSS', 'MutationObserver', 'getSelection', 'requestAnimationFrame', 'cancelAnimationFrame']) if (k in w) (globalThis as any)[k] = w[k];
  (globalThis as any).window = w;
  (globalThis as any).localStorage = w.localStorage;
  (globalThis as any).fetch = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }));
  w.scrollTo = vi.fn();
  w.HTMLElement.prototype.scrollIntoView = vi.fn();
}

async function render(body) {
  const reads = { '/work-board': ok(body), '/work/projects': ok({ projects: [] }) };
  const { renderWork } = await import(path.join(CONSOLE, 'work.js'));
  const main = document.createElement('main'); document.body.replaceChildren(main);
  await renderWork(main, { get: vi.fn(async (p: string) => reads[p] || { ok: false, reason: 'no' }) });
  return main;
}
const headsOf = (main) => [...main.querySelectorAll('.work-lane .list-head')].map((h) => [h.querySelector('h2').textContent, h.querySelector('.list-count').textContent]);

describe('the page', () => {
  beforeEach(() => installDom());

  it('My board first, each card once, then the lanes without the cards already shown', async () => {
    const a = card('wc_a'); const b = card('wc_b', { status: 'waiting-on-person', started: true, turn: 'you' });
    const c = card('wc_c', { lane: 'with-agent', turn: 'agent', started: true }); const d = card('wc_d', { lane: 'waiting-on-others', turn: 'others', status: 'held' });
    const main = await render(boardBody({ waiting: [a, b], agent: [c], others: [d], myBoard: { sections: [
      section('approval', ['wc_a'], 3), section('reply', ['wc_b']), section('own', []), section('added', []), section('held', ['wc_d']),
    ] } }));
    expect(headsOf(main).slice(0, 3)).toEqual([['Waiting for your approval', '4'], ['Waiting for your reply', '1'], ['Held for later', '1']]);
    expect(main.querySelector('#sec-mine-approval').textContent).toContain('And 3 more');
    expect(main.querySelector('#sec-waiting-on-you')).toBeNull(); // every waiting card is on My board
    for (const id of ['wc_a', 'wc_b', 'wc_c', 'wc_d']) expect(main.querySelectorAll(`[data-card="${id}"]`)).toHaveLength(1);
    expect(main.querySelector('#sec-with-agent [data-card="wc_c"]')).toBeTruthy();
    expect(main.querySelector('#sec-waiting-on-others').textContent).toContain('No card is waiting on someone else.');
    // Untouched cards say so; started ones do not.
    expect(main.querySelector('[data-card="wc_a"]').textContent).toContain(NOT_STARTED_WORDS);
    expect(main.querySelector('[data-card="wc_b"]').textContent).not.toContain(NOT_STARTED_WORDS);
    expect(main.querySelector('[data-card="wc_c"]').textContent).not.toContain(NOT_STARTED_WORDS);
    // The asks lead; held cards are shown quieter.
    expect(main.querySelector('#sec-mine-approval [data-card="wc_a"]').classList.contains('muted-card')).toBe(false);
    expect(main.querySelector('#sec-mine-held [data-card="wc_d"]').classList.contains('muted-card')).toBe(true);
  });

  it('a card waiting on the reader that My board left out is still shown', async () => {
    const main = await render(boardBody({ waiting: [card('wc_a'), card('wc_z')], myBoard: { sections: [section('approval', ['wc_a'])] } }));
    expect(main.querySelector('#sec-waiting-on-you [data-card="wc_z"]')).toBeTruthy();
    expect(main.querySelectorAll('[data-card="wc_a"]')).toHaveLength(1);
  });

  it('an older agent gets the lanes as before', async () => {
    const main = await render(boardBody({ waiting: [card('wc_a')] }));
    expect(headsOf(main)[0]).toEqual(['Waiting on you', '1']);
    expect(main.querySelector('.work-mine')).toBeNull();
    expect(main.textContent).not.toContain(NOT_STARTED_WORDS);
  });

  it('nothing needs the reader: the empty Waiting on you lane, as before', async () => {
    const main = await render(boardBody({ agent: [card('wc_c', { lane: 'with-agent', turn: 'agent' })], myBoard: { sections: ['approval', 'reply', 'own', 'added', 'held'].map((r) => section(r, [])) } }));
    expect(main.querySelector('.work-mine')).toBeNull();
    expect(main.querySelector('#sec-waiting-on-you').textContent).toContain('No cards right now.');
    expect(main.querySelector('#sec-with-agent [data-card="wc_c"]')).toBeTruthy();
  });
});

describe('explicit internal-agent board view', () => {
  beforeEach(() => installDom());
  it('offers a deliberate agent view from the ordinary board', async () => {
    const main = await render(boardBody());
    expect(main.querySelector('a[href="#/work/board?view=agent"]').textContent).toBe('View the agent’s internal cards');
  });
  it('keeps agent paging scoped and does not mount an unavailable empty conversation', async () => {
    location.hash = '#/work/board?view=agent&donePage=1&card=wc_0123456789abcdef';
    const internal = card('wc_0123456789abcdef', { agentInternal: true, conversationAvailable: false, lane: 'with-agent', turn: 'agent', status: 'not-started', needLine: 'The agent has not started this under the current board policy.' });
    const body = boardBody({ agent: [internal] });
    body.lanes.find(l => l.lane === 'done').total = 150;
    const get = vi.fn(async p => p.startsWith('/work-board?') ? ok(body) : { ok: false, status: 404 });
    const { renderWork } = await import(path.join(CONSOLE, 'work.js'));
    const main = document.createElement('main'); document.body.replaceChildren(main);
    await renderWork(main, { get });
    expect(get.mock.calls[0][0]).toContain('view=agent');
    expect(get.mock.calls.some(([p]) => p === '/work/projects')).toBe(false);
    expect(main.textContent).toContain('The agent’s internal cards');
    expect([...main.querySelectorAll('.work-lane a.link-btn')].every(a => a.hash.includes('view=agent'))).toBe(true);
    expect(document.querySelector('.sheet')).toBeTruthy();
    expect(document.querySelector('.sheet').textContent).not.toContain('Open conversation');
    expect(fetch.mock.calls.some(([p]) => String(p).includes('/messages'))).toBe(false);
    expect(location.hash).toContain('view=agent');
  });
});
