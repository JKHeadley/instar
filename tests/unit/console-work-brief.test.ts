/**
 * The redesigned work board card (Justin 2026-11-18: "make the content extremely pleasant and easy to digest"):
 * the pure reading of a card (dashboard/console/work-model.js) and the shipped page in jsdom: hero with the ask,
 * the recommendation with the main button under it, a checklist with status icons, Details folded, the
 * conversation as a chat, and tiles with one main button.
 */
// @ts-nocheck — the console modules are browser-native ESM (.js), no types.
import path from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  parseNeed, cardBrief, unescapeMd, dropWaitId, checkStatusOf, statusChip, waitingWords, tileAsk, rankActions, chatLines, messagesPathOf, firstSentence,
} from '../../dashboard/console/work-model.js';

const CONSOLE = path.resolve(__dirname, '../../dashboard/console');
const H = (c) => c.repeat(64);
const ok = (data) => ({ ok: true, status: 200, data });

// The live need text of a Chief of Staff wait card (GET /work-board, 2026-11-18), byte for byte.
const LIVE_NEED = 'The Chief of Staff marks this project waiting on you.\n\nGoal: Keep Instar using the best features each engine \\(Claude Code, Codex, ...\\) offers, as an ongoing effort.\n\nDone when (from the project):\n- Each newly found engine feature is either adopted or recorded with the reason not to.: not known\n- Justin is happy with the review routine.: needs your judgment\n\nWhen it started waiting, the Chief of Staff\'s check said (its own words): "The agent is waiting for the owner to choose whether to run all three experiments, run only the guard test, or wait."\n\nWaiting on you since 2026-11-17 22:15:31 UTC (wait c5c23e80).';
const CONFIRM_NEED = 'Every automatic check of this project passes. The items below that need your judgment are yours to check.\n\nGoal: Ship the \\*app\\*.\n\nDone when (from the project):\n- Tests pass.: passes\n- Release notes \\[draft\\] written.: fails\n- Justin likes it.: needs your judgment\n- and 2 more items on the project\'s own page\n\nWaiting on you since 2026-11-16 16:36:02 UTC (wait 0a1b2c3d).';

function card(over = {}) {
  return {
    id: 'wc_0123456789abcdef', conversationKey: 'a58fc369-178e-4974-9676-c24b0df685b8', status: 'with-person', lane: 'waiting-on-you',
    turn: 'you', started: false, startedAt: null, closeout: null, needLine: 'Yours to do', newestAt: '2026-11-19T00:09:34Z',
    title: 'Engine Feature Optimization is waiting on you', titleHash: H('a'), need: LIVE_NEED,
    recommendation: 'Reply in the project\'s conversation with your decision on what the check names; its next check picks it up.',
    whyYou: 'The Chief of Staff marks a project waiting on you only when its next step needs your answer. It does not decide for you.',
    covers: ['cos:waiting:telegram:141868'], serverOwned: true, createdAt: '2026-11-19T00:09:34Z',
    doneWhen: [{ id: 'wait-cleared', text: 'The Chief of Staff no longer marks this project waiting on you.', certify: 'agent-may-certify' }],
    carrier: { personKey: 'operator', name: 'Justin' }, outward: false, materialHash: H('b'), approvalRequired: false, approved: false,
    question: null, questions: [], evidence: [], claim: null, reopens: [], holds: [], archives: [], carrierTrail: [], taps: [], pickups: [],
    conversation: { kind: 'app', key: 'a58fc369-178e-4974-9676-c24b0df685b8', messagesPath: '/mobile/chat/app/a58fc369-178e-4974-9676-c24b0df685b8/messages' },
    ...over,
  };
}

