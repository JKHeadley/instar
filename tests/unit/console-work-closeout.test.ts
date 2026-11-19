/**
 * Closing a work card from the console (docs/specs/work-front-doors.md §6, decision 3; server side PR #3394):
 * Done with a closeout note, Not important with a reason, Reopen naming the close itself, the close shown on
 * the card, and whose turn it is as the card's colour. A card from an older server (no `turn`) keeps the plain
 * Archive, because that server would drop the note. The second half drives the shipped page in jsdom.
 */
// @ts-nocheck — the modules are browser-native ESM (.js), no types.
import path from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { cardActions, tapBody, tapCovers, refusalWords, pinExplain, closeoutLine, turnOf, CLOSE_NOTE_MAX } from '../../dashboard/console/work-model.js';

const CONSOLE = path.resolve(__dirname, '../../dashboard/console');
const H = (c) => c.repeat(64);
const ok = (data) => ({ ok: true, status: 200, data });

function card(over = {}) {
  return {
    id: 'wc_0123456789abcdef', conversationKey: '0b0c0d0e-0f10-5111-8213-141516171819', status: 'with-agent', lane: 'with-agent',
    turn: 'agent', started: true, startedAt: '2026-11-17T10:00:00Z', closeout: null,
    needLine: 'With the agent', newestAt: '2026-11-17T10:00:00Z', title: 'Pick a venue', titleHash: H('a'),
    need: 'Choose where the meetup happens.', recommendation: null, doneWhen: [], carrier: 'agent', outward: false,
    waitingOn: null, due: null, materialHash: H('b'), approvalRequired: false, approved: true, approvedBy: null, withdrawn: false,
    question: null, questions: [], evidence: [], claim: null, done: false, doneByAgentOwnEvidence: false, reopens: [], holds: [],
    archives: [], carrierTrail: [], taps: [], unreadable: null, workable: true, mayHaveBeenHandedOver: false, pickups: [],
    capacity: null, retryOf: null, lineIds: [], repliedAfterQuestion: false, ...over,
  };
}
const acts = (c, o) => cardActions(c, o).map((a) => a.action);
const labels = (c, o) => cardActions(c, o).map((a) => a.label);
const CLOSED_DONE = { as: 'done', note: 'Booked the Hall', by: { kind: 'person', personKey: 'justin', name: 'Justin', proof: 'console PIN' }, at: '2026-11-17T12:00:00Z', tapId: 'rt_close1' };

