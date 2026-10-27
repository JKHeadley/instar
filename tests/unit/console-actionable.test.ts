/**
 * Every Ask Is Actionable — the console side (dashboard/console/shared-counts.js,
 * actions.js and the pages that list needs-you items).
 *
 * The invariant: every item the console counts as needing the operator carries one
 * tap (approve in place, or a deep link to the exact place); an item for which no tap
 * can be built is NOT counted — it is reported as the agent's (`agentOwned`) and shown
 * with the agent's work, never dropped. Both sides of each decision are tested, then
 * the shipped console is booted in jsdom to check the buttons render and act.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  isActionable, deepLink, attentionNeeds, promiseNeed, accountNeeds, accountAction, prsNeedingYou, prAction, needsYou,
} from '../../dashboard/console/shared-counts.js';
import { combineNeeds, withAgentOwned, buildNeeds, buildPromised } from '../../dashboard/console/home-model.js';

const NOW = Date.parse('2026-10-26T20:00:00Z');
const iso = (minsAgo: number) => new Date(NOW - minsAgo * 60000).toISOString();
const OPEN = { kind: 'open', href: '#/capacity/accounts?s=needs&item=x', label: 'Open sign-in' };

describe('isActionable: what counts as one tap', () => {
  it('accepts a console deep link, a GitHub review link and an in-place approval', () => {
    expect(isActionable(OPEN)).toBe(true);
    expect(isActionable({ kind: 'open', external: true, href: 'https://github.com/JKHeadley/instar/pull/2377/files', label: 'Review on GitHub' })).toBe(true);
    expect(isActionable({ kind: 'approve', path: '/subscription-relogin/repair-cell', body: { a: 1 }, label: 'Approve repair' })).toBe(true);
  });
  it('refuses anything else: no label, foreign or script links, a non-GitHub external link, an unknown kind', () => {
    expect(isActionable(null)).toBe(false);
    expect(isActionable({ kind: 'open', href: '#/home', label: '' })).toBe(false);
    expect(isActionable({ kind: 'open', href: 'javascript:alert(1)', label: 'Go' })).toBe(false);
    expect(isActionable({ kind: 'open', href: 'https://evil.example/x', label: 'Go' })).toBe(false);
    expect(isActionable({ kind: 'open', external: true, href: 'https://evil.example/pull/1', label: 'Go' })).toBe(false);
    expect(isActionable({ kind: 'approve', path: 'https://x/y', label: 'Go' })).toBe(false);
    expect(isActionable({ kind: 'shout', label: 'Go' })).toBe(false);
  });
  it('deepLink encodes values', () => {
    expect(deepLink('work/promises', { s: 'waiting', item: 'cm:1 2' })).toBe('#/work/promises?s=waiting&item=cm%3A1%202');
  });
});

describe('each needs-you kind carries its one tap', () => {
  it('attention: the action the server stamped; none ⇒ null', () => {
    const items = [
      { id: 'a1', title: 'Approve the deploy', status: 'OPEN', priority: 'HIGH', source: 'agent', createdAt: iso(4), action: OPEN },
      { id: 'a2', title: 'Something I raised', status: 'OPEN', priority: 'HIGH', source: 'agent', createdAt: iso(5), action: null },
    ];
    const all = attentionNeeds(items, NOW).all;
    expect(all.find((g) => g.ids.includes('a1'))!.action).toEqual(OPEN);
    expect(all.find((g) => g.ids.includes('a2'))!.action).toBeNull();
  });
  it('promise: Answer opens that exact promise; an approval says so', () => {
    const c = { id: 'cm-7', status: 'pending', owner: 'user', blockedOn: 'user-input', agentResponse: 'I will merge it once you answer', createdAt: iso(10) };
    expect(promiseNeed(c, NOW).action).toEqual({ kind: 'open', href: '#/work/promises?s=waiting&item=cm-7', label: 'Answer' });
    expect(promiseNeed({ ...c, blockedOn: 'user-authorization' }, NOW).action.label).toBe('Open to approve');
  });
  it('sign-in repair waiting for a tap is approved in place (PIN sheet); a repair the agent runs has no tap and is not counted', () => {
    const rows = [
      { id: 'dawn', machineId: 'm2', machineNickname: 'Mama PC', status: 'needs-reauth', nickname: 'Dawn' },
      { id: 'luna', machineId: 'm1', machineNickname: 'Mac Studio', status: 'needs-reauth', nickname: 'Luna' },
    ];
    const episodes = [
      { id: 'ep1', accountId: 'dawn', machineId: 'm2', state: 'suggested', updatedAt: iso(3) },
      { id: 'ep2', accountId: 'luna', machineId: 'm1', state: 'browser-driving', updatedAt: iso(2) },
    ];
    const n = accountNeeds(rows, episodes, { now: NOW });
    expect(n.tap).toHaveLength(1);
    expect(n.tap[0].action).toMatchObject({ kind: 'approve', path: '/subscription-relogin/repair-cell', pin: 'session', label: 'Approve repair',
      body: { accountId: 'dawn', machineId: 'm2', episodeId: 'ep1', action: 'approve' } });
    expect(n.tap[0].action.confirm).toMatch(/Mama PC/);
    expect(n.expired[0].action).toBeNull();
    expect(accountAction({ id: 'dawn', machineId: 'm2' }, null, 'Mama PC')).toEqual({ kind: 'open', label: 'Open sign-in', href: '#/capacity/accounts?s=needs&item=dawn%3Am2' });
  });
  it('PR waiting on the code-owner review: GitHub "Files changed" in a new tab; without the repo, its row on Development', () => {
    const w = { configuration: { repo: 'JKHeadley/instar' }, snapshot: { at: NOW, entries: [{ pr: 2377, kind: 'code-owner-review' }, { pr: 2380, kind: 'mergeable' }] }, episodes: [] };
    const prs = prsNeedingYou(w, NOW);
    expect(prs.map((p) => p.pr)).toEqual([2377]);
    expect(prs[0].action).toEqual({ kind: 'open', external: true, label: 'Review on GitHub', href: 'https://github.com/JKHeadley/instar/pull/2377/files' });
    expect(prAction(null, 2377)).toEqual({ kind: 'open', label: 'Open', href: '#/work/development?s=shipping&item=2377' });
    expect(prAction('JKHeadley/instar', 0)).toBeNull();
  });
});

describe('THE invariant: no action ⇒ not needs-you (and never dropped)', () => {
  const src = (items: unknown[]) => ({ state: 'ok', items });
  it('every counted item is actionable; the rest are the agent’s', () => {
    const attention = attentionNeeds([
      { id: 'a1', title: 'Approve the deploy', status: 'OPEN', priority: 'HIGH', source: 'agent', createdAt: iso(4), action: OPEN },
      { id: 'a2', title: 'Kernel memory is high', status: 'OPEN', priority: 'HIGH', source: 'agent', createdAt: iso(6), action: null },
      { id: 'a3', title: 'From an older server', status: 'OPEN', priority: 'URGENT', createdAt: iso(7) },
    ], NOW).all;
    const promise = promiseNeed({ id: 'cm-1', status: 'pending', owner: 'user', agentResponse: 'I will ship it after you answer', createdAt: iso(9) }, NOW);
    const noIdPromise = { ...promiseNeed({ id: 'cm-2', status: 'pending', owner: 'user', agentResponse: 'Waiting', createdAt: iso(9) }, NOW), key: 'promise:own:none', action: null };
    const prs = prsNeedingYou({ configuration: { repo: 'JKHeadley/instar' }, snapshot: { at: NOW, entries: [{ pr: 9, kind: 'code-owner-review' }] } }, NOW);
    const list = needsYou({ attention: src(attention), promises: src([promise, noIdPromise]), accounts: src([]), prs: src(prs) }, NOW);
    expect(list.count).toBe(3);
    for (const it of [...list.items, ...list.stale]) expect(isActionable(it.action)).toBe(true);
    expect(list.agentOwned.map((x: { main: string }) => x.main).sort()).toEqual(['From an older server', 'Kernel memory is high', 'Waiting'].sort());
    expect(list.agentOwned.every((x: { action: unknown }) => x.action === null)).toBe(true);
  });
  it('a promise folded into an actionable host keeps the host’s tap', () => {
    const attention = attentionNeeds([{ id: 'agent:cleanup', title: 'Approve the cleanup', status: 'OPEN', priority: 'HIGH', source: 'agent', createdAt: iso(4), action: OPEN }], NOW).all;
    const p = promiseNeed({ id: 'cm-3', status: 'pending', owner: 'user', agentResponse: 'I will clean up after you approve attention item agent:cleanup', createdAt: iso(8) }, NOW);
    const list = needsYou({ attention: src(attention), promises: src([p]), accounts: src([]), prs: src([]) }, NOW);
    expect(list.count).toBe(1);
    expect(list.items[0].action).toEqual(OPEN);
    expect(list.items[0].also).toHaveLength(1);
  });
  it('Home carries the agent’s items to “What I’m doing”, one tap deeper, and does not count them', () => {
    const attn = buildNeeds({ ok: true, data: { items: [{ id: 'k', title: 'Kernel memory is high', status: 'OPEN', priority: 'HIGH', source: 'agent', createdAt: iso(3), action: null }], pool: { failed: [] } } }, NOW);
    const prom = buildPromised({ ok: true, data: { enabled: true, scope: 'mesh', commitments: [] } }, NOW, 0);
    const card = combineNeeds(attn, prom, {});
    expect(card.count).toBe(0);
    expect(card.agentOwned).toHaveLength(1);
    const doing = withAgentOwned({ state: 'ok', value: 'Idle', rows: [] }, card.agentOwned);
    expect(doing.details.join('\n')).toMatch(/1 notice I'm handling myself \(nothing for you to tap\):\n· Kernel memory is high/);
    expect(withAgentOwned({ state: 'ok', value: 'Idle', rows: [] }, [])).toEqual({ state: 'ok', value: 'Idle', rows: [] });
  });
});

// ── the shipped console in jsdom ───────────────────────────────────────────
const T = new Date().toISOString();
let dom: JSDOM;
const flush = () => new Promise((r) => setTimeout(r, 30));
type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

function routes(): Record<string, unknown> {
  return {
    '/sessions': { sessions: [] },
    '/health': { project: { name: 'echo' } },
    '/attention?scope=pool': { items: [
      { id: 'agent:approve-deploy', title: 'Approve the deploy', status: 'OPEN', priority: 'HIGH', source: 'agent', createdAt: T, action: { kind: 'open', href: '#/settings/allowed?s=guards&item=agent%3Aapprove-deploy', label: 'Open safety checks' } },
      { id: 'agent:kmem', title: 'Kernel memory is high', status: 'OPEN', priority: 'HIGH', source: 'agent', createdAt: T, action: null },
    ], pool: { failed: [] } },
    '/commitments?scope=mesh': { enabled: true, scope: 'mesh', commitments: [{ id: 'cm-9', status: 'pending', owner: 'user', blockedOn: 'user-input', agentResponse: 'I will ship the fix once you answer', createdAt: T, topicId: 77 }] },
    '/sessions?scope=pool': { sessions: [], pool: { failed: [] } },
    '/pool': { machines: [{ machineId: 'm1', nickname: 'Mac Studio', isSelf: true, online: true, routerReceivedAt: T, servesChannels: { telegram: { chatIds: ['-100123'] } } }], selfMachineId: 'm1' },
    '/guards': { guards: [] },
    '/mandate': { mandates: [] },
    '/subscription-pool?scope=pool': { enabled: true, accounts: [{ id: 'dawn', machineId: 'm1', machineNickname: 'Mac Studio', status: 'needs-reauth', nickname: 'Dawn' }] },
    '/subscription-relogin?scope=pool': { episodes: [{ id: 'ep1', accountId: 'dawn', machineId: 'm1', state: 'suggested', updatedAt: T }] },
    '/green-pr-automerge': { configuration: { repo: 'JKHeadley/instar' }, snapshot: { at: Date.now(), entries: [{ pr: 2377, kind: 'code-owner-review' }] }, episodes: [] },
  };
}

async function boot(hash: string, calls: Call[] = []) {
  const ROUTES = routes();
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: `http://localhost:4040/dashboard/console/${hash}` });
  const g = globalThis as Record<string, unknown>;
  Object.assign(g, { window: dom.window, document: dom.window.document, location: dom.window.location, history: dom.window.history, localStorage: dom.window.localStorage, requestAnimationFrame: (f: () => void) => setTimeout(f, 0) });
  dom.window.localStorage.setItem('instar_token', 't');
  (dom.window.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
  g.fetch = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    const method = init.method || 'GET';
    if (method !== 'GET') {
      calls.push({ url, method, headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null });
      if (url === '/dashboard/unlock') return { ok: true, status: 200, json: async () => ({ operatorSessionToken: 'op-1', operatorSessionExpiresAt: new Date(Date.now() + 600000).toISOString() }) } as unknown as Response;
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
    }
    const body = ROUTES[url];
    if (body === undefined) return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) } as unknown as Response;
  };
  vi.resetModules();
  await import('../../dashboard/console/console.js');
  for (let i = 0; i < 12; i++) await flush();
  return dom.window.document;
}

afterEach(() => { dom?.window.close(); });

describe('the buttons, rendered (jsdom)', () => {
  it('Home: every needs-you row carries its one tap; the headline counts only actionable items', async () => {
    const doc = await boot('#/home');
    const card = doc.querySelector('#card-needs')!;
    card.querySelector<HTMLButtonElement>('.card-foot .link-btn')?.click();   // See all
    await flush();
    const acts = [...card.querySelectorAll('.row-action')].map((n) => n.querySelector('a,button')!);
    const byLabel = Object.fromEntries(acts.map((a) => [a.textContent, a]));
    expect(Object.keys(byLabel).sort()).toEqual(['Answer', 'Approve repair', 'Open safety checks', 'Review on GitHub'].sort());
    expect((byLabel['Review on GitHub'] as HTMLAnchorElement).getAttribute('href')).toBe('https://github.com/JKHeadley/instar/pull/2377/files');
    expect((byLabel['Review on GitHub'] as HTMLAnchorElement).getAttribute('target')).toBe('_blank');
    expect((byLabel['Answer'] as HTMLAnchorElement).getAttribute('href')).toBe('#/work/promises?s=waiting&item=cm-9');
    expect(doc.querySelector('#heroTitle')!.textContent).toBe('4 things need you.');
    // The kernel-memory notice has no tap: it is not counted, and it is listed with my work.
    expect(card.textContent).not.toContain('Kernel memory');
    expect(doc.querySelector('#card-doing')!.textContent).toContain('Kernel memory is high');
  });

  it('Approve repair: confirm, then the existing PIN sheet, then the POST with the operator session', async () => {
    const calls: Call[] = [];
    const doc = await boot('#/home', calls);
    const card = doc.querySelector('#card-needs')!;
    card.querySelector<HTMLButtonElement>('.card-foot .link-btn')?.click();
    await flush();
    const btn = [...card.querySelectorAll<HTMLButtonElement>('.row-action button')].find((b) => b.textContent === 'Approve repair')!;
    btn.click();
    const yes = [...card.querySelectorAll<HTMLButtonElement>('.need-confirm button')].find((b) => b.textContent === 'Approve repair')!;
    expect(card.querySelector('.need-confirm .confirm-text')!.textContent).toMatch(/Dawn on Mac Studio/);
    yes.click();
    await flush();
    const pin = doc.querySelector<HTMLInputElement>('.sheet .pin-input')!;
    expect(pin).not.toBeNull();
    pin.value = '123456';
    doc.querySelector<HTMLFormElement>('.sheet .pin-form')!.dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    for (let i = 0; i < 4; i++) await flush();
    const post = calls.find((c) => c.url === '/subscription-relogin/repair-cell')!;
    expect(post).toBeDefined();
    expect(post.headers['X-Instar-Operator-Session']).toBe('op-1');
    expect(post.body).toEqual({ accountId: 'dawn', machineId: 'm1', episodeId: 'ep1', action: 'approve' });
    expect(card.textContent).toContain('The repair is running on Mac Studio.');
  });

  it('a deep link opens the exact promise’s sheet, then leaves the address without the item', async () => {
    const doc = await boot('#/work/promises?s=waiting&item=cm-9');
    const sheet = doc.querySelector('.sheet')!;
    expect(sheet).not.toBeNull();
    expect(sheet.textContent).toContain('Open the conversation');
    expect(dom.window.location.hash).toBe('#/work/promises?s=waiting');
    // The waiting row on the page carries the same tap Home shows.
    expect(doc.querySelector('#sec-waiting .row-action a')!.textContent).toBe('Answer');
  });

  it('a sign-in deep link lands on its row on Accounts, whose button is the same in-place approval', async () => {
    const doc = await boot('#/capacity/accounts?s=needs&item=dawn%3Am1');
    const row = doc.querySelector('[data-item="dawn:m1"]')!;
    expect(row).not.toBeNull();
    expect(row.classList.contains('landed')).toBe(true);
    expect(row.querySelector('button')!.textContent).toBe('Approve repair');
  });
});
