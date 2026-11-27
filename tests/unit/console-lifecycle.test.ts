/**
 * Console page lifecycle (dashboard-conversations-browser-device.md §4.8 "Lifecycle", Tests:
 * "Console"): late and throwing disposers, a query-only change calling onQuery without rebuilding,
 * a page without onQuery still rebuilding, Home's teardown through onDispose, no duplicate timers
 * after many ticks and switches, and a self-refreshing page never re-run by the 30 s cycle.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { createLifecycle, splitHash } from '../../dashboard/console/page-lifecycle.js';
import { AGENT_NOTE_REFRESH_MS } from '../../dashboard/console/agent-health-note.js';

describe('page-lifecycle (pure)', () => {
  it('runs disposers once, in order, before the next visit', () => {
    const lc = createLifecycle();
    const seen: string[] = [];
    const a = lc.begin('work/chats');
    a.onDispose(() => seen.push('a1'));
    a.onDispose(() => seen.push('a2'));
    lc.begin('home');
    expect(seen).toEqual(['a1', 'a2']);
    lc.dispose();
    expect(seen).toEqual(['a1', 'a2']);
  });

  it('a disposer registered after its visit ended runs at once', () => {
    const lc = createLifecycle();
    const a = lc.begin('work/chats');
    lc.begin('home');
    let ran = false;
    a.onDispose(() => { ran = true; });
    expect(ran).toBe(true);
    expect(a.isCurrent()).toBe(false);
  });

  it('a throwing disposer is reported and the others still run', () => {
    const report = vi.fn();
    const lc = createLifecycle({ report });
    const a = lc.begin('x');
    let after = false;
    a.onDispose(() => { throw new Error('boom'); });
    a.onDispose(() => { after = true; });
    expect(() => lc.begin('y')).not.toThrow();
    expect(report).toHaveBeenCalledTimes(1);
    expect(after).toBe(true);
  });

  it('a query-only change goes to onQuery; another path or no onQuery does not', () => {
    const lc = createLifecycle();
    const a = lc.begin('work/chats', '');
    expect(lc.tryQuery('work/chats', 'c=1')).toBe(false); // no onQuery registered
    const got: string[] = [];
    a.onQuery((q: string) => got.push(q));
    expect(lc.tryQuery('work/chats', 'c=1')).toBe(true);
    expect(lc.tryQuery('work/chats', 'c=1')).toBe(true); // same query: nothing to do
    expect(lc.tryQuery('work/sessions', 'c=1')).toBe(false);
    expect(got).toEqual(['c=1']);
  });

  it('a throwing onQuery falls back to a rebuild', () => {
    const lc = createLifecycle({ report: () => {} });
    const a = lc.begin('p', 'a');
    a.onQuery(() => { throw new Error('x'); });
    expect(lc.tryQuery('p', 'b')).toBe(false);
  });

  it('self-refreshing is per visit', () => {
    const lc = createLifecycle();
    const a = lc.begin('p');
    a.selfRefreshing();
    expect(lc.isSelfRefreshing()).toBe(true);
    lc.begin('q');
    expect(lc.isSelfRefreshing()).toBe(false);
  });

  it('awaits reconnect in place without disposing the composer visit', async () => {
    const lc = createLifecycle();
    const visit = lc.begin('work/chats');
    const dispose = vi.fn(); visit.onDispose(dispose);
    let finish!: () => void;
    visit.onReconnect(() => new Promise<void>((resolve) => { finish = resolve; }));
    const work = lc.reconnectCurrent();
    expect(visit.isCurrent()).toBe(true);
    expect(dispose).not.toHaveBeenCalled();
    finish(); expect(await work).toBe(true);
    expect(visit.isCurrent()).toBe(true);
  });

  it('does not report success for a reconnect belonging to a disposed visit', async () => {
    const lc = createLifecycle();
    const visit = lc.begin('work/chats');
    let finish!: () => void;
    visit.onReconnect(() => new Promise<void>((resolve) => { finish = resolve; }));
    const work = lc.reconnectCurrent(); lc.begin('work'); finish();
    expect(await work).toBe(false);
    expect(await lc.reconnectCurrent()).toBeNull();
  });

  it('reports a failed reconnect without throwing or rebuilding', async () => {
    const report = vi.fn(); const lc = createLifecycle({ report });
    const visit = lc.begin('work/chats');
    visit.onReconnect(async () => { throw new Error('history could not be read'); });
    expect(await lc.reconnectCurrent()).toBe(false);
    expect(report).toHaveBeenCalledTimes(1);
    expect(visit.isCurrent()).toBe(true);
  });

  it('splits the hash', () => {
    expect(splitHash('#/work/chats?c=app%3Ax')).toEqual({ path: 'work/chats', query: 'c=app%3Ax' });
    expect(splitHash('')).toEqual({ path: 'home', query: '' });
  });
});

// ── console.js in jsdom ──────────────────────────────────────────────────────
const NOW = new Date().toISOString();
const ROUTES: Record<string, unknown> = {
  '/sessions': { sessions: [] },
  '/health': { project: { name: 'echo' } },
  '/attention?scope=pool&status=OPEN': { items: [], pool: { failed: [] } },
  '/commitments?scope=mesh': { enabled: true, scope: 'mesh', commitments: [] },
  '/sessions?scope=pool': { sessions: [{ name: 'S', status: 'running', startedAt: NOW, machineNickname: 'Mac' }], pool: { failed: [] } },
  '/telegram/topics?scope=pool': { topics: [], pool: { failed: [], unresolved: [] } },
  '/pool': { machines: [] },
  '/guards': { guards: [] },
  '/mandate': { mandates: [] },
};

let dom: JSDOM;
const live = new Map<unknown, number>(); // interval handle → delay
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
const flush = () => new Promise((r) => setTimeout(r, 30));

async function boot(hash: string, extra: Record<string, unknown> = {}) {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: `http://localhost:4040/dashboard/console/${hash}` });
  const g = globalThis as Record<string, unknown>;
  Object.assign(g, { window: dom.window, document: dom.window.document, location: dom.window.location, history: dom.window.history, localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage });
  g.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(cb, 0);
  dom.window.localStorage.setItem('instar_token', 't');
  g.setInterval = ((fn: () => void, ms: number) => { const h = realSetInterval(fn, ms); live.set(h, ms); return h; }) as typeof setInterval;
  g.clearInterval = ((h: unknown) => { live.delete(h); realClearInterval(h as never); }) as typeof clearInterval;
  const routes = { ...ROUTES, ...extra };
  g.fetch = async (url: string) => {
    const body = routes[url];
    if (body === undefined) return { ok: false, status: 404, json: async () => ({}), headers: new dom.window.Headers() } as unknown as Response;
    if (typeof body === 'number') return { ok: false, status: body, json: async () => ({}), headers: new dom.window.Headers() } as unknown as Response;
    return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)), headers: new dom.window.Headers() } as unknown as Response;
  };
  vi.resetModules();
  await import('../../dashboard/console/console.js');
  for (let i = 0; i < 8; i++) await flush();
  return dom.window.document;
}
async function go(hash: string) {
  dom.window.location.hash = hash;
  dom.window.dispatchEvent(new dom.window.HashChangeEvent('hashchange'));
  for (let i = 0; i < 4; i++) await flush();
}

afterEach(() => {
  for (const h of live.keys()) realClearInterval(h as never);
  live.clear();
  (globalThis as Record<string, unknown>).setInterval = realSetInterval;
  (globalThis as Record<string, unknown>).clearInterval = realClearInterval;
  dom?.window.close();
});

describe('console routing lifecycle (jsdom)', () => {
  it('leaves at most one 30 s refresh timer after many switches', async () => {
    await boot('#/home');
    for (let i = 0; i < 6; i++) {
      await go('#/work');
      await go('#/work/promises');
      await go('#/home');
      await go('#/capacity/machines');
    }
    const refresh = [...live.values()].filter((ms) => ms === 30_000);
    expect(refresh.length).toBeLessThanOrEqual(1);
  });

  it('Home\'s own timer is cleared when the operator leaves Home (phone mode: the app frame still shows Home)', async () => {
    await boot('#/home?phone=1');
    expect([...live.values()].filter((ms) => ms === 30_000)).toHaveLength(1);
    await go('#/work?phone=1');
    expect([...live.values()].filter((ms) => ms === 30_000)).toHaveLength(0);
  });

  it('the Needs-you strip keeps one refresh timer across many door changes (work-front-doors decision 2)', async () => {
    await boot('#/work/chats');
    for (let i = 0; i < 6; i++) { await go('#/work/board'); await go('#/agent'); await go('#/work/chats'); }
    expect([...live.values()].filter((ms) => ms === 45_000).length).toBeLessThanOrEqual(1);
  });

  it('the Agent door\'s status dot keeps one refresh timer of its own across many door changes', async () => {
    await boot('#/work/chats');
    for (let i = 0; i < 6; i++) { await go('#/work/board'); await go('#/agent'); await go('#/work/chats'); }
    expect([...live.values()].filter((ms) => ms === AGENT_NOTE_REFRESH_MS).length).toBe(1);
  });

  it('Home lands on the Conversations door on the web console', async () => {
    const doc = await boot('#/home');
    expect(doc.defaultView!.location.hash).toMatch(/^#\/work\/(chats|conversations)$/);
  });

  it('a query-only change on a page without onQuery rebuilds it', async () => {
    const doc = await boot('#/work/promises');
    const before = doc.querySelector('main');
    await go('#/work/promises?x=1');
    expect(doc.querySelector('main')).not.toBe(before);
  });

  it('Conversations is self-refreshing (no 30 s cycle) and a query-only change keeps the page', async () => {
    const doc = await boot('#/work/chats', { '/mobile/browser-devices/status': 503 });
    expect(doc.body.textContent).toContain('Conversations in the dashboard are switched off on this agent.');
    expect([...live.values()].filter((ms) => ms === 30_000)).toHaveLength(0);
    const main = doc.querySelector('main');
    await go('#/work/chats?c=telegram%3A1');
    expect(doc.querySelector('main')).toBe(main);
  });

  it('the Work page shows the Conversations tile only when the probe answers', async () => {
    let doc = await boot('#/work', { '/mobile/browser-devices/status': 503 });
    const tile = () => [...doc.querySelectorAll('a.tile')].find((a) => a.getAttribute('href') === '#/work/chats');
    expect(tile()?.closest('[hidden]')).toBeTruthy();
    dom.window.close();
    doc = await boot('#/work', { '/mobile/browser-devices/status': { enabled: true, machineId: 'm1' } });
    expect(tile()).toBeTruthy();
    expect(tile()?.closest('[hidden]')).toBeFalsy();
  });
  it('removes stale conversation content and local legacy copies on a sibling logout without adopting its new sign-in', async () => {
    const doc = await boot('#/work/chats', { '/mobile/browser-devices/status': 503 });
    const { UNFINISHED_KEY } = await import('../../dashboard/console/chats-model.js');
    dom.window.sessionStorage.setItem(UNFINISHED_KEY, JSON.stringify([{ text: 'private pending text' }]));
    const old = doc.createElement('p'); old.textContent = 'old conversation plaintext'; doc.body.append(old);
    dom.window.localStorage.removeItem('instar_token');
    dom.window.dispatchEvent(new dom.window.StorageEvent('storage', { key: 'instar_token', oldValue: 't', newValue: null }));
    expect(doc.body.textContent).not.toContain('old conversation plaintext');
    expect(dom.window.sessionStorage.getItem(UNFINISHED_KEY)).toBeNull();
    for (let i = 0; i < 4; i++) await flush();
    expect(doc.body.textContent).toContain('signed out in another tab');
    dom.window.localStorage.setItem('instar_token', 'new-sibling-token');
    dom.window.dispatchEvent(new dom.window.StorageEvent('storage', { key: 'instar_token', oldValue: null, newValue: 'new-sibling-token' }));
    await go('#/work');
    expect(doc.body.textContent).toContain('signed out in another tab');
    expect(doc.querySelector('main#main')).toBeNull();
  });

  it('a resumed tab checks the current stored sign-in before keeping its previous page', async () => {
    const doc = await boot('#/work/chats', { '/mobile/browser-devices/status': 503 });
    const old = doc.createElement('p'); old.textContent = 'resumed old conversation'; doc.body.append(old);
    dom.window.localStorage.setItem('instar_token', 'different-sign-in');
    dom.window.dispatchEvent(new dom.window.PageTransitionEvent('pageshow'));
    expect(doc.body.textContent).not.toContain('resumed old conversation');
    for (let i = 0; i < 4; i++) await flush();
    expect(doc.body.textContent).toContain('signed out in another tab');
    expect(dom.window.localStorage.getItem('instar_token')).toBe('different-sign-in');
  });

  it('a paused sibling stays signed out even when another PIN unlock restores the same bearer', async () => {
    const doc = await boot('#/work/chats', { '/mobile/browser-devices/status': 503 });
    const { UNFINISHED_KEY } = await import('../../dashboard/console/chats-model.js');
    dom.window.sessionStorage.setItem(UNFINISHED_KEY, JSON.stringify([{ text: 'old private copy' }]));
    const old = doc.createElement('p'); old.textContent = 'paused plaintext'; doc.body.append(old);
    // No storage events: simulate a suspended tab returning after logout AND a new sign-in.
    dom.window.localStorage.setItem('instar_console_logout_fence', 'later-explicit-logout');
    dom.window.localStorage.setItem('instar_token', 't');
    dom.window.dispatchEvent(new dom.window.PageTransitionEvent('pageshow'));
    expect(doc.body.textContent).not.toContain('paused plaintext');
    expect(dom.window.sessionStorage.getItem(UNFINISHED_KEY)).toBeNull();
    for (let i = 0; i < 4; i++) await flush();
    expect(doc.body.textContent).toContain('signed out in another tab');
  });

});
