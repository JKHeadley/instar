/**
 * Work Board slice 2 on the console (docs/specs/work-board-cards-appear.md §2–3; server side in #3404): a card's "why you"
 * under the recommendation, what it is about (pull requests by number, plans by kind; never an internal id and never the
 * Chief of Staff's own key), the Chief of Staff tag on a server-owned card, and the Needs-you row's link to its card
 * (only to a Work page card, with the server's fixed words).
 */
// @ts-nocheck — the console modules are browser-native ESM (.js), no types.
import path from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { coversWords, chiefOfStaffCard, CHIEF_OF_STAFF_WORDS } from '../../dashboard/console/work-model.js';
import { cardLinkOf } from '../../dashboard/console/needs-strip.js';

const CONSOLE = path.resolve(__dirname, '../../dashboard/console');
const H = (c) => c.repeat(64);
const ok = (data) => ({ ok: true, status: 200, data });

function card(over = {}) {
  return {
    id: 'wc_0123456789abcdef', conversationKey: '0b0c0d0e-0f10-5111-8213-141516171819', status: 'with-person', lane: 'waiting-on-you',
    turn: 'you', started: false, startedAt: null, closeout: null, needLine: 'Waiting on you', newestAt: '2026-11-18T07:00:00Z',
    title: 'Rows: your answer', titleHash: H('a'), need: 'The project is waiting on your answer.', recommendation: 'Answer in the project conversation.',
    whyYou: 'The Chief of Staff marks a project waiting on you only when its next step needs your answer; it does not decide for you.',
    covers: ['cos:waiting:telegram:144900'], serverOwned: true, createdAt: '2026-11-18T07:00:00Z',
    doneWhen: [], carrier: 'owner', outward: false, materialHash: H('b'), approvalRequired: false, approved: false,
    question: null, questions: [], evidence: [], claim: null, reopens: [], holds: [], archives: [], carrierTrail: [], taps: [], pickups: [], ...over,
  };
}

describe('what a card is about, and who wrote it', () => {
  it('pull requests by number and plans by kind; the Chief of Staff key and unknown keys say nothing', () => {
    expect(coversWords(card())).toBeNull();
    expect(coversWords(card({ covers: ['pr:3404', 'plan:abc123', 'plan:def456'] }))).toBe('pull request #3404, 2 plans in Needs you');
    expect(coversWords(card({ covers: ['plan:abc123'] }))).toBe('a plan in Needs you');
    expect(coversWords(card({ covers: ['pr:not-a-number', 42] }))).toBeNull();
    expect(coversWords(card({ covers: undefined }))).toBeNull();
    expect(coversWords(card({ covers: ['pr:3404', 'pr:#3404', 'pr:03404', 'plan:a', 'plan:a'] }))).toBe('pull request #3404, a plan in Needs you');
  });
  it('only a server-owned card is the Chief of Staff\'s', () => {
    expect(chiefOfStaffCard(card())).toBe(true);
    expect(chiefOfStaffCard(card({ serverOwned: undefined }))).toBe(false);
  });
});

describe('the Needs-you row\'s card link', () => {
  it('links only to a Work page card, with the server\'s words', () => {
    expect(cardLinkOf({ card: { id: 'wc_1', href: '#/work/board?card=wc_1', label: 'Has a card on the work board' } })).toEqual({ href: '#/work/board?card=wc_1', label: 'Has a card on the work board' });
    expect(cardLinkOf({ card: { href: 'javascript:alert(1)', label: 'x' } })).toBeNull();
    expect(cardLinkOf({ card: { href: 'https://example.com/#/work/board?card=wc_1' } })).toBeNull();
    expect(cardLinkOf({ card: { href: '#/people/secrets' } })).toBeNull();
    expect(cardLinkOf({ title: 'no card' })).toBeNull();
  });
});

// ── the shipped pages in jsdom ─────────────────────────────────────────────
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