describe('parseNeed: the Chief of Staff wait card, split into its parts', () => {
  it('reads the live need: goal unescaped, checklist with states, the check note, the wait start', () => {
    const p = parseNeed(LIVE_NEED);
    expect(p.structured).toBe(true);
    expect(p.goal).toBe('Keep Instar using the best features each engine (Claude Code, Codex, ...) offers, as an ongoing effort.');
    expect(p.checks).toEqual([
      { text: 'Each newly found engine feature is either adopted or recorded with the reason not to.', status: 'unknown' },
      { text: 'Justin is happy with the review routine.', status: 'needs-you' },
    ]);
    expect(p.chiefSaid).toBe('The agent is waiting for the owner to choose whether to run all three experiments, run only the guard test, or wait.');
    expect(p.waitingSince).toBe('2026-11-17T22:15:31Z');
    expect(p.intro).toEqual(['The Chief of Staff marks this project waiting on you.']);
    expect(JSON.stringify(p)).not.toContain('c5c23e80');
  });
  it('a confirm card: passes and fails, escapes undone, and the "and N more" line kept without a state', () => {
    const p = parseNeed(CONFIRM_NEED);
    expect(p.goal).toBe('Ship the *app*.');
    expect(p.checks.map((c) => c.status)).toEqual(['passes', 'fails', 'needs-you', null]);
    expect(p.checks[1].text).toBe('Release notes [draft] written.');
    expect(p.checks[3].text).toBe('and 2 more items on the project\'s own page');
    expect(p.waitingSince).toBe('2026-11-16T16:36:02Z');
  });
  it('a session\'s free Markdown need is not structured', () => {
    const p = parseNeed('Please **review** PR 3404.\n\nIt touches the scheduler.');
    expect(p.structured).toBe(false);
    expect(p.goal).toBeNull();
    expect(p.checks).toEqual([]);
  });
  it('empty, missing and odd input never throw', () => {
    for (const v of [undefined, null, '', 42, 'Goal:']) expect(() => parseNeed(v)).not.toThrow();
    expect(parseNeed('Waiting on you since not-a-date UTC.').waitingSince).toBeNull();
  });
  it('the small helpers', () => {
    expect(unescapeMd('a \\(b\\) \\*c\\* \\\\d')).toBe('a (b) *c* \\d');
    expect(dropWaitId('since x (wait c5c23e80).')).toBe('since x.');
    expect(checkStatusOf('not known')).toBe('unknown');
    expect(checkStatusOf('needs your judgment')).toBe('needs-you');
    expect(checkStatusOf('Passes')).toBe('passes');
    expect(checkStatusOf('maybe')).toBeNull();
    expect(firstSentence('One. Two.')).toBe('One.');
    expect(firstSentence('x'.repeat(300)).length).toBe(220);
  });
});

describe('cardBrief: the brief when the card carries one, the parsed need when not', () => {
  it('without a brief, an "answer" wait asks the check note and Details does not repeat it', () => {
    const b = cardBrief(card());
    expect(b.ask).toBe('The agent is waiting for the owner to choose whether to run all three experiments, run only the guard test, or wait.');
    expect(b.chiefSaid).toBeNull();
    expect(b.intro).toEqual([]);
    expect(b.body).toBeNull();
    expect(b.fromBrief).toBe(false);
  });
  it('a "confirm" wait asks its opening line', () => {
    expect(cardBrief(card({ need: CONFIRM_NEED })).ask).toBe('Every automatic check of this project passes. The items below that need your judgment are yours to check.');
  });
  it('a brief wins, its checks are kept to the four statuses, and the check note shows in Details', () => {
    const b = cardBrief(card({ brief: { ask: 'Pick which experiments to run.', goal: 'G', checks: [{ text: 'A', status: 'passes' }, { text: 'B', status: 'weird' }, { text: '' }, 'x'], chiefSaid: 'It waits.', waitingSince: '2026-11-18T22:15:00Z' } }));
    expect(b).toMatchObject({ ask: 'Pick which experiments to run.', goal: 'G', chiefSaid: 'It waits.', waitingSince: '2026-11-18T22:15:00Z', fromBrief: true });
    expect(b.checks).toEqual([{ text: 'A', status: 'passes' }, { text: 'B', status: 'unknown' }]);
  });
  it('a session\'s card asks its first sentence and keeps the whole need as the body', () => {
    const b = cardBrief(card({ serverOwned: undefined, need: 'Please review PR 3404. It touches the scheduler.' }));
    expect(b.ask).toBe('Please review PR 3404.');
    expect(b.body).toBe('Please review PR 3404. It touches the scheduler.');
    expect(cardBrief(card({ need: 'One line only.' })).body).toBeNull();
    expect(cardBrief(card({ need: '' })).ask).toBe('Yours to do');
  });
});

