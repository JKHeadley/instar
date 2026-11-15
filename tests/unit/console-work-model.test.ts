/**
 * The console's Work board page (docs/specs/work-board-asks.md §4, §5, §7): the board read, the
 * buttons each status offers, the tap body each action sends (always with the card's titleHash),
 * what the confirm step shows, the settings patch, and Home's rows (off ⇒ nothing, a bad shape ⇒
 * unreadable, past the soft budget ⇒ one counted line). The second half renders the shipped page
 * in jsdom and drives one tap end to end against a mocked server.
 */
// @ts-nocheck — the modules are browser-native ESM (.js), no types.
import path from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  readBoard, headline, cardActions, tapBody, tapCovers, cardRow, workBoardNeedRows, settingsPatch, donePaging, donePageFrom,
  cardFromQuery, policyPinExplain, refusalWords, isOff, POLICIES, claimEvidence, capacityWords,
} from '../../dashboard/console/work-model.js';
import { NEED_SOURCES } from '../../dashboard/console/needs-model.js';
import { NATIVE_PAGES, CONSOLE_ONLY_TABS, GROUPS, PHONE_PAGE_ALIASES, tabHref } from '../../dashboard/console/nav-model.js';

const CONSOLE = path.resolve(__dirname, '../../dashboard/console');
const NOW = Date.parse('2026-11-12T12:00:00Z');
const ok = (data) => ({ ok: true, status: 200, data });
const H = (c) => c.repeat(64);

function card(over = {}) {
  return {
    id: 'wc_0123456789abcdef', conversationKey: '0b0c0d0e-0f10-5111-8213-141516171819', status: 'needs-approval', lane: 'waiting-on-you',
    needLine: 'Needs your approval before the agent starts', newestAt: '2026-11-12T10:00:00Z',
    title: 'Renew the domain', titleHash: H('a'), need: 'Renew **it** for a year.', recommendation: 'One year is enough.',
    doneWhen: [{ id: 'd1', text: 'Renewed', certify: 'owner-confirms' }, { id: 'd2', text: 'Receipt filed', certify: 'agent-may-certify' }],
    carrier: 'agent', outward: true, outwardWords: 'This sends something outside your team or spends money',
    links: [{ label: 'Registrar', url: 'https://reg.example/renew', host: 'reg.example', note: 'Approval covers this address, not what it serves later' }],
    waitingOn: { personKey: 'p1', name: 'Justin' }, due: null, materialHash: H('b'), approvalRequired: true, approved: false, approvedBy: null,
    withdrawn: false, policy: 'every-agent-card', question: null, questions: [], evidence: [], claim: null, done: false, doneByAgentOwnEvidence: false,
    reopens: [], holds: [], archives: [], carrierTrail: [], taps: [], unreadable: null, workable: false, mayHaveBeenHandedOver: false, pickups: [],
    capacity: null, retryOf: null, lineIds: [], repliedAfterQuestion: false, ...over,
  };
}
function board(waiting = [card()], over = {}) {
  return {
    lanes: [
      { lane: 'waiting-on-you', cards: waiting, ...(over.more ? { more: over.more } : {}) },
      { lane: 'with-agent', cards: over.withAgent || [] },
      { lane: 'waiting-on-others', cards: [] },
      { lane: 'done', cards: over.done || [], total: over.doneTotal ?? (over.done || []).length },
      { lane: 'archived', cards: [] },
    ],
    waitingOnYou: waiting.length + (over.more || 0), policy: over.policy || 'every-agent-card', pickups: null, behind: over.behind ?? null,
    settings: { softOpenCards: 30, maxAgentCardsPerDay: 200, quietAfterHours: 24, limits: { recordBytes: 32768, title: 300, need: 4000, recommendation: 2000, doneItemText: 500, optionText: 200 }, pickup: { tickSeconds: 60, freeCheckMinSeconds: 60, freeCheckMaxSeconds: 1800, maxSpendingAttempts: 3, surfaceAfterHours: 24, ownerCatchUpSeconds: 600 } },
  };
}
const acts = (c, o) => cardActions(c, o).map((a) => a.action);