describe('which close buttons a card offers', () => {
  it('a card from a server that can close offers Done and Not important instead of Archive', () => {
    expect(acts(card())).toEqual(['withdraw-approval', 'close-done', 'close-not-important']);
    expect(labels(card())).toEqual(['Withdraw approval', 'Done', 'Not important']);
  });
  it('a card still waiting for approval can only be dismissed as Not important, not closed as Done', () => {
    expect(acts(card({ status: 'needs-approval', lane: 'waiting-on-you', turn: 'you', approved: false }))).toEqual(['approve', 'close-not-important']);
  });
  it('a card from an older server (no turn) keeps the plain Archive, which that server can record', () => {
    expect(acts(card({ turn: undefined }))).toEqual(['withdraw-approval', 'archive']);
  });
  it('a card closed as Done offers one Reopen that names the close, not the claim\'s reopen', () => {
    const c = card({ status: 'archived', lane: 'done', turn: 'nobody', closeout: CLOSED_DONE, archives: ['rt_close1'], claim: { id: 'rc1', at: 'x' } });
    expect(acts(c)).toEqual(['unarchive']);
    expect(labels(c)).toEqual(['Reopen']);
    expect(tapBody(c, 'unarchive')).toEqual({ ok: true, body: { action: 'unarchive', titleHash: H('a'), names: 'rt_close1' } });
  });
  it('a card closed as Not important (archived) also reopens by the close', () => {
    const c = card({ status: 'archived', lane: 'archived', turn: 'nobody', closeout: { ...CLOSED_DONE, as: 'not-important', note: 'We never use that venue', tapId: 'rt_close2' }, archives: ['rt_close2'] });
    expect(labels(c, { inSheet: true })).toEqual(['Reopen', 'Remove for good']);
    expect(tapBody(c, 'unarchive').body.names).toBe('rt_close2');
  });
  it('a closed card whose status reads unknown (an unreadable record) offers Reopen, never Answer or Put on hold', () => {
    const c = card({ status: 'unknown', lane: 'done', turn: 'nobody', closeout: CLOSED_DONE, archives: ['rt_close1'], question: { id: 'rq1', text: 'Which?' } });
    expect(acts(c, { inSheet: true })).toEqual(['unarchive', 'redact']);
  });
  it('a card closed after an older archive: Reopen names the close and says the card stays archived', () => {
    const c = card({ status: 'archived', lane: 'done', turn: 'nobody', closeout: CLOSED_DONE, archives: ['ra_old', 'rt_close1'] });
    expect(tapBody(c, 'unarchive').body.names).toBe('rt_close1');
    expect(tapCovers(c, 'unarchive').find((l) => l.label === 'Reopening').text).toMatch(/stays archived until you restore it too/);
    expect(tapCovers(card({ status: 'archived', closeout: CLOSED_DONE, archives: ['rt_close1'] }), 'unarchive').find((l) => l.label === 'Reopening').text).toMatch(/^The card comes back to the board\./);
  });
  it('a closed card from an older server (closeout but no turn) still reopens', () => {
    expect(labels(card({ status: 'archived', lane: 'archived', turn: undefined, closeout: CLOSED_DONE, archives: ['rt_close1'] }))).toEqual(['Reopen']);
  });
  it('a plain archived card still says Restore', () => {
    expect(labels(card({ status: 'archived', lane: 'archived', archives: ['ra1'] }))).toEqual(['Restore']);
  });
});

describe('the close tap body', () => {
  it('Done sends an archive with closeAs and the trimmed note, bound to the title', () => {
    expect(tapBody(card(), 'close-done', { note: '  Booked the Hall ' })).toEqual({ ok: true, body: { action: 'archive', titleHash: H('a'), closeAs: 'done', note: 'Booked the Hall' } });
    expect(tapBody(card(), 'close-not-important', { note: 'Never used' }).body).toMatchObject({ action: 'archive', closeAs: 'not-important', note: 'Never used' });
  });
  it('an empty or blank note is refused here with the server\'s own words', () => {
    expect(tapBody(card(), 'close-done', { note: '   ' })).toEqual({ ok: false, reason: 'Say in a line what was done before closing this card.' });
    expect(tapBody(card(), 'close-not-important', {}).reason).toMatch(/^Say why this is not important\. The agent reads these reasons/);
  });
  it('a note over the server limit is refused before the PIN', () => {
    expect(tapBody(card(), 'close-done', { note: 'x'.repeat(CLOSE_NOTE_MAX + 1) }).ok).toBe(false);
    expect(tapBody(card(), 'close-done', { note: 'x'.repeat(CLOSE_NOTE_MAX) }).ok).toBe(true);
  });
  it('the confirm step shows the note and what the close does', () => {
    const lines = tapCovers(card(), 'close-not-important', { note: 'Never used' });
    expect(lines).toEqual(expect.arrayContaining([{ label: 'Your reason', text: 'Never used' }, expect.objectContaining({ label: 'Closing as not important', text: expect.stringContaining('The agent reads your reason') })]));
    expect(pinExplain(card(), 'close-done')).toMatch(/^Close as done: “Pick a venue”/);
  });
  it('the server\'s refusals read as words', () => {
    expect(refusalWords(400, { error: 'note-required' })).toBe('Say in a line what was done before closing this card.');
    expect(refusalWords(400, { error: 'reason-required' })).toMatch(/^Say why this is not important/);
    expect(refusalWords(422, { error: 'credential-refused', message: 'The note looks like it contains a credential (api-key). Reword it.' })).toMatch(/looks like it contains a credential/);
  });
});

