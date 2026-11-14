/**
 * Console page lifecycle (dashboard-conversations-browser-device.md §4.8 "Lifecycle", Tests:
 * "Console"): late and throwing disposers, a query-only change calling onQuery without rebuilding,
 * a page without onQuery still rebuilding, Home's teardown through onDispose, no duplicate timers
 * after many ticks and switches, and a self-refreshing page never re-run by the 30 s cycle.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { createLifecycle, splitHash } from '../../dashboard/console/page-lifecycle.js';

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

  it('Home\'s own timer is cleared when the operator leaves Home', async () => {
    await boot('#/home');
    expect([...live.values()].filter((ms) => ms === 30_000)).toHaveLength(1);
    await go('#/work');
    expect([...live.values()].filter((ms) => ms === 30_000)).toHaveLength(0);
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
});