describe('readBoard', () => {
  it('reads the five lanes, the counts and the policy', () => {
    const b = readBoard(board([card()], { more: 3, done: [card({ id: 'wc_1111111111111111', status: 'done' })], doneTotal: 41 }));
    expect(b.ok).toBe(true);
    expect(b.lanes['waiting-on-you'].more).toBe(3);
    expect(b.lanes.done.total).toBe(41);
    expect(b.waitingOnYou).toBe(4);
    expect(headline(b)).toBe('4 cards are waiting on you.');
    expect(headline(readBoard(board([])))).toBe('Nothing on the board is waiting on you.');
  });
  it('a body without lanes, an unknown lane, or a card without an id is unreadable', () => {
    expect(readBoard({}).ok).toBe(false);
    expect(readBoard({ lanes: [{ lane: 'somewhere', cards: [] }] }).ok).toBe(false);
    expect(readBoard({ lanes: [{ lane: 'waiting-on-you', cards: [{ title: 'x' }] }] }).ok).toBe(false);
    expect(readBoard({ lanes: [{ lane: 'with-agent', cards: [] }] }).ok).toBe(false); // no waiting lane: cannot say "nothing waiting"
  });
});

describe('which buttons each status offers', () => {
  it('needs-approval → Approve (+ Archive); the sheet adds Put on hold and Remove for good', () => {
    expect(acts(card())).toEqual(['approve', 'archive']);
    expect(acts(card(), { inSheet: true })).toEqual(['approve', 'archive', 'hold', 'redact']);
  });
  it('waiting-on-person → Answer', () => {
    expect(acts(card({ status: 'waiting-on-person', question: { id: 'rq1', text: 'Which year?', options: ['1', '2'] } }))).toEqual(['answer', 'archive']);
  });
  it('claims-done → Confirm done and Reopen; done → Reopen', () => {
    const claim = { id: 'rc1', evidenceIds: [], needsConfirm: true, at: '2026-11-12T11:00:00Z' };
    expect(acts(card({ status: 'claims-done', claim }))).toEqual(['confirm-done', 'reopen', 'archive']);
    expect(acts(card({ status: 'done', claim }), { inSheet: true })).toEqual(['reopen', 'archive', 'redact']);
  });
  it('held → Release hold; parked and quiet → Try again and, when approved, Withdraw approval', () => {
    expect(acts(card({ status: 'held', holds: ['rh1'] }))).toEqual(['unhold', 'archive']);
    expect(acts(card({ status: 'parked', retryOf: 'rp1', approved: true }))).toEqual(['retry', 'withdraw-approval', 'archive']);
    expect(acts(card({ status: 'quiet', retryOf: 'rn1', approved: false }))).toEqual(['retry', 'archive']);
  });
  it('with-agent → Withdraw approval (Try again only while waiting for a free session); archived → Restore only; removed → nothing', () => {
    expect(acts(card({ status: 'with-agent', approved: true }))).toEqual(['withdraw-approval', 'archive']);
    expect(acts(card({ status: 'with-agent', approved: true, retryOf: 'rw1' }))).toEqual(['retry', 'withdraw-approval', 'archive']);
    expect(acts(card({ status: 'archived', archives: ['ra1'] }), { inSheet: true })).toEqual(['unarchive', 'redact']);
    expect(acts({ id: 'wc_1', status: 'removed', removed: { note: 'x' } }, { inSheet: true })).toEqual([]);
  });
  it('a question open on a held card can still be answered', () => {
    expect(acts(card({ status: 'held', holds: ['rh1'], question: { id: 'rq1', text: 'Which?' } }))).toEqual(['unhold', 'answer', 'archive']);
  });
});