describe('the pages', () => {
  beforeEach(() => installDom());

  it('a Chief of Staff card: tagged on its row; opened, it says who wrote it, why you, and nothing about its own key', async () => {
    const board = { lanes: [{ lane: 'waiting-on-you', cards: [card()] }, { lane: 'with-agent', cards: [] }, { lane: 'waiting-on-others', cards: [] }, { lane: 'done', cards: [], total: 0 }, { lane: 'archived', cards: [], total: 0 }], waitingOnYou: 1, policy: 'every-agent-card', pickups: null, behind: null, settings: null };
    const reads = { '/work-board': ok(board), '/work/projects': ok({ projects: [] }) };
    const { renderWork } = await import(path.join(CONSOLE, 'work.js'));
    const main = document.createElement('main'); document.body.replaceChildren(main);
    await renderWork(main, { get: vi.fn(async (p: string) => reads[p] || { ok: false, reason: 'no' }) });
    const row = main.querySelector('[data-card="wc_0123456789abcdef"]');
    expect(row.textContent).toContain(CHIEF_OF_STAFF_WORDS);
    [...row.querySelectorAll('button')].find((b) => b.textContent === 'Rows: your answer').click();
    const sheet = document.querySelector('.sheet').textContent;
    expect(sheet).toContain('The Chief of Staff, which keeps this card up to date itself');
    expect(sheet).toMatch(/Why you.*only when its next step needs your answer/s);
    // Why you sits by the ask in the hero; the recommendation follows with the main button under it.
    expect(document.querySelector('.sheet .wc-hero .wc-why')).toBeTruthy();
    expect(sheet.indexOf('Why you')).toBeLessThan(sheet.indexOf('Recommended'));
    expect(sheet.indexOf('Recommended')).toBeGreaterThan(-1);
    expect(sheet).not.toContain('cos:waiting');
    expect(sheet).not.toContain('About');
  });

  it('a session\'s card about a pull request says so and carries no tag', async () => {
    const c = card({ serverOwned: undefined, covers: ['pr:3404'], whyYou: 'Merging is your call.' });
    const board = { lanes: [{ lane: 'waiting-on-you', cards: [c] }, { lane: 'with-agent', cards: [] }, { lane: 'waiting-on-others', cards: [] }, { lane: 'done', cards: [], total: 0 }, { lane: 'archived', cards: [], total: 0 }], waitingOnYou: 1, policy: 'every-agent-card', pickups: null, behind: null, settings: null };
    const reads = { '/work-board': ok(board), '/work/projects': ok({ projects: [] }) };
    const { renderWork } = await import(path.join(CONSOLE, 'work.js'));
    const main = document.createElement('main'); document.body.replaceChildren(main);
    await renderWork(main, { get: vi.fn(async (p: string) => reads[p] || { ok: false, reason: 'no' }) });
    const row = main.querySelector('[data-card="wc_0123456789abcdef"]');
    expect(row.textContent).not.toContain(CHIEF_OF_STAFF_WORDS);
    [...row.querySelectorAll('button')].find((b) => b.textContent === 'Rows: your answer').click();
    expect(document.querySelector('.sheet').textContent).toMatch(/About\s*pull request #3404/);
  });

  it('a card link opens its card every time it is followed, and a refresh does not reopen a closed card', async () => {
    const board = { lanes: [{ lane: 'waiting-on-you', cards: [card()] }, { lane: 'with-agent', cards: [] }, { lane: 'waiting-on-others', cards: [] }, { lane: 'done', cards: [], total: 0 }, { lane: 'archived', cards: [], total: 0 }], waitingOnYou: 1, policy: 'every-agent-card', pickups: null, behind: null, settings: null };
    const reads = { '/work-board': ok(board), '/work/projects': ok({ projects: [] }) };
    const { renderWork } = await import(path.join(CONSOLE, 'work.js'));
    const { closeSheet } = await import(path.join(CONSOLE, 'ui.js'));
    const ctx = { get: vi.fn(async (p: string) => reads[p] || { ok: false, reason: 'no' }) };
    const main = document.createElement('main'); document.body.replaceChildren(main);
    for (let round = 0; round < 2; round++) {
      location.hash = '#/work/board?card=wc_0123456789abcdef';
      await renderWork(main, ctx);
      expect(document.querySelector('.sheet')).toBeTruthy();
      expect(location.hash).toBe('#/work/board');
      closeSheet();
      await renderWork(main, ctx); // the page's own refresh
      expect(document.querySelector('.sheet')).toBeNull();
    }
  });

  it('the Needs-you strip shows the card link beside a linked row, and nothing beside an unlinked one', async () => {
    const { mountNeedsStrip } = await import(path.join(CONSOLE, 'needs-strip.js'));
    const host = document.createElement('section'); document.body.replaceChildren(host);
    const items = [
      { id: 'plan:plan:p1', title: 'Approve the plan', why: 'It waits on you', tone: 'attn', action: { kind: 'href', href: '#/work/plans' }, card: { id: 'wc_00112233445566aa', href: '#/work/board?card=wc_00112233445566aa', label: 'Has a card on the work board' } },
      { id: 'pr:3404', title: 'Review PR 3404', why: 'Checks passed', tone: 'attn', action: { kind: 'href', href: '#/work/prs' } },
    ];
    mountNeedsStrip(host, { get: async () => ok({ complete: true, count: 2, items, couldNotCheck: [] }), hrefFor: (a) => a && a.href });
    for (let i = 0; i < 4; i++) await tick();
    const lis = [...host.querySelectorAll('.needs-rows li')];
    expect(lis[0].querySelector('.needs-card-link').getAttribute('href')).toBe('#/work/board?card=wc_00112233445566aa');
    expect(lis[0].querySelector('.needs-card-link').textContent).toBe('Has a card on the work board');
    expect(lis[0].querySelector('.needs-row').getAttribute('href')).toBe('#/work/plans'); // the row keeps its own action
    expect(lis[1].querySelector('.needs-card-link')).toBeNull();
  });
});
