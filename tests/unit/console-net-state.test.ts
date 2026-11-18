/**
 * The console on a weak or missing connection (docs/specs/app-weak-network.md):
 * saved status reads show at once when the agent cannot be reached, a page that is
 * merely slow on a good connection keeps waiting for the real answer, the top line
 * says plainly how old what is shown is, sends fail at once when the device is
 * offline, and private reads are never saved.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createNetState, isStorable, requestPath, lineText, whenWords, signInTag, frontCouldNotReach, bearerOf,
  FIRST_TRY_MS, SLOW_LINE_MS, KEEP_MS, RETRY_STEPS_MS,
} from '../../dashboard/console/net-state.js';

import { signInAtBoot, validToken } from '../../dashboard/console/ticket-model.js';

const ORIGIN = 'https://agent.example';

function memStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
    get length() { return m.size; },
    key: (i: number) => [...m.keys()][i] ?? null,
    map: m,
  };
}
const G = { headers: { Authorization: 'Bearer tok-1' } };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

type Behaviour = 'ok' | 'down' | 'hang';
function rig(opts: { online?: boolean } = {}) {
  let online = opts.online ?? true;
  let api: Behaviour = 'ok';
  let health: Behaviour = 'ok';
  let answer: unknown = { items: [{ id: 'a' }] };
  let apiStatus = 200;
  let token = 'tok-1';
  const calls: string[] = [];
  const respond = (b: Behaviour, body: () => Response, init?: RequestInit) => {
    if (b === 'ok') return Promise.resolve(body());
    if (b === 'down') return Promise.reject(new TypeError('Failed to fetch'));
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
  };
  const fetchFn = vi.fn((input: string, init?: RequestInit) => {
    calls.push(`${(init?.method || 'GET')} ${input}`);
    if (input === '/health') return respond(health, () => json({ status: 'ok' }), init);
    return respond(api, () => json(answer, apiStatus), init);
  });
  const storage = memStorage();
  const onChange = vi.fn();
  const onBack = vi.fn();
  const net = createNetState({
    fetchFn, storage, origin: ORIGIN, isOnline: () => online, getToken: () => token, onChange, onBack,
  });
  return {
    net, fetchFn, storage, onChange, onBack, calls,
    set: (o: { online?: boolean; api?: Behaviour; health?: Behaviour; answer?: unknown; apiStatus?: number; token?: string }) => {
      if (o.apiStatus !== undefined) apiStatus = o.apiStatus;
      if (o.token !== undefined) token = o.token;
      if (o.online !== undefined) online = o.online;
      if (o.api) api = o.api;
      if (o.health) health = o.health;
      if ('answer' in o) answer = o.answer;
    },
  };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 10, 16, 13, 52, 0)); });
afterEach(() => { vi.useRealTimers(); });

describe('console boot with a stored sign-in and an empty response cache', () => {
  it.each([502, 504, 522])('keeps the stored sign-in and reports a weak connection on HTTP %i', async (apiStatus) => {
    const { net, set } = rig();
    set({ apiStatus });
    expect(await signInAtBoot({ storedToken: 'tok-1', ticket: '', fetchFn: net.fetch })).toEqual({ via: 'stored', token: 'tok-1' });
    expect(lineText(net.state(), Date.now())).toContain('Still trying to reach the agent');
    expect(await validToken('typed', false, net.fetch)).toBe(false);
  });

  it.each([
    ['a network exception', { api: 'down' as Behaviour }],
    ['an offline device', { online: false }],
  ])('keeps the stored sign-in on %s and still refuses a typed token', async (_label, state) => {
    const { net, set } = rig();
    set(state);
    expect(await signInAtBoot({ storedToken: 'tok-1', ticket: '', fetchFn: net.fetch })).toEqual({ via: 'stored', token: 'tok-1' });
    expect(await validToken('typed', false, net.fetch)).toBe(false);
  });

  it.each([401, 403, 503])('does not preserve the stored sign-in on an agent response of %i', async (apiStatus) => {
    const { net, set } = rig();
    set({ apiStatus });
    expect(await signInAtBoot({ storedToken: 'tok-1', ticket: '', fetchFn: net.fetch })).toEqual({ via: 'pin', token: '' });
  });

  it('requires a live success for a typed token even when a previous read was saved', async () => {
    const { net, set } = rig();
    expect(await validToken('tok-1', false, net.fetch)).toBe(true);
    set({ apiStatus: 502 });
    expect(await validToken('tok-1', false, net.fetch)).toBe(false);
  });
});

describe('which reads are saved', () => {
  it('saves allowlisted status reads only', () => {
    expect(isStorable('/needs', G)).toBe(true);
    expect(isStorable('/work/projects', G)).toBe(true);
    expect(isStorable('/commitments?scope=mesh', G)).toBe(true);
    expect(isStorable('/local-verify', G)).toBe(true);
    expect(isStorable('/needs', {})).toBe(false); // no sign-in on the request, nothing saved
  });
  it('never saves conversations, topic names, secrets or people', () => {
    for (const p of ['/telegram/topics', '/conversation-graph/nodes/x', '/threadline/threads/1', '/secrets/pending', '/team/people', '/preferences', '/subscription-pool']) {
      expect(isStorable(p, G), p).toBe(false);
    }
  });
  it('never saves a send or a read made with the PIN (operator session)', () => {
    expect(isStorable('/needs', { ...G, method: 'POST' })).toBe(false);
    expect(isStorable('/needs', { headers: { 'X-Instar-Operator-Session': 's' } })).toBe(false);
    expect(isStorable('/needs', { headers: new Headers({ 'x-instar-operator-session': 's' }) })).toBe(false);
  });
  it('reads only same-origin paths', () => {
    expect(requestPath('/needs?x=1', ORIGIN)).toBe('/needs?x=1');
    expect(requestPath('https://elsewhere.example/needs', ORIGIN)).toBeNull();
  });
});

describe('the top line', () => {
  const now = new Date(2026, 10, 16, 14, 30).getTime();
  it('is empty when the connection is fine', () => {
    expect(lineText({ mode: 'fresh', shownAt: null }, now)).toBe('');
  });
  it('says offline and the time of what is shown', () => {
    expect(lineText({ mode: 'offline', shownAt: new Date(2026, 10, 16, 13, 52).getTime() }, now)).toBe('Offline. Showing what I had at 1:52 pm.');
  });
  it('says weak connection and that it is trying again', () => {
    expect(lineText({ mode: 'weak', shownAt: new Date(2026, 10, 16, 13, 52).getTime() }, now)).toBe('Weak connection. Showing what I had at 1:52 pm. Trying again.');
  });
  it('says plainly when nothing is saved', () => {
    expect(lineText({ mode: 'offline', shownAt: null }, now)).toMatch(/^Offline\. Nothing saved on this device yet\./);
    expect(lineText({ mode: 'weak', shownAt: null }, now)).toBe('Weak connection. Still trying to reach the agent.');
  });
  it('names yesterday and older days', () => {
    expect(whenWords(new Date(2026, 10, 15, 18, 10).getTime(), now)).toBe('yesterday 6:10 pm');
    expect(whenWords(new Date(2026, 10, 14, 18, 10).getTime(), now)).toBe('Nov 14, 6:10 pm');
  });
});

describe('reading on a weak or missing connection', () => {
  it('saves a good answer and shows it at once when the device is offline', async () => {
    const r = rig();
    await (await r.net.fetch('/needs', G)).json();
    vi.setSystemTime(new Date(2026, 10, 16, 14, 30));
    r.set({ online: false });
    const before = r.fetchFn.mock.calls.length;
    const res = await r.net.fetch('/needs', G);
    expect(await res.json()).toEqual({ items: [{ id: 'a' }] });
    expect(res.headers.get('X-Instar-Saved-At')).toBe(String(new Date(2026, 10, 16, 13, 52).getTime()));
    expect(r.fetchFn.mock.calls.length).toBe(before); // no network wait at all
    expect(r.net.state()).toEqual({ mode: 'offline', shownAt: new Date(2026, 10, 16, 13, 52).getTime() });
    expect(lineText(r.net.state(), Date.now())).toBe('Offline. Showing what I had at 1:52 pm.');
  });

  it('fails at once offline when nothing is saved (no 40 s placeholder)', async () => {
    const r = rig({ online: false });
    await expect(r.net.fetch('/needs', G)).rejects.toThrow(/Offline/);
    expect(r.fetchFn).not.toHaveBeenCalled();
    expect(r.net.state().mode).toBe('offline');
  });

  it('shows the saved copy within the first try when the agent cannot be reached', async () => {
    const r = rig();
    await r.net.fetch('/needs', G);
    r.set({ api: 'hang', health: 'hang' });
    const p = r.net.fetch('/needs', G);
    await vi.advanceTimersByTimeAsync(FIRST_TRY_MS + 3000 + 10); // first try, then the 3 s reachability check
    const res = await p;
    expect(res.headers.get('X-Instar-Saved-At')).not.toBeNull();
    expect(r.net.state().mode).toBe('weak');
  });

  it('shows the saved copy at once when the connection drops mid-read', async () => {
    const r = rig();
    await r.net.fetch('/needs', G);
    r.set({ api: 'down' });
    const res = await r.net.fetch('/needs', G);
    expect(res.headers.get('X-Instar-Saved-At')).not.toBeNull();
    expect(r.net.state().mode).toBe('weak');
  });

  it('keeps waiting for the real answer when the page is just slow on a good connection', async () => {
    const r = rig();
    await r.net.fetch('/needs', G);
    r.set({ api: 'hang', health: 'ok' });
    const p = r.net.fetch('/needs', G);
    let done = false; p.then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(FIRST_TRY_MS + 100);
    expect(done).toBe(false); // not replaced by the saved copy
    expect(r.net.state().mode).toBe('fresh'); // and no "weak connection" line
  });

  it('says "still trying" past SLOW_LINE_MS when nothing is saved and the agent cannot be reached', async () => {
    const r = rig();
    r.set({ api: 'hang', health: 'hang' });
    r.net.fetch('/needs', G).catch(() => {});
    await vi.advanceTimersByTimeAsync(SLOW_LINE_MS + 3000 + 10);
    expect(r.net.state()).toEqual({ mode: 'weak', shownAt: null });
  });

  it('checks again in the background and re-reads the page once the agent answers', async () => {
    const r = rig();
    await r.net.fetch('/needs', G);
    r.set({ online: false });
    await r.net.fetch('/needs', G);
    expect(r.onBack).not.toHaveBeenCalled();
    r.set({ online: true });
    await vi.advanceTimersByTimeAsync(RETRY_STEPS_MS[0] + 10);
    expect(r.calls).toContain('GET /health');
    expect(r.net.state().mode).toBe('fresh');
    expect(r.onBack).toHaveBeenCalledTimes(1);
  });

  it('drops a saved copy older than the keep window', async () => {
    const r = rig();
    await r.net.fetch('/needs', G);
    vi.setSystemTime(Date.now() + KEEP_MS + 1000);
    r.set({ online: false });
    await expect(r.net.fetch('/needs', G)).rejects.toThrow(/Offline/);
  });

  it('keeps one sign-in from seeing another sign-in’s saved copies, and wipes them on clear()', async () => {
    const r = rig();
    await r.net.fetch('/needs', G);
    expect([...r.storage.map.keys()]).toEqual([`instar-net:${signInTag('tok-1')}:/needs`]);
    expect(signInTag('tok-1')).not.toBe(signInTag('tok-2'));
    r.net.clear();
    expect(r.storage.map.size).toBe(0);
  });

  it('never saves a private read', async () => {
    const r = rig();
    await r.net.fetch('/telegram/topics', G);
    await r.net.fetch('/needs', { headers: { Authorization: 'Bearer tok-1', 'X-Instar-Operator-Session': 's' } });
    expect(r.storage.map.size).toBe(0);
  });
});

describe('sending on a missing connection', () => {
  it('fails a send at once when the device is offline, instead of waiting', async () => {
    const r = rig({ online: false });
    await expect(r.net.fetch('/attention/a/resolve', { method: 'POST', body: '{}' })).rejects.toThrow(/Offline/);
    expect(r.fetchFn).not.toHaveBeenCalled();
  });
  it('passes a send through untouched when online', async () => {
    const r = rig();
    const res = await r.net.fetch('/attention/a/resolve', { method: 'POST', body: '{}' });
    expect(res.status).toBe(200);
    expect(r.storage.map.size).toBe(0);
  });
});

describe('review fixes', () => {
  it('a front answering for an unreachable agent (Cloudflare 530, a proxy 502/504) shows the saved copy, not the error page', async () => {
    for (const status of [502, 504, 521, 530]) {
      const r = rig();
      await r.net.fetch('/needs', G);
      r.set({ apiStatus: status });
      const res = await r.net.fetch('/needs', G);
      expect(res.headers.get('X-Instar-Saved-At'), String(status)).not.toBeNull();
      expect(r.net.state().mode).toBe('weak');
    }
    expect(frontCouldNotReach(503)).toBe(false); // 503 is the agent's own "switched off"
  });
  it('with nothing saved, a front error page is returned as is and the line says weak', async () => {
    const r = rig();
    r.set({ apiStatus: 530 });
    const res = await r.net.fetch('/needs', G);
    expect(res.status).toBe(530);
    expect(r.net.state().mode).toBe('weak');
  });
  it('a read that lands after the sign-in changed is saved under neither sign-in', async () => {
    const r = rig();
    r.set({ token: 'tok-2' }); // signed out and in again while the read was out
    await r.net.fetch('/needs', G);
    expect(r.storage.map.size).toBe(0);
  });
  it('reads the method and headers of a Request object', () => {
    const req = new Request(`${ORIGIN}/needs`, { method: 'POST', headers: { Authorization: 'Bearer tok-1' } });
    expect(isStorable('/needs', undefined, req)).toBe(false);
    const get = new Request(`${ORIGIN}/needs`, { headers: { Authorization: 'Bearer tok-1' } });
    expect(isStorable('/needs', undefined, get)).toBe(true);
    expect(bearerOf(undefined, get)).toBe('tok-1');
  });
});