describe('tap bodies bind to what the person was shown, always with the titleHash', () => {
  const claim = { id: 'rc1', evidenceIds: ['re1'], needsConfirm: true, at: 'x' };
  it.each([
    ['approve', card(), {}, { action: 'approve', titleHash: H('a'), materialHash: H('b') }],
    ['answer', card({ question: { id: 'rq1', text: 'Which?' } }), { answer: ' two years ' }, { action: 'answer', titleHash: H('a'), questionId: 'rq1', answer: 'two years' }],
    ['confirm-done', card({ claim }), {}, { action: 'confirm-done', titleHash: H('a'), claimId: 'rc1', materialHash: H('b') }],
    ['reopen', card({ claim }), {}, { action: 'reopen', titleHash: H('a'), claimId: 'rc1' }],
    ['unhold', card({ holds: ['rh1', 'rh2'] }), {}, { action: 'unhold', titleHash: H('a'), names: 'rh1' }],
    ['unarchive', card({ archives: ['ra1'] }), {}, { action: 'unarchive', titleHash: H('a'), names: 'ra1' }],
    ['retry', card({ retryOf: 'rp1' }), {}, { action: 'retry', titleHash: H('a'), retryOf: 'rp1' }],
    ['hold', card(), {}, { action: 'hold', titleHash: H('a') }],
    ['withdraw-approval', card(), {}, { action: 'withdraw-approval', titleHash: H('a') }],
    ['archive', card(), {}, { action: 'archive', titleHash: H('a') }],
    ['redact', card(), {}, { action: 'redact', titleHash: H('a') }],
  ])('%s', (action, c, extra, want) => {
    const r = tapBody(c, action, extra);
    expect(r.ok).toBe(true);
    expect(r.body).toEqual(want);
    expect(r.body.pin).toBeUndefined();
  });
  it('refuses a tap with nothing to bind to, in words', () => {
    expect(tapBody(card(), 'answer', { answer: 'x' })).toMatchObject({ ok: false });
    expect(tapBody(card({ question: { id: 'rq1', text: 'q' } }), 'answer', { answer: '   ' })).toMatchObject({ ok: false, reason: 'Type or choose an answer.' });
    expect(tapBody(card(), 'confirm-done')).toMatchObject({ ok: false });
    expect(tapBody(card(), 'retry')).toMatchObject({ ok: false });
    expect(tapBody(card(), 'unhold')).toMatchObject({ ok: false });
    expect(tapBody(card(), 'explode')).toMatchObject({ ok: false });
  });
});

describe('what the confirm step shows (§4)', () => {
  it('approve shows title, need, every done item with its mark, carrier, the outward words, links with hosts, the recommendation', () => {
    const text = JSON.stringify(tapCovers(card(), 'approve'));
    for (const s of ['Renew the domain', 'Renew **it** for a year.', 'One year is enough.', 'Renewed (You confirm this one)', 'Receipt filed (The agent may finish this on its own evidence)', 'The agent', 'This sends something outside your team or spends money', 'reg.example', 'Approval covers this address']) expect(text).toContain(s);
  });
  it('approve warns when the card may already have been handed over', () => {
    expect(JSON.stringify(tapCovers(card({ mayHaveBeenHandedOver: true }), 'approve'))).toContain('may already have been handed over');
  });
  it('confirm-done shows each done item with the evidence the claim rests on, not evidence written after it', () => {
    const c = card({ claim: { id: 'rc1', evidenceIds: ['re1'] }, evidence: [{ id: 're1', itemId: 'd1', text: 'Paid, order 77' }, { id: 're9', itemId: 'd2', text: 'later' }] });
    expect(claimEvidence(c).map((x) => x.evidence)).toEqual([['Paid, order 77'], []]);
    const text = JSON.stringify(tapCovers(c, 'confirm-done'));
    expect(text).toContain('Renewed: Paid, order 77');
    expect(text).toContain('Receipt filed: no evidence listed');
    expect(text).not.toContain('later');
  });
  it('answer shows the question and the answer', () => {
    const t = JSON.stringify(tapCovers(card({ question: { id: 'rq1', text: 'Which year?' } }), 'answer', { answer: '2027' }));
    expect(t).toContain('Which year?'); expect(t).toContain('2027');
  });
});