describe('words, buttons and the conversation', () => {
  const now = Date.parse('2026-11-18T23:00:00Z');
  it('status chip and the waiting line', () => {
    expect(statusChip(card())).toEqual({ words: 'Waiting on you', kind: 'you' });
    expect(statusChip(card({ status: 'with-agent', turn: 'agent' }))).toEqual({ words: 'With the agent', kind: 'moving' });
    expect(statusChip(card({ status: 'needs-approval', turn: undefined, lane: 'waiting-on-you' }))).toEqual({ words: 'Needs your approval', kind: 'you' });
    expect(statusChip(card({ status: 'done', turn: undefined, lane: 'done' }))).toEqual({ words: 'Done', kind: 'still' });
    expect(waitingWords(card(), '2026-11-18T20:00:00Z', now)).toMatch(/^Waiting on you · since today /);
    expect(waitingWords(card(), '2026-11-18T20:00:00Z', now, { short: true })).toMatch(/^Since today /);
    expect(waitingWords(card(), null, now)).toBeNull();
    expect(waitingWords(card(), 'nope', now)).toBeNull();
  });
  it('a closed tile says how it closed; an open one says its ask', () => {
    expect(tileAsk(card({ status: 'archived', needLine: 'Done: Booked the Hall' }), { ask: 'x' })).toBe('Done: Booked the Hall');
    expect(tileAsk(card(), { ask: 'Pick one.' })).toBe('Pick one.');
  });
  it('one main button: the primary tone first, else Done; Put on hold and Remove go quiet', () => {
    const r = rankActions([{ action: 'close-done', tone: 'quiet' }, { action: 'close-not-important', tone: 'quiet' }, { action: 'hold', tone: 'quiet' }, { action: 'redact', tone: 'danger' }]);
    expect(r.primary.action).toBe('close-done');
    expect(r.secondary.map((a) => a.action)).toEqual(['close-not-important']);
    expect(r.quiet.map((a) => a.action)).toEqual(['hold', 'redact']);
    expect(rankActions([{ action: 'close-done' }, { action: 'approve', tone: 'primary' }]).primary.action).toBe('approve');
    expect(rankActions([]).primary).toBeNull();
  });
  it('chat lines oldest first, with who said each; a bad read is null', () => {
    const lines = chatLines({ messages: [
      { messageId: 'b', role: 'operator', senderName: 'Justin', text: 'Why?', at: '2026-11-19T01:00:00Z' },
      { messageId: 'a', role: 'agent', text: 'Ready.', at: '2026-11-19T00:00:00Z' },
      { messageId: 'w', role: 'agent', systemSource: 'work-board', text: 'Card opened.', at: '2026-11-18T23:00:00Z' },
      { messageId: 'e', role: 'agent', text: '   ', at: '2026-11-19T02:00:00Z' },
    ] });
    expect(lines.map((l) => [l.id, l.who, l.name])).toEqual([['w', 'board', 'Work board'], ['a', 'agent', 'Agent'], ['b', 'you', 'Justin']]);
    expect(chatLines({})).toBeNull();
    expect(chatLines(null)).toBeNull();
  });
  it('the conversation is read only from an app conversation path', () => {
    expect(messagesPathOf(card())).toBe('/mobile/chat/app/a58fc369-178e-4974-9676-c24b0df685b8/messages?limit=30&scope=pool');
    expect(messagesPathOf(card({ conversation: { messagesPath: 'https://evil.example/x' } }))).toBe('/mobile/chat/app/a58fc369-178e-4974-9676-c24b0df685b8/messages?limit=30&scope=pool');
    expect(messagesPathOf(card({ conversation: null, conversationKey: '../x' }))).toBeNull();
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
const tick = () => new Promise((r) => setTimeout(r, 0));
const boardOf = (cards) => ({ lanes: [{ lane: 'waiting-on-you', cards }, { lane: 'with-agent', cards: [] }, { lane: 'waiting-on-others', cards: [] }, { lane: 'done', cards: [], total: 0 }, { lane: 'archived', cards: [], total: 0 }], waitingOnYou: cards.length, policy: 'every-agent-card', pickups: null, behind: null, settings: null });

async function render(c, messages) {
  const msgPath = '/mobile/chat/app/a58fc369-178e-4974-9676-c24b0df685b8/messages?limit=30&scope=pool';
  const reads = { '/work-board': ok(boardOf([c])), '/work/projects': ok({ projects: [] }), ...(messages ? { [msgPath]: messages } : {}) };
  const { renderWork } = await import(path.join(CONSOLE, 'work.js'));
  const main = document.createElement('main'); document.body.replaceChildren(main);
  const get = vi.fn(async (p: string) => reads[p] || { ok: false, reason: 'no' });
  await renderWork(main, { get });
  return { main, get };
}

describe('the page', () => {
  beforeEach(() => installDom());

  it('a tile: status chip, title, the ask, since when, and exactly one main button', async () => {
    const { main } = await render(card());
    const row = main.querySelector('[data-card="wc_0123456789abcdef"]');
    expect(row.querySelector('.wc-chip-you').textContent).toBe('Waiting on you');
    expect(row.querySelector('.wc-tile-ask').textContent).toContain('run only the guard test');
    expect(row.querySelector('.wc-since').textContent).toMatch(/^Since /);
    const buttons = [...row.querySelectorAll('.work-actions button')];
    expect(buttons.map((b) => b.textContent)).toEqual(['Done']);
    expect(buttons[0].classList.contains('btn-primary')).toBe(true);
    expect(row.textContent).not.toContain('Not important');
  });

  it('the opened card: hero ask, why you, recommendation then Done filled, Not important outlined, Hold quiet, no "…"', async () => {
    const { main } = await render(card());
    main.querySelector('.work-open').click();
    const sheet = document.querySelector('.sheet');
    expect(sheet.classList.contains('sheet-wide')).toBe(true);
    expect(sheet.querySelector('.wc-title').textContent).toBe('Engine Feature Optimization is waiting on you');
    expect(sheet.querySelector('.wc-ask').textContent).toContain('choose whether to run all three experiments');
    expect(sheet.querySelector('.wc-hero .wc-why').textContent).toContain('It does not decide for you.');
    expect(sheet.querySelector('.wc-hero').textContent).toMatch(/Waiting on you · since /);
    const decide = sheet.querySelector('.wc-callout');
    expect(decide.querySelector('.wc-reco').textContent).toContain('Reply in the project');
    const [main1, quiet] = [...decide.querySelectorAll('.work-actions')];
    expect([...main1.querySelectorAll('button')].map((b) => [b.textContent, b.className.split(' ')[0]])).toEqual([['Done', 'btn-primary'], ['Not important', 'btn-quiet']]);
    expect([...quiet.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Put on hold', 'Remove for good']);
    expect([...sheet.querySelectorAll('button')].some((b) => b.textContent.includes('…'))).toBe(false);
    // Checklist with status icons, then the card's own done item.
    const checks = [...sheet.querySelectorAll('.wc-check')];
    expect(checks.map((c) => c.className.replace('wc-check ', '').replace(' ', ''))).toEqual(['wc-check-unknown', 'wc-check-needs-you', 'wc-check-unknown']);
    expect(checks[1].textContent).toContain('Needs you');
    // Goal folded in Details; the raw need, the wait id and the escapes are gone.
    const details = sheet.querySelector('details.wc-details');
    expect(details.open).toBe(false);
    expect(details.textContent).toContain('Keep Instar using the best features each engine (Claude Code, Codex, ...) offers');
    expect(sheet.textContent).not.toContain('c5c23e80');
    expect(sheet.textContent).not.toContain('\\(');
    expect(sheet.textContent).not.toContain('2026-11-17 22:15:31 UTC');
  });

  it('the conversation is a chat read with the page\'s own sign-in, with a link to reply in full', async () => {
    const messages = ok({ messages: [
      { messageId: 'm2', role: 'operator', senderName: 'Justin', text: 'What does it cost?', at: '2026-11-19T01:00:00Z' },
      { messageId: 'm1', role: 'agent', text: 'Three experiments are ready.', at: '2026-11-19T00:12:00Z' },
    ] });
    const { main, get } = await render(card(), messages);
    main.querySelector('.work-open').click();
    for (let i = 0; i < 4; i++) await tick();
    const chat = document.querySelector('.wc-chat');
    expect(get).toHaveBeenCalledWith('/mobile/chat/app/a58fc369-178e-4974-9676-c24b0df685b8/messages?limit=30&scope=pool');
    expect([...chat.querySelectorAll('.wc-msg')].map((m) => m.className)).toEqual(['wc-msg wc-msg-agent', 'wc-msg wc-msg-you']);
    expect(chat.querySelector('.wc-chat-reply').getAttribute('href')).toContain('a58fc369-178e-4974-9676-c24b0df685b8');
  });

  it('an empty or unreadable conversation says so in words', async () => {
    const { main } = await render(card(), ok({ messages: [] }));
    main.querySelector('.work-open').click();
    for (let i = 0; i < 4; i++) await tick();
    expect(document.querySelector('.wc-chat').textContent).toContain('No messages yet.');
    const again = await render(card());
    again.main.querySelector('.work-open').click();
    for (let i = 0; i < 4; i++) await tick();
    expect(document.querySelector('.wc-chat').textContent).toContain('could not be read here');
  });
});
