/**
 * Console "Messages to you" (docs/specs/console-features/people-settings.md): held
 * replies lead, a failed status never reads as zero held, the PIN unlock uses the
 * operator-session adapter (kept in page memory, PIN itself not kept), and the
 * footer settings save with their revision.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { buildMessagesPage, displayModel, holdWords, heldHeadline } from '../../dashboard/console/messages-model.js';

const NOW = Date.parse('2026-10-25T23:30:00Z');
const ok = (data: unknown) => ({ ok: true, data });
const status = (over: Record<string, unknown> = {}) => ({ held: [], heldForward: { count: 0, expiredUnreported: 0 }, expiredHolds: { totalSinceBoot: 0 }, activation: { complete: true, observations: [] }, metrics: { counts: {} }, ...over });

describe('messages page model', () => {
  it('a failed status is not "nothing held"; the quick held count from /health is kept', () => {
    const p = buildMessagesPage({ ok: false, reason: 'needs your PIN' }, ok({ telegramOrigin: { heldForward: { count: 2 } } }), NOW);
    expect(p.ok).toBe(false);
    expect(p.needsUnlock).toBe(true);
    expect(p.heldForward.count).toBe(2);
    expect(buildMessagesPage(ok({}), null, NOW).ok).toBe(false);
  });
  it('held replies lead, newest first, with the reason in words', () => {
    const p = buildMessagesPage(ok(status({ held: [
      { operationId: 'a', topicId: 9210, hold_reason: 'lease-not-held', heldSince: new Date(NOW - 3600_000).toISOString() },
      { operationId: 'b', topicId: 127504, hold_reason: 'destination-not-authorized', heldSince: new Date(NOW - 60_000).toISOString() },
    ] })), null, NOW, { 127504: 'Instar dashboard makeover' });
    expect(p.headline).toBe('2 messages are held on this machine.');
    expect(p.rows[0].main).toBe('Instar dashboard makeover');
    expect(p.rows[1].sub).toContain('routed through');
    expect(p.sub).toContain('The oldest has waited 1 h');
  });
  it('groups anonymous replies with the same cause into one readable issue', () => {
    const held = Array.from({ length: 24 }, (_, n) => ({ operationId: `op-${n}`, hold_reason: 'lease-not-held', heldSince: new Date(NOW - (n + 1) * 60_000).toISOString() }));
    const p = buildMessagesPage(ok(status({ held })), null, NOW);
    expect(p.headline).toBe('24 messages are held on this machine.');
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0]).toMatchObject({ main: '24 delayed messages', count: 24 });
    expect(p.sub).toContain('I need to restore delivery');
    expect(JSON.stringify(p.rows[0])).not.toContain('Unnamed conversation');
  });
  it('expired-undelivered counts, and unconfirmed sends are named', () => {
    const p = buildMessagesPage(ok(status({ heldForward: { count: 0, expiredUnreported: 1 }, metrics: { counts: { 'attempt:accepted': 100, 'attempt:outcome-unknown': 7 } } })), null, NOW);
    expect(p.headline).toBe('1 message expired before delivery.');
    expect(p.sub).toContain('7 more ended without a confirmation');
  });
  it('recording that is not fully set up says so', () => {
    const p = buildMessagesPage(ok(status({ activation: { complete: false, observations: [{ obligation: 'tool-guards', subject: 'x', state: 'unknown' }] } })), null, NOW);
    expect(p.recording).toBe('not fully set up');
    expect(p.notReady[0].main).toBe('tool guards');
  });
  it('hold reasons and display settings', () => {
    expect(heldHeadline(24, 1, 23, 0)).toBe('1 reply and 23 automatic messages are held on this machine.');
    expect(heldHeadline(24, undefined, undefined, undefined)).toBe('24 messages are held on this machine.');
    expect(heldHeadline(undefined, undefined, undefined, undefined)).toBe("Can't tell how many messages are held.");
    expect(holdWords(undefined)).toBe('held for an unstated reason');
    expect(displayModel(ok({ defaults: { enabled: true }, revision: 'r1', topics: [{ id: '1', name: 'A' }] })).ok).toBe(true);
    expect(displayModel(ok({ defaults: { enabled: true } })).ok).toBe(false);
  });
});

describe('messages page in a DOM', () => {
  let dom: JSDOM;
  afterEach(() => dom?.window.close());
  it('asks for the PIN once, unlocks with the operator session, then shows and saves settings', async () => {
    let session = '';
    const posts: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
    dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:4040/dashboard/console/#/people/messages' });
    const g = globalThis as Record<string, unknown>;
    Object.assign(g, { window: dom.window, document: dom.window.document, location: dom.window.location, history: dom.window.history, localStorage: dom.window.localStorage, requestAnimationFrame: (f: () => void) => setTimeout(f, 0) });
    dom.window.localStorage.setItem('instar_token', 't');
    g.fetch = async (url: string, opts: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
      const h = opts.headers || {};
      const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
      if (url === '/dashboard/unlock') { session = 'S1'; return json(200, { token: 't', operatorSessionToken: 'S1', operatorSessionExpiresAt: new Date(Date.now() + 600_000).toISOString() }); }
      if (url === '/sessions') return json(200, { sessions: [] });
      if (url === '/health') return json(200, { project: { name: 'echo' }, telegramOrigin: { heldForward: { count: 0 } } });
      const authed = h['X-Instar-Operator-Session'] === session && session;
      if (url === '/telegram/origins/status') return authed ? json(200, status()) : json(403, { error: 'operator session required' });
      if (url === '/telegram/origin-display' && opts.method === 'POST') { posts.push({ url, body: opts.body || '', headers: h }); return json(200, { ok: true }); }
      if (url === '/telegram/origin-display') return authed ? json(200, { defaults: { enabled: true, machine: true, harness: true, model: true }, revision: 'r1', topics: [] }) : json(403, {});
      return json(404, {});
    };
    vi.resetModules();
    await import('../../dashboard/console/console.js');
    const tick = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 15)); };
    await tick(15);
    const doc = dom.window.document;
    expect(doc.querySelector('.need-title')!.textContent).toBe('Message records need your PIN');
    (doc.querySelector('.need-card button') as HTMLButtonElement).click();
    await tick(3);
    (doc.querySelector('.pin-input') as HTMLInputElement).value = '123456';
    (doc.querySelector('.pin-form') as HTMLFormElement).dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    await tick(15);
    expect(doc.querySelector('.page-title')!.textContent).toBe('No messages are held.');
    ([...doc.querySelectorAll('.acct-row')].find((b) => b.textContent!.includes('footer')) as HTMLButtonElement).click();
    await tick(2);
    (doc.querySelector('#od-model') as HTMLInputElement).checked = false;
    ([...doc.querySelectorAll('.sheet button')].find((b) => b.textContent === 'Save') as HTMLButtonElement).click();
    await tick(5);
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0].body)).toEqual({ display: { enabled: true, machine: true, harness: true, model: false }, revision: 'r1' });
    expect(posts[0].headers['X-Instar-Operator-Session']).toBe('S1');
  });
  it('never shows a PIN box this connection would refuse: it offers the secure address instead', async () => {
    let unlockPosts = 0;
    dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://100.101.95.10:4040/dashboard/console/#/people/messages' });
    const g = globalThis as Record<string, unknown>;
    Object.assign(g, { window: dom.window, document: dom.window.document, location: dom.window.location, history: dom.window.history, localStorage: dom.window.localStorage, requestAnimationFrame: (f: () => void) => setTimeout(f, 0) });
    dom.window.localStorage.setItem('instar_token', 't');
    g.fetch = async (url: string) => {
      const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
      if (url === '/dashboard/unlock-check') return json(200, { accepted: false, reason: 'Your PIN can only be typed over a secure connection, and this address is not one.', secureUrl: 'https://mama-pc.example.ts.net' });
      if (url === '/dashboard/unlock') { unlockPosts++; return json(403, { error: 'refused' }); }
      if (url === '/sessions') return json(200, { sessions: [] });
      if (url === '/health') return json(200, { project: { name: 'echo' }, telegramOrigin: { heldForward: { count: 0 } } });
      if (url === '/telegram/origins/status') return json(403, { error: 'operator session required' });
      return json(404, {});
    };
    vi.resetModules();
    await import('../../dashboard/console/console.js');
    const tick = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 15)); };
    await tick(15);
    const doc = dom.window.document;
    (doc.querySelector('.need-card button') as HTMLButtonElement).click();
    await tick(5);
    expect(doc.querySelector('.pin-input')).toBeNull();
    const link = doc.querySelector('.sheet a.btn-primary') as HTMLAnchorElement;
    expect(link.textContent).toBe('Open the secure address');
    expect(link.href).toBe('https://mama-pc.example.ts.net/dashboard/console/#/people/messages');
    expect(doc.querySelector('.sheet')!.textContent).toContain('secure connection');
    expect(unlockPosts).toBe(0);
  });
});