describe('rows', () => {
  it('a reply after the question shows on the row', () => {
    expect(cardRow(card({ repliedAfterQuestion: true })).notes).toContain('You replied; the agent has not updated the card');
    expect(cardRow(card({ mayHaveChangedOn: 'm-studio' })).notes).toContain('This card may have changed on m-studio');
  });
  it('capacity is said with the time in words, not a raw timestamp', () => {
    const w = capacityWords({ reason: 'every session slot is busy', nextCheckAt: '2026-11-12T12:30:00Z', since: '2026-11-12T11:00:00Z', words: 'x' }, NOW);
    expect(w).toContain('every session slot is busy');
    expect(w).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});

describe('Done paging and links', () => {
  it('20 newest, then 50 a page', () => {
    expect(donePaging(10, 0)).toMatchObject({ next: null, prev: null });
    expect(donePaging(130, 0).next).toEqual({ href: '#/work/board?donePage=1', text: 'Show all' });
    expect(donePaging(130, 1)).toMatchObject({ line: 'Showing 21–70 of 130', next: { href: '#/work/board?donePage=2' }, prev: { href: '#/work/board' } });
    expect(donePaging(130, 3)).toMatchObject({ line: 'Showing 121–130 of 130', next: null });
    expect(donePageFrom('donePage=2')).toBe(2);
    expect(donePageFrom('donePage=-1')).toBe(0);
    expect(cardFromQuery('card=wc_0123456789abcdef')).toBe('wc_0123456789abcdef');
    expect(cardFromQuery('card=../x')).toBeNull();
  });
});

describe('settings', () => {
  const s = board().settings;
  it('sends only changed whole numbers, nested as the server stores them', () => {
    expect(settingsPatch(s, { softOpenCards: '30', quietAfterHours: '12', 'pickup.maxSpendingAttempts': '5' })).toEqual({ ok: true, patch: { quietAfterHours: 12, pickup: { maxSpendingAttempts: 5 } } });
    expect(settingsPatch(s, { quietAfterHours: '0' }).ok).toBe(false);
    expect(settingsPatch(s, { quietAfterHours: '1.5' }).ok).toBe(false);
    expect(settingsPatch(s, { 'pickup.freeCheckMinSeconds': '30' })).toMatchObject({ ok: false, path: 'pickup.freeCheckMinSeconds' });
  });
  it('both policies are said in plain words; outward-only says the outward mark is the only thing that asks', () => {
    expect(POLICIES.find((p) => p.id === 'every-agent-card').words).toBe('The agent waits for your OK on every card it writes.');
    expect(POLICIES.find((p) => p.id === 'outward-only').words).toMatch(/only cards that send something outside your team or spend money wait for you/);
    expect(POLICIES.find((p) => p.id === 'outward-only').words).toMatch(/outward mark on a card is the only thing that asks/);
    expect(policyPinExplain('outward-only', 3)).toContain('3 waiting cards would start at once.');
    expect(policyPinExplain('outward-only', 0)).toContain('No waiting card would start at once.');
  });
  it('refusals become words', () => {
    expect(refusalWords(409, { error: 'stale-card' })).toMatch(/changed since you opened it/);
    expect(refusalWords(403, { error: 'Invalid PIN' })).toBe('That PIN did not work.');
    expect(refusalWords(0, {})).toBe('The server could not be reached.');
  });
});

describe('Home rows (needs-model workBoard source)', () => {
  it('is registered, reading GET /work-board, landing on the registered page', () => {
    const src = NEED_SOURCES.find((x) => x.id === 'workBoard');
    expect(src?.reads).toEqual({ wb: '/work-board' });
    expect(src?.page).toBe('work/board');
  });
  it('off (503) ⇒ nothing waiting; a failure or a shapeless 200 ⇒ unreadable', () => {
    expect(isOff({ ok: false, reason: 'switched off on this agent' })).toBe(true);
    expect(workBoardNeedRows({ ok: false, reason: 'switched off on this agent' })).toEqual([]);
    expect(workBoardNeedRows({ ok: false, status: 503 })).toEqual([]);
    expect(workBoardNeedRows({ ok: false, status: 500, reason: 'the server answered 500' })).toBeNull();
    expect(workBoardNeedRows(ok({ hello: 1 }))).toBeNull();
    const src = NEED_SOURCES.find((x) => x.id === 'workBoard');
    expect(src.rows({ wb: ok({ hello: 1 }) }, NOW)).toBeNull();
  });
  it('one row per waiting card, linking to that card', () => {
    const rows = NEED_SOURCES.find((x) => x.id === 'workBoard').rows({ wb: ok(board([card(), card({ id: 'wc_2222222222222222', title: 'Pick a name', needLine: 'Which name?' })])) }, NOW);
    expect(rows.map((r) => r.key)).toEqual(['need:work:wc_0123456789abcdef', 'need:work:wc_2222222222222222']);
    expect(rows[1]).toMatchObject({ main: 'Pick a name', sub: 'Which name?', tone: 'attn', action: { kind: 'href', href: '#/work/board?card=wc_2222222222222222' } });
  });
  it('past the soft budget, the rest are one counted row', () => {
    const rows = workBoardNeedRows(ok(board([card()], { more: 7 })));
    expect(rows).toHaveLength(2);
    expect(rows[1].main).toBe('7 more cards are waiting on you');
    const b = board([card(), card({ id: 'wc_3333333333333333' }), card({ id: 'wc_4444444444444444' })]);
    b.settings.softOpenCards = 2;
    expect(workBoardNeedRows(ok(b)).map((r) => r.main)).toEqual(['Renew the domain', 'Renew the domain', '1 more card is waiting on you']);
  });
  it('nothing waiting ⇒ no rows', () => { expect(workBoardNeedRows(ok(board([])))).toEqual([]); });
});

describe('registration', () => {
  it('the Work group has a probed Work board tile that opens the native page; the phone alias resolves', () => {
    const t = GROUPS.find((g) => g.id === 'work').tabs.find((x) => x.id === 'work-board');
    expect(t?.probe).toBe('/work-board');
    expect(CONSOLE_ONLY_TABS).toContain('work-board');
    expect(NATIVE_PAGES['work-board']).toBe('#/work/board');
    expect(tabHref('work-board')).toBe('#/work/board');
    expect(PHONE_PAGE_ALIASES.board).toBe('work/board');
  });
});

// ── the shipped page in jsdom ──────────────────────────────────────────────
let reads: Record<string, unknown> = {};
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
    if (u === '/dashboard/unlock-check' || u.startsWith('/dashboard/unlock')) return { ok: true, status: 200, json: async () => ({ accepted: true }) };
    return { ok: false, status: 404, json: async () => ({}) };
  });
  w.scrollTo = vi.fn();
  w.HTMLElement.prototype.scrollIntoView = vi.fn();
}
const mainNode = () => { const m = document.createElement('main'); m.id = 'main'; document.body.replaceChildren(m); return m; };
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('the page', () => {
  beforeEach(() => { installDom(); reads = {}; posts = []; postAnswer = { status: 200, data: { recordId: 'rt1' } }; });
  const ctx = () => ({ get: vi.fn(async (p: string) => (p in reads ? reads[p] : { ok: false, reason: 'the server answered 500' })), post: vi.fn() });

  it('leads with Waiting on you, marked, with the card, its need line and an enabled Approve', async () => {
    reads['/work-board'] = ok(board([card({ repliedAfterQuestion: true })], { more: 2 }));
    const { renderWork } = await import(path.join(CONSOLE, 'work.js'));
    const main = mainNode();
    await renderWork(main, ctx());
    const lead = main.querySelector('[data-operator-need="workBoard"]');
    expect(lead).toBeTruthy();
    expect(lead.textContent).toContain('Waiting on you');
    expect(lead.textContent).toContain('Renew the domain');
    expect(lead.textContent).toContain('Needs your approval before the agent starts');
    expect(lead.textContent).toContain('You replied; the agent has not updated the card');
    expect(lead.textContent).toContain('2 more waiting');
    const approve = [...lead.querySelectorAll('button')].find((b) => b.textContent === 'Approve');
    expect(approve && !approve.disabled).toBe(true);
    for (const t of ['With the agent', 'Waiting on others', 'Done', 'Archived', 'Settings']) expect(main.textContent).toContain(t);
    expect(main.textContent).not.toMatch(/wc_[0-9a-f]{16}/); // no internal ids on screen
  });

  it('Approve shows what it covers, then the PIN, then sends the bound body with the PIN', async () => {
    reads['/work-board'] = ok(board([card()]));
    const { renderWork } = await import(path.join(CONSOLE, 'work.js'));
    const main = mainNode();
    await renderWork(main, ctx());
    [...main.querySelectorAll('button')].find((b) => b.textContent === 'Approve').click();
    const covers = document.querySelector('.sheet');
    expect(covers.textContent).toContain('This sends something outside your team or spends money');
    expect(covers.textContent).toContain('reg.example');
    expect(covers.textContent).toContain('The agent may finish this on its own evidence');
    [...covers.querySelectorAll('button')].find((b) => b.textContent === 'Continue').click();
    for (let i = 0; i < 5; i++) await tick();
    const pin = document.querySelector('.pin-input') as any;
    expect(pin).toBeTruthy();
    pin.value = '123456';
    document.querySelector('.pin-form').dispatchEvent(new (window as any).Event('submit', { cancelable: true }));
    for (let i = 0; i < 5; i++) await tick();
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe('/work-board/cards/wc_0123456789abcdef/tap');
    expect(posts[0].body).toEqual({ action: 'approve', titleHash: H('a'), materialHash: H('b'), pin: '123456' });
  });

  it('a stale card is said in words', async () => {
    reads['/work-board'] = ok(board([card({ status: 'held', holds: ['rh1'] })]));
    postAnswer = { status: 409, data: { error: 'stale-card' } };
    const { renderWork } = await import(path.join(CONSOLE, 'work.js'));
    const main = mainNode();
    await renderWork(main, ctx());
    [...main.querySelectorAll('button')].find((b) => b.textContent === 'Release hold').click();
    [...document.querySelectorAll('.sheet button')].find((b) => b.textContent === 'Continue').click();
    for (let i = 0; i < 5; i++) await tick();
    (document.querySelector('.pin-input') as any).value = '1';
    document.querySelector('.pin-form').dispatchEvent(new (window as any).Event('submit', { cancelable: true }));
    for (let i = 0; i < 5; i++) await tick();
    expect(posts[0].body).toMatchObject({ action: 'unhold', names: 'rh1' });
    expect(main.textContent).toContain('The card changed since you opened it');
  });

  it('opening a card shows the fields, evidence, warnings, the proof behind taps and a link to its conversation', async () => {
    const c = card({
      status: 'claims-done', mayHaveBeenHandedOver: true, mayHaveChangedOn: 'm-studio',
      claim: { id: 'rc1', evidenceIds: ['re1'], needsConfirm: true, at: '2026-11-12T11:00:00Z' },
      evidence: [{ id: 're1', itemId: 'd1', text: 'Paid, order 77', counts: true, at: '2026-11-12T10:30:00Z', by: { kind: 'agent' } }],
      questions: [{ id: 'rq0', text: 'Old question', state: 'replaced', reason: 'asked the wrong thing', at: 'x' }],
      taps: [{ id: 'rt0', action: 'approve', at: '2026-11-12T09:00:00Z', by: { kind: 'person', name: 'Justin', proof: 'console PIN' } }],
    });
    reads['/work-board'] = ok(board([c]));
    const { renderWork } = await import(path.join(CONSOLE, 'work.js'));
    const main = mainNode();
    await renderWork(main, ctx());
    (main.querySelector('.work-open') as any).click();
    const s = document.querySelector('.sheet').textContent;
    for (const t of ['This may already have been handed over', 'This card may have changed on m-studio', 'Paid, order 77', 'Replaced: asked the wrong thing', 'Justin, proved by the console PIN', 'One year is enough.', 'Approval covers this address, not what it serves later', 'Confirm done', 'Remove for good']) expect(s).toContain(t);
    const conv = [...document.querySelectorAll('.sheet a')].find((a) => a.textContent === 'Open its conversation');
    expect(conv.getAttribute('href')).toBe('#/work/chats?c=app%3A0b0c0d0e-0f10-5111-8213-141516171819');
  });

  it('switched off says so; a shapeless answer cannot tell', async () => {
    const { renderWork } = await import(path.join(CONSOLE, 'work.js'));
    reads['/work-board'] = { ok: false, reason: 'switched off on this agent' };
    let main = mainNode(); await renderWork(main, ctx());
    expect(main.textContent).toContain('not switched on');
    reads['/work-board'] = ok({ nope: 1 });
    main = mainNode(); await renderWork(main, ctx());
    expect(main.textContent).toContain('Can’t tell');
  });
});
