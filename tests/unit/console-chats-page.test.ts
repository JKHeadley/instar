/**
 * The Conversations page in jsdom (dashboard-conversations-browser-device.md §4.2 client side,
 * §4.6, §4.8): setup stores the key before sending and signs the proof the server checks; every
 * conversation read and send carries a device signature the server's verifyDeviceRequest accepts;
 * the credential question appears before a key-shaped message is sent; the key survives a refusal
 * answered "unknown"; text from the server is rendered as text, never markup.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import crypto from 'node:crypto';
import { verifyDeviceRequest, ReplayGuard, parseDevicePublicKey } from '../../src/core/MobileDeviceKeys.js';

// ── a tiny in-memory IndexedDB (only what browser-device.js uses) ─────────────
function fakeIndexedDB() {
  const stores = new Map<string, Map<string, unknown>>();
  const req = (fn: () => unknown, tx?: { pending: number; done: () => void }) => {
    const r: Record<string, unknown> = {};
    if (tx) tx.pending++;
    setTimeout(() => {
      r.result = fn();
      (r.onsuccess as (() => void) | undefined)?.();
      if (tx) { tx.pending--; if (tx.pending === 0) setTimeout(() => tx.done(), 0); }
    }, 0);
    return r;
  };
  return {
    stores,
    open(_name: string) {
      const r: Record<string, unknown> = {};
      setTimeout(() => {
        const db = {
          objectStoreNames: { contains: (n: string) => stores.has(n) },
          createObjectStore: (n: string) => { stores.set(n, new Map()); },
          transaction(name: string) {
            const t: Record<string, unknown> & { pending: number; done: () => void } = { pending: 0, done: () => (t.oncomplete as (() => void) | undefined)?.() };
            const s = stores.get(name)!;
            t.objectStore = () => ({
              get: (k: string) => req(() => s.get(k), t),
              getAll: () => req(() => [...s.values()], t),
              put: (v: { machineId: string }) => req(() => { s.set(v.machineId, v); }, t),
              delete: (k: string) => req(() => { s.delete(k); }, t),
            });
            setTimeout(() => { if (t.pending === 0) t.done(); }, 5);
            return t;
          },
          close() {},
        };
        r.result = db;
        if (!stores.has('device')) (r.onupgradeneeded as (() => void) | undefined)?.();
        (r.onsuccess as (() => void) | undefined)?.();
      }, 0);
      return r;
    },
  };
}

type Call = { url: string; method: string; headers: Record<string, string>; body: string | undefined };
let dom: JSDOM;
let calls: Call[];
const flush = (ms = 20) => new Promise((r) => setTimeout(r, ms));

async function boot(handler: (c: Call) => { status: number; body?: unknown } | undefined, hash = '#/work/chats', idb = fakeIndexedDB()) {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: `http://localhost:4040/dashboard/console/${hash}`, pretendToBeVisual: true });
  const g = globalThis as Record<string, unknown>;
  Object.assign(g, { window: dom.window, document: dom.window.document, location: dom.window.location, history: dom.window.history, localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage, indexedDB: idb, isSecureContext: true });
  g.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(cb, 0);
  dom.window.localStorage.setItem('instar_token', 'tok');
  calls = [];
  g.fetch = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    const c: Call = { url, method: init.method || 'GET', headers: init.headers || {}, body: typeof init.body === 'string' ? init.body : undefined };
    calls.push(c);
    const base: Record<string, unknown> = {
      '/sessions': { sessions: [] }, '/health': { project: { name: 'echo' } }, '/dashboard/unlock-check': { accepted: true },
    };
    const out = handler(c) ?? (base[url] !== undefined ? { status: 200, body: base[url] } : { status: 404, body: {} });
    return { ok: out.status >= 200 && out.status < 300, status: out.status, json: async () => JSON.parse(JSON.stringify(out.body ?? {})), headers: new dom.window.Headers() } as unknown as Response;
  };
  vi.resetModules();
  await import('../../dashboard/console/console.js');
  for (let i = 0; i < 10; i++) await flush();
  return { doc: dom.window.document, idb };
}

afterEach(() => { dom?.window.close(); });

const STATUS = { enabled: true, machineId: 'm1', nickname: 'Studio', serverTime: Date.now(), approvalPath: 'dashboard', approveEnabled: true, telegramSend: true, limits: { maxFiles: 10, maxMessageBytes: 64 << 20, maxFileBytes: 50 << 20, chunkBytes: 1 << 20 } };
const UUID = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';

function verifySigned(c: Call, publicKey: string, host = 'localhost:4040') {
  return verifyDeviceRequest({ deviceId: c.headers['X-Instar-Device'], time: c.headers['X-Instar-Device-Time'], sig: c.headers['X-Instar-Device-Sig'], method: c.method, pathWithQuery: c.url, rawBody: c.body ? Buffer.from(c.body) : undefined }, () => ({ publicKey, host, status: 'active' }), new Set(['active']), new ReplayGuard());
}

describe('Conversations page', () => {
  it('switched off: the off text, and no conversation is read', async () => {
    const { doc } = await boot((c) => (c.url.startsWith('/mobile/browser-devices/status') ? { status: 503 } : undefined));
    expect(doc.body.textContent).toContain('Conversations in the dashboard are switched off on this agent.');
    expect(calls.some((c) => c.url.startsWith('/mobile/conversations'))).toBe(false);
  });

  it('set up with the PIN: the key is stored before sending, the proof verifies, then the list is read signed', async () => {
    let storedAtSend: unknown = null;
    let publicKey = '';
    const idb = fakeIndexedDB();
    const { doc } = await boot((c) => {
      if (c.url.startsWith('/mobile/browser-devices/status')) return { status: 200, body: STATUS };
      if (c.url === '/dashboard/unlock' && c.method === 'POST') return { status: 200, body: { operatorSessionToken: 'sess-1', operatorSessionExpiresAt: new Date(Date.now() + 600_000).toISOString() } };
      if (c.url === '/mobile/browser-devices' && c.method === 'POST') {
        storedAtSend = [...(idb.stores.get('device')?.values() ?? [])][0];
        const b = JSON.parse(c.body!);
        publicKey = b.publicKey;
        const text = `instar-browser-enroll-v1\nlocalhost:4040\n${b.publicKey}\n${b.enrollmentId}\n${b.timeMs}`;
        const ok = crypto.verify('sha256', Buffer.from(text), { key: parseDevicePublicKey(b.publicKey)!, dsaEncoding: 'der' }, Buffer.from(b.proof, 'base64url'));
        if (!ok || c.headers['X-Instar-Operator-Session'] !== 'sess-1') return { status: 400, body: { error: 'browser-proof-invalid' } };
        return { status: 201, body: { deviceId: 'dev-b1234567', machineId: 'm1', host: 'localhost:4040', status: 'active', approval: 'dashboard', fingerprint: 'AAAA' } };
      }
      if (c.url.startsWith('/mobile/conversations?scope=pool')) return { status: 200, body: { conversations: [{ id: UUID, platform: 'app', title: '<b>Plans</b>', lastActivity: new Date().toISOString(), lastPreview: 'hi' }], nextCursor: null, pool: { failed: [] } } };
      return undefined;
    }, '#/work/chats', idb);
    const setup = [...doc.querySelectorAll('button')].find((b) => b.textContent === 'Set up this browser') as HTMLButtonElement;
    expect(setup).toBeTruthy();
    setup.click();
    for (let i = 0; i < 10; i++) await flush();
    const pin = doc.querySelector('input.pin-input') as HTMLInputElement;
    expect(pin).toBeTruthy();
    pin.value = '1234';
    pin.closest('form')!.dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    for (let i = 0; i < 30; i++) await flush();
    expect(storedAtSend).toMatchObject({ status: 'enrolling', machineId: 'm1' });
    const list = calls.find((c) => c.url.startsWith('/mobile/conversations?scope=pool'));
    expect(list).toBeTruthy();
    expect(verifySigned(list!, publicKey).ok).toBe(true);
    // Server text is text: the title is shown literally, not as markup.
    const row = doc.querySelector('.chat-row-title');
    expect(row?.textContent).toBe('<b>Plans</b>');
    expect(row?.querySelector('b')).toBeNull();
    // The Bearer token never signs a conversation read.
    expect(list!.headers.Authorization).toBeUndefined();
  });

  it('an active browser opens a conversation, asks before sending a key-shaped message, and the send verifies', async () => {
    const idb = fakeIndexedDB();
    // Seed an active key, made with the console module itself.
    const bd = await import('../../dashboard/console/browser-device.js');
    const { keyPair, publicKey } = await bd.generateDeviceKey();
    idb.stores.set('device', new Map([['m1', { machineId: 'm1', deviceId: 'dev-b1234567', host: 'localhost:4040', status: 'active', keyPair, publicKey, keyHash: await bd.keyHashOf(publicKey) }]]));
    let sent: Call | null = null;
    const { doc } = await boot((c) => {
      if (c.url.startsWith('/mobile/browser-devices/status')) return { status: 200, body: STATUS };
      if (c.url.startsWith('/mobile/conversations?scope=pool')) return { status: 200, body: { conversations: [{ id: UUID, platform: 'app', title: 'Plans', lastActivity: new Date().toISOString(), lastPreview: '' }], nextCursor: null } };
      if (c.url.startsWith(`/mobile/chat/app/${UUID}/messages`)) return { status: 200, body: { conversationKey: UUID, messages: [{ eventId: 'e1', messageId: 'msg-1', role: 'agent', text: 'hello', at: new Date().toISOString() }], nextBefore: null } };
      if (c.url.startsWith(`/mobile/chat/app/${UUID}/events`)) return { status: 200, body: { events: [], cursor: 'c1' } };
      if (c.url === `/mobile/chat/app/${UUID}` && c.method === 'POST') { sent = c; return { status: 200, body: { ok: true, messageId: 'msg-2', deliveryState: 'delivered' } }; }
      return undefined;
    }, `#/work/chats?c=${encodeURIComponent(`app:${UUID}`)}`, idb);
    for (let i = 0; i < 10; i++) await flush();
    expect(doc.querySelector('.chat-bubble.chat-left .chat-text')?.textContent).toBe('hello');
    const box = doc.querySelector('textarea.chat-compose') as HTMLTextAreaElement;
    box.value = 'my key is ghp_' + 'A'.repeat(36);
    box.dispatchEvent(new dom.window.Event('input'));
    (doc.querySelector('button.chat-send') as HTMLButtonElement).click();
    for (let i = 0; i < 5; i++) await flush();
    expect(doc.body.textContent).toContain('This looks like a password or key.');
    expect(sent).toBeNull();
    ([...doc.querySelectorAll('button')].find((b) => b.textContent === 'Send as written') as HTMLButtonElement).click();
    for (let i = 0; i < 20; i++) await flush();
    expect(sent).not.toBeNull();
    expect(verifySigned(sent!, publicKey).ok).toBe(true);
    expect(JSON.parse(sent!.body!).requestId).toMatch(/^\d{13}-/);
  });

  it('a 401 answered "unknown" by the status route keeps the key', async () => {
    const idb = fakeIndexedDB();
    const bd = await import('../../dashboard/console/browser-device.js');
    const { keyPair, publicKey } = await bd.generateDeviceKey();
    idb.stores.set('device', new Map([['m1', { machineId: 'm1', deviceId: 'dev-b1234567', host: 'localhost:4040', status: 'active', keyPair, publicKey, keyHash: await bd.keyHashOf(publicKey) }]]));
    const { doc } = await boot((c) => {
      if (c.url.startsWith('/mobile/browser-devices/status')) return { status: 200, body: c.url.includes('keyHash') ? { ...STATUS, key: { state: 'unknown' } } : STATUS };
      if (c.url.startsWith('/mobile/conversations')) return { status: 401, body: { error: 'device-unauthorized', machineId: 'm1' } };
      return undefined;
    }, '#/work/chats', idb);
    for (let i = 0; i < 10; i++) await flush();
    expect(doc.body.textContent).toContain('Couldn\'t check this browser right now.');
    expect(idb.stores.get('device')?.has('m1')).toBe(true);
  });

  it('a 401 answered "revoked" deletes the key and shows the setup card', async () => {
    const idb = fakeIndexedDB();
    const bd = await import('../../dashboard/console/browser-device.js');
    const { keyPair, publicKey } = await bd.generateDeviceKey();
    idb.stores.set('device', new Map([['m1', { machineId: 'm1', deviceId: 'dev-b1234567', host: 'localhost:4040', status: 'active', keyPair, publicKey, keyHash: await bd.keyHashOf(publicKey) }]]));
    const { doc } = await boot((c) => {
      if (c.url.startsWith('/mobile/browser-devices/status')) return { status: 200, body: c.url.includes('keyHash') ? { ...STATUS, machineId: 'm2', key: { state: 'revoked' } } : STATUS };
      if (c.url.startsWith('/mobile/conversations')) return { status: 401, body: { error: 'device-unauthorized' } };
      return undefined;
    }, '#/work/chats', idb);
    for (let i = 0; i < 10; i++) await flush();
    expect(doc.body.textContent).toContain('This browser was removed.');
    expect(idb.stores.get('device')?.has('m1')).toBe(false);
  });
});