describe('the close and the turn, in words', () => {
  it('names who closed it, when and the note', () => {
    expect(closeoutLine(card({ closeout: CLOSED_DONE }))).toMatch(/^Closed as done by Justin, proved by the console PIN, .+: Booked the Hall$/);
    expect(closeoutLine(card())).toBeNull();
  });
  it('reads only the four turns the server names', () => {
    expect(['you', 'agent', 'others', 'nobody'].map((t) => turnOf(card({ turn: t })))).toEqual(['you', 'agent', 'others', 'nobody']);
    expect(turnOf(card({ turn: 'someone' }))).toBeNull();
    expect(turnOf(card({ turn: undefined }))).toBeNull();
  });
});

// ── the shipped page in jsdom ──────────────────────────────────────────────
let posts: { url: string; body: any }[] = [];
let postAnswer: any = { status: 200, data: { recordId: 'rt1' } };
function installDom() {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/dashboard/console/#/work/board', pretendToBeVisual: true });
  const w: any = dom.window;
  for (const k of ['document', 'location', 'history', 'HTMLElement', 'Node', 'CSS', 'MutationObserver', 'getSelection', 'requestAnimationFrame', 'cancelAnimationFrame']) if (k in w) (globalThis as any)[k] = w[k];
  (globalThis as any).window = w;
  (globalThis as any).localStorage = w.localStorage;
  (globalThis as any).fetch = vi.fn(async (url: string, opts: any = {}) => {
    const u = String(url).replace('http://localhost', '');
    if (opts.method === 'POST') { posts.push({ url: u, body: JSON.parse(opts.body) }); return { ok: postAnswer.status === 200, status: postAnswer.status, json: async () => postAnswer.data }; }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  w.scrollTo = vi.fn();
  w.HTMLElement.prototype.scrollIntoView = vi.fn();
}
const mainNode = () => { const m = document.createElement('main'); m.id = 'main'; document.body.replaceChildren(m); return m; };
const tick = () => new Promise((r) => setTimeout(r, 0));
function boardOf({ waiting = [], withAgent = [], done = [], archived = [] } = {}) {
  return {
    lanes: [
      { lane: 'waiting-on-you', cards: waiting }, { lane: 'with-agent', cards: withAgent }, { lane: 'waiting-on-others', cards: [] },
      { lane: 'done', cards: done, total: done.length }, { lane: 'archived', cards: archived },
    ],
    waitingOnYou: waiting.length, policy: 'every-agent-card', pickups: null, behind: null, settings: null,
  };
}
async function render(b) {
  const reads = { '/work-board': ok(b), '/work/projects': ok({ projects: [] }) };
  const { renderWork } = await import(path.join(CONSOLE, 'work.js'));
  const main = mainNode();
  await renderWork(main, { get: vi.fn(async (p: string) => (p in reads ? reads[p] : { ok: false, reason: 'the server answered 500' })) });
  return main;
}
const button = (root, text) => [...root.querySelectorAll('button')].find((b) => b.textContent === text);
async function enterPin() {
  for (let i = 0; i < 5; i++) await tick();
  const pin = document.querySelector('.pin-input') as any;
  expect(pin).toBeTruthy();
  pin.value = '123456';
  document.querySelector('.pin-form').dispatchEvent(new (window as any).Event('submit', { cancelable: true }));
  for (let i = 0; i < 5; i++) await tick();
}

describe('the page', () => {
  beforeEach(() => { installDom(); posts = []; postAnswer = { status: 200, data: { recordId: 'rt1' } }; });

  it('colours each card by whose turn it is', async () => {
    const main = await render(boardOf({ waiting: [card({ id: 'wc_a', status: 'needs-approval', lane: 'waiting-on-you', turn: 'you', title: 'Approve the venue' })], withAgent: [card({ id: 'wc_b' })] }));
    expect(main.querySelector('[data-card="wc_a"]').classList.contains('turn-you')).toBe(true);
    expect(main.querySelector('[data-card="wc_b"]').getAttribute('data-turn')).toBe('agent');
  });

  it('Done asks for the note first, refuses an empty one, then shows it, asks the PIN and sends the close', async () => {
    const main = await render(boardOf({ withAgent: [card()] }));
    button(main, 'Done').click();
    const step = document.querySelector('.sheet');
    expect(step.textContent).toContain('What was done');
    button(step, 'Continue').click();
    expect(step.textContent).toContain('Say in a line what was done before closing this card.');
    expect(posts).toHaveLength(0);
    (step.querySelector('textarea') as any).value = 'Booked the Hall';
    button(step, 'Continue').click();
    const covers = document.querySelector('.sheet');
    expect(covers.textContent).toContain('Booked the Hall');
    expect(covers.textContent).toContain('The card moves to Done with your note');
    button(covers, 'Continue').click();
    await enterPin();
    expect(posts).toEqual([{ url: '/work-board/cards/wc_0123456789abcdef/tap', body: { action: 'archive', titleHash: H('a'), closeAs: 'done', note: 'Booked the Hall', pin: '123456' } }]);
  });

  it('a server refusal of the close is said in words on the card', async () => {
    postAnswer = { status: 400, data: { error: 'reason-required' } };
    const main = await render(boardOf({ withAgent: [card()] }));
    // A tile carries one main button (Done); Not important is on the opened card, and its refusal is said there.
    expect(button(main, 'Not important')).toBeUndefined();
    button(main, 'Pick a venue').click();
    const opened = document.querySelector('.sheet');
    button(opened, 'Not important').click();
    (document.querySelector('.sheet textarea') as any).value = 'x';
    button(document.querySelector('.sheet'), 'Continue').click();
    button(document.querySelector('.sheet'), 'Continue').click();
    await enterPin();
    expect(opened.textContent).toContain('Say why this is not important.');
  });

  it('a close refused from the opened card comes back to the note step with the note kept and the reason shown', async () => {
    postAnswer = { status: 422, data: { error: 'credential-refused', message: 'The note looks like it contains a credential (api-key). Reword it, or send the secret through Secret Drop.' } };
    const main = await render(boardOf({ withAgent: [card()] }));
    button(main, 'Pick a venue').click();
    button(document.querySelector('.sheet'), 'Done').click();
    (document.querySelector('.sheet textarea') as any).value = 'key sk-test-123';
    button(document.querySelector('.sheet'), 'Continue').click();
    button(document.querySelector('.sheet'), 'Continue').click();
    await enterPin();
    const back = document.querySelector('.sheet');
    expect(back.textContent).toContain('What was done');
    expect(back.textContent).toContain('The note looks like it contains a credential');
    expect((back.querySelector('textarea') as any).value).toBe('key sk-test-123');
  });

  it('a closed card shows its close and reopens by naming it', async () => {
    const closed = card({ status: 'archived', lane: 'done', turn: 'nobody', closeout: CLOSED_DONE, archives: ['rt_close1'], needLine: 'Done: Booked the Hall' });
    const main = await render(boardOf({ done: [closed] }));
    const row = main.querySelector('[data-card="wc_0123456789abcdef"]');
    expect(row.textContent).toContain('Done: Booked the Hall');
    button(row, 'Pick a venue').click();
    expect(document.querySelector('.sheet').textContent).toMatch(/Closed as done by Justin, proved by the console PIN, .+: Booked the Hall/);
    button(row, 'Reopen').click();
    button(document.querySelector('.sheet'), 'Continue').click();
    await enterPin();
    expect(posts[0].body).toEqual({ action: 'unarchive', titleHash: H('a'), names: 'rt_close1', pin: '123456' });
  });
});
