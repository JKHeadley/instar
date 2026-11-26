/**
 * The Conversations page in jsdom (dashboard-conversations-browser-device.md §4.2 client side,
 * §4.6, §4.8): setup stores the key before sending and signs the proof the server checks; every
 * conversation read and send carries a device signature the server's verifyDeviceRequest accepts;
 * the credential question appears before a key-shaped message is sent; the key survives a refusal
 * answered "unknown"; text from the server is rendered as text, never markup.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
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

// Each boot() imports a fresh console module, and closing the JSDOM window does not stop
// it: a request it started (signing on Node's crypto thread pool, a fake IndexedDB step, a
// poll timer) can resume during a LATER test and call the global fetch, which by then is
// that later test's mock, adding calls to its counts. On a loaded CI shard signing is slow
// enough for this to happen; alone the file passed. Every boot runs under its own async
// context, so all work a page starts carries its boot's number, and the mock refuses (never
// answers, never records) a call from an earlier boot. Work the test body itself starts,
// such as a click, carries no number and is the current page's.
const bootContext = new AsyncLocalStorage<number>();
let bootGeneration = 0;
const pageChannels = new Set<BroadcastChannel>();
const pageLifecycles = new Set<{ dispose: () => void }>();

function disposePage() {
  // Run the router's real registered page cleanup before removing its browser window.
  for (const lifecycle of pageLifecycles) lifecycle.dispose();
  pageLifecycles.clear();
}
const RealBroadcastChannel = globalThis.BroadcastChannel;
if (RealBroadcastChannel) {
  // Node's BroadcastChannel outlives the window too: an earlier page would keep hearing this one.
  globalThis.BroadcastChannel = class extends RealBroadcastChannel { constructor(name: string) { super(name); pageChannels.add(this); } } as typeof BroadcastChannel;
}

async function boot(handler: (c: Call) => { status: number; body?: unknown } | undefined | Promise<{ status: number; body?: unknown } | undefined>, hash = '#/work/chats', idb = fakeIndexedDB()) {
  const generation = ++bootGeneration;
  return bootContext.run(generation, () => bootPage(handler, hash, idb));
}

async function bootPage(handler: (c: Call) => { status: number; body?: unknown } | undefined | Promise<{ status: number; body?: unknown } | undefined>, hash: string, idb: ReturnType<typeof fakeIndexedDB>) {
  disposePage();
  dom?.window.close();
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: `http://localhost:4040/dashboard/console/${hash}`, pretendToBeVisual: true });
  const g = globalThis as Record<string, unknown>;
  Object.assign(g, { window: dom.window, document: dom.window.document, location: dom.window.location, history: dom.window.history, localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage, indexedDB: idb, isSecureContext: true });
  g.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(cb, 0);
  dom.window.localStorage.setItem('instar_token', 'tok');
  calls = [];
  g.fetch = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    const owner = bootContext.getStore();
    if (owner !== undefined && owner !== bootGeneration) return new Promise<Response>(() => { /* an earlier test's page: never answered */ });
    const c: Call = { url, method: init.method || 'GET', headers: init.headers || {}, body: typeof init.body === 'string' ? init.body : undefined };
    calls.push(c);
    const base: Record<string, unknown> = {
      '/sessions': { sessions: [] }, '/health': { project: { name: 'echo' } }, '/dashboard/unlock-check': { accepted: true },
    };
    const out = await handler(c) ?? (base[url] !== undefined ? { status: 200, body: base[url] } : { status: 404, body: {} });
    return { ok: out.status >= 200 && out.status < 300, status: out.status, json: async () => JSON.parse(JSON.stringify(out.body ?? {})), headers: new dom.window.Headers() } as unknown as Response;
  };
  vi.resetModules();
  const lifecycleModule = await import('../../dashboard/console/page-lifecycle.js');
  const createLifecycle = lifecycleModule.createLifecycle;
  vi.spyOn(lifecycleModule, 'createLifecycle').mockImplementation((options) => {
    const lifecycle = createLifecycle(options);
    pageLifecycles.add(lifecycle);
    return lifecycle;
  });
  await import('../../dashboard/console/console.js');
  for (let i = 0; i < 10; i++) await flush();
  return { doc: dom.window.document, idb };
}

afterEach(() => {
  disposePage();
  for (const c of pageChannels) { try { c.close(); } catch { /* already closed */ } }
  pageChannels.clear();
  dom?.window.close();
});

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

  it('pinned messages: the bar shows the newest pin with a count, a message menu pins (signed), and All pins lists them (conversation-pinned-messages)', async () => {
    const idb = fakeIndexedDB();
    const bd = await import('../../dashboard/console/browser-device.js');
    const { keyPair, publicKey } = await bd.generateDeviceKey();
    idb.stores.set('device', new Map([['m1', { machineId: 'm1', deviceId: 'dev-b1234567', host: 'localhost:4040', status: 'active', keyPair, publicKey, keyHash: await bd.keyHashOf(publicKey) }]]));
    const at = new Date().toISOString();
    let pins = [{ messageId: 'msg-1', pinnedAt: at, pinnedBy: { name: 'Justin', role: 'owner' }, preview: 'hello', source: 'app' }];
    let pinCall: Call | null = null;
    const { doc } = await boot((c) => {
      if (c.url.startsWith('/mobile/browser-devices/status')) return { status: 200, body: STATUS };
      if (c.url.startsWith('/mobile/conversations?scope=pool')) return { status: 200, body: { conversations: [{ id: UUID, platform: 'app', title: 'Plans', lastActivity: at, lastPreview: '' }], nextCursor: null } };
      if (c.url.startsWith(`/mobile/chat/app/${UUID}/messages`)) return { status: 200, body: { conversationKey: UUID, messages: [{ eventId: 'e1', messageId: 'msg-1', role: 'agent', text: 'hello', at }, { eventId: 'e2', messageId: 'msg-2', role: 'agent', text: 'world', at }], nextBefore: null, pins } };
      if (c.url.startsWith(`/mobile/chat/app/${UUID}/events`)) return { status: 200, body: { events: [], cursor: 'c1' } };
      if (c.url === `/mobile/chat/app/${UUID}/pins` && c.method === 'POST') {
        pinCall = c;
        pins = [{ messageId: 'msg-2', pinnedAt: at, pinnedBy: { name: 'Justin', role: 'owner' }, preview: 'world', source: 'app' }, ...pins];
        return { status: 200, body: { ok: true, pinned: true, changed: true, mirror: 'not-applicable', pins } };
      }
      return undefined;
    }, `#/work/chats?c=${encodeURIComponent(`app:${UUID}`)}`, idb);
    for (let i = 0; i < 10; i++) await flush();
    const bar = doc.querySelector('.chat-pinbar') as HTMLElement;
    expect(bar.hidden).toBe(false);
    expect(bar.textContent).toContain('Pinned');
    expect(bar.textContent).toContain('hello');
    expect(doc.querySelector('.chat-bubble[data-message-id="msg-1"] .chat-pinned-mark')?.textContent).toBe('Pinned');
    // Pin the second message from its menu.
    (doc.querySelector('.chat-bubble[data-message-id="msg-2"] .chat-msg-menu') as HTMLButtonElement).click();
    await flush();
    ([...doc.querySelectorAll('button')].find((b) => b.textContent === 'Pin') as HTMLButtonElement).click();
    for (let i = 0; i < 10; i++) await flush();
    expect(pinCall).not.toBeNull();
    expect(verifySigned(pinCall!, publicKey).ok).toBe(true);
    expect(JSON.parse(pinCall!.body!)).toMatchObject({ messageId: 'msg-2', pinned: true });
    expect(doc.querySelector('.chat-pinbar')!.textContent).toContain('1 of 2');
    expect(doc.querySelector('.chat-pinbar')!.textContent).toContain('world');
    // All pins lists both, with an Unpin for each.
    (doc.querySelector('.chat-pin-all') as HTMLButtonElement).click();
    await flush();
    expect(doc.querySelectorAll('.chat-pin-row')).toHaveLength(2);
    expect(doc.querySelectorAll('.chat-pin-unpin')).toHaveLength(2);
    expect(doc.body.textContent).toContain('2 pinned messages');
  });

  it('a message from an earlier day shows its date with the year on the bubble and the pin line; today shows only the time (message dates)', async () => {
    const idb = fakeIndexedDB();
    const bd = await import('../../dashboard/console/browser-device.js');
    const { keyPair, publicKey } = await bd.generateDeviceKey();
    idb.stores.set('device', new Map([['m1', { machineId: 'm1', deviceId: 'dev-b1234567', host: 'localhost:4040', status: 'active', keyPair, publicKey, keyHash: await bd.keyHashOf(publicKey) }]]));
    const old = new Date(2025, 0, 3, 9, 5).toISOString();
    const today = new Date().toISOString();
    const pins = [{ messageId: 'msg-old', pinnedAt: old, pinnedBy: { name: 'Justin', role: 'owner' }, preview: 'old', source: 'app' }];
    const { doc } = await boot((c) => {
      if (c.url.startsWith('/mobile/browser-devices/status')) return { status: 200, body: STATUS };
      if (c.url.startsWith('/mobile/conversations?scope=pool')) return { status: 200, body: { conversations: [{ id: UUID, platform: 'app', title: 'Plans', lastActivity: today, lastPreview: '' }], nextCursor: null } };
      if (c.url.startsWith(`/mobile/chat/app/${UUID}/messages`)) return { status: 200, body: { conversationKey: UUID, messages: [{ eventId: 'e1', messageId: 'msg-old', role: 'agent', text: 'old', at: old }, { eventId: 'e2', messageId: 'msg-new', role: 'agent', text: 'new', at: today }], nextBefore: null, pins } };
      if (c.url.startsWith(`/mobile/chat/app/${UUID}/events`)) return { status: 200, body: { events: [], cursor: 'c1' } };
      return undefined;
    }, `#/work/chats?c=${encodeURIComponent(`app:${UUID}`)}`, idb);
    for (let i = 0; i < 10; i++) await flush();
    const oldTime = doc.querySelector('.chat-bubble[data-message-id="msg-old"] .chat-time')?.textContent ?? '';
    expect(oldTime).toContain('2025');
    expect(oldTime).toMatch(/\d{1,2}:05/);
    const newTime = doc.querySelector('.chat-bubble[data-message-id="msg-new"] .chat-time')?.textContent ?? '';
    expect(newTime).toMatch(/\d:\d\d/);
    expect(newTime).not.toContain(String(new Date().getFullYear()));
    (doc.querySelector('.chat-pin-all') as HTMLButtonElement).click();
    await flush();
    expect(doc.querySelector('.chat-pin-by')?.textContent ?? '').toContain('2025');
  });

  it('a 202 in-progress answer is asked again with the same requestId, and the message shows once (live proof finding)', async () => {
    const idb = fakeIndexedDB();
    const bd = await import('../../dashboard/console/browser-device.js');
    const { keyPair, publicKey } = await bd.generateDeviceKey();
    idb.stores.set('device', new Map([['m1', { machineId: 'm1', deviceId: 'dev-b1234567', host: 'localhost:4040', status: 'active', keyPair, publicKey, keyHash: await bd.keyHashOf(publicKey) }]]));
    const posts: Call[] = [];
    let delivered = false;
    const at = new Date().toISOString();
    const { doc } = await boot((c) => {
      if (c.url.startsWith('/mobile/browser-devices/status')) return { status: 200, body: STATUS };
      if (c.url.startsWith('/mobile/conversations?scope=pool')) return { status: 200, body: { conversations: [{ id: UUID, platform: 'app', title: 'Plans', lastActivity: at, lastPreview: '' }], nextCursor: null } };
      if (c.url.startsWith(`/mobile/chat/app/${UUID}/messages`)) return { status: 200, body: { conversationKey: UUID, messages: [{ eventId: 'e1', messageId: 'msg-1', role: 'agent', text: 'hello', at }], nextBefore: null } };
      if (c.url.startsWith(`/mobile/chat/app/${UUID}/events`)) {
        return { status: 200, body: { events: delivered ? [{ kind: 'message', eventId: 'e9', messageId: 'msg-9', role: 'operator', text: 'only once please', at: new Date().toISOString(), deliveryState: 'delivered', originVerified: 'verified' }] : [], cursor: 'c1' } };
      }
      if (c.url === `/mobile/chat/app/${UUID}` && c.method === 'POST') {
        posts.push(c);
        if (posts.length === 1) return { status: 202, body: { state: 'in-progress' } };
        delivered = true;
        return { status: 200, body: { ok: true, messageId: 'msg-9', deliveryState: 'delivered' } };
      }
      return undefined;
    }, `#/work/chats?c=${encodeURIComponent(`app:${UUID}`)}`, idb);
    for (let i = 0; i < 10; i++) await flush();
    const box = doc.querySelector('textarea.chat-compose') as HTMLTextAreaElement;
    box.value = 'only once please';
    box.dispatchEvent(new dom.window.Event('input'));
    (doc.querySelector('button.chat-send') as HTMLButtonElement).click();
    for (let i = 0; i < 40 && posts.length < 2; i++) await flush(100);
    for (let i = 0; i < 20; i++) await flush(50);
    expect(posts.length).toBe(2);
    expect(JSON.parse(posts[1]!.body!).requestId).toBe(JSON.parse(posts[0]!.body!).requestId);
    const copies = [...doc.querySelectorAll('.chat-bubble .chat-text')].filter((n) => n.textContent === 'only once please');
    expect(copies).toHaveLength(1);
  }, 15_000);

  it('opened from a link before the list arrives, the header shows the real title once the list paints (live proof finding)', async () => {
    const idb = fakeIndexedDB();
    const bd = await import('../../dashboard/console/browser-device.js');
    const { keyPair, publicKey } = await bd.generateDeviceKey();
    idb.stores.set('device', new Map([['m1', { machineId: 'm1', deviceId: 'dev-b1234567', host: 'localhost:4040', status: 'active', keyPair, publicKey, keyHash: await bd.keyHashOf(publicKey) }]]));
    const at = new Date().toISOString();
    const { doc } = await boot((c) => {
      if (c.url.startsWith('/mobile/browser-devices/status')) return { status: 200, body: STATUS };
      if (c.url.startsWith(`/mobile/chat/app/${UUID}/messages`)) return { status: 200, body: { conversationKey: UUID, messages: [], nextBefore: null } };
      if (c.url.startsWith(`/mobile/chat/app/${UUID}/events`)) return { status: 200, body: { events: [], cursor: 'c1' } };
      return undefined;
    }, `#/work/chats?c=${encodeURIComponent(`app:${UUID}`)}`, idb);
    for (let i = 0; i < 10; i++) await flush();
    // The list was answered 404 (not loaded yet): the header falls back.
    expect(doc.querySelector('.chat-title')?.textContent).toBe('Conversation');
    // The list arrives later with the title.
    const g = globalThis as Record<string, unknown>;
    const prev = g.fetch as (u: string, i?: unknown) => Promise<Response>;
    g.fetch = async (url: string, init?: unknown) => {
      if (url.startsWith('/mobile/conversations')) return { ok: true, status: 200, json: async () => ({ conversations: [{ id: UUID, platform: 'app', title: 'Plans for Saturday', lastActivity: at, lastPreview: '' }], nextCursor: null }), headers: new dom.window.Headers() } as unknown as Response;
      return prev(url, init);
    };
    dom.window.dispatchEvent(new dom.window.Event('focus'));
    // A list refresh (the leader's 30 s refresh in real use; here the list's own Show more, which reloads it).
    (doc.querySelector('button.chat-more') as HTMLButtonElement).click();
    for (let i = 0; i < 60 && doc.querySelector('.chat-title')?.textContent !== 'Plans for Saturday'; i++) await flush(100);
    expect(doc.querySelector('.chat-title')?.textContent).toBe('Plans for Saturday');
  }, 15_000);

  it('change feed: quick reads send known row hashes and reconstruct unchanged rows; pool reads stay full (telegram-slack-change-feed)', async () => {
    const idb = fakeIndexedDB();
    const bd = await import('../../dashboard/console/browser-device.js');
    const { keyPair, publicKey } = await bd.generateDeviceKey();
    idb.stores.set('device', new Map([['m1', { machineId: 'm1', deviceId: 'dev-b1234567', host: 'localhost:4040', status: 'active', keyPair, publicKey, keyHash: await bd.keyHashOf(publicKey) }]]));
    const newest = new Date(Date.now() - 1000).toISOString();
    const older = new Date(Date.now() - 600_000).toISOString();
    const quick: string[] = [];
    const pool: string[] = [];
    const rows = [
      { messageId: 1, text: 'older', timestamp: older, fromUser: true },
      { messageId: 2, text: 'newest', timestamp: newest, fromUser: false },
    ];
    const hashes = rows.map((row) => crypto.createHash('sha256').update(JSON.stringify(row)).digest('hex'));
    const broadcasts: Array<{ mode?: string; quickFullPage?: boolean; data?: { messages?: unknown[] } }> = [];
    const observer = RealBroadcastChannel ? new BroadcastChannel('instar-chat') : null;
    if (observer) observer.onmessage = (ev) => broadcasts.push(ev.data);
    let reopened = false;
    let emptyDeltas = 0;
    const { doc } = await boot((c) => {
      if (c.url.startsWith('/mobile/browser-devices/status')) return { status: 200, body: STATUS };
      if (c.url.startsWith('/mobile/conversations?scope=pool')) return { status: 200, body: { conversations: [{ id: 145738, platform: 'telegram', title: 'Parity', lastActivity: newest, lastPreview: 'hi' }], nextCursor: null } };
      if (c.url.startsWith('/telegram/topics/145738/messages')) {
        (c.url.includes('scope=pool') ? pool : quick).push(c.url);
        if (c.url.includes('scope=pool')) return { status: 200, body: { topicId: 145738, historyCursorVersion: 2, messages: reopened ? [] : rows } };
        const known = new URL(c.url, 'http://localhost').searchParams.get('knownRows') || '';
        const changed = rows.filter((_, i) => !known.split(',').includes(hashes[i]));
        if (!changed.length) emptyDeltas++;
        return { status: 200, body: { topicId: 145738, historyCursorVersion: 2, messages: changed, changeFeed: { rowHashes: hashes } } };
      }
      return undefined;
    }, `#/work/chats?c=${encodeURIComponent('telegram:145738')}`, idb);
    // Signing and IndexedDB completion share the worker pool with other test files. Wait
    // for observed quick reads rather than assuming boot completed within fixed short sleeps.
    await vi.waitFor(() => {
      bootContext.run(bootGeneration, () => dom.window.dispatchEvent(new dom.window.Event('focus')));
      expect(quick.length).toBeGreaterThanOrEqual(2);
    }, { timeout: 10_000, interval: 200 });
    expect(new URL(quick[0], 'http://localhost').searchParams.get('knownRows')).toBe('');
    expect(new URL(quick[1], 'http://localhost').searchParams.get('knownRows')).toBe(hashes.join(','));
    expect(quick.every((u) => !u.includes('after='))).toBe(true);
    expect(pool.length).toBeGreaterThan(0);
    expect(pool.every((u) => !u.includes('knownRows=') && !u.includes('after='))).toBe(true);
    expect([...doc.querySelectorAll('.chat-bubble .chat-text')].map((n) => n.textContent)).toEqual(['older', 'newest']);
    expect(emptyDeltas).toBeGreaterThan(0);
    if (observer) {
      const result = broadcasts.filter((m) => m.mode === 'newest').at(-1);
      expect(result?.quickFullPage).toBe(true);
      expect(result?.data?.messages).toEqual(rows); // another tab gets rows, not an empty network delta
    }

    // Reopening creates an empty view. Even if its pool snapshot has no local copies, an
    // unchanged quick read must repopulate it from the complete cache instead of hiding rows.
    reopened = true;
    dom.window.location.hash = '#/work/chats';
    for (let i = 0; i < 5; i++) await flush();
    dom.window.location.hash = `#/work/chats?c=${encodeURIComponent('telegram:145738')}`;
    for (let i = 0; i < 10; i++) await flush();
    const beforeReopen = quick.length;
    await vi.waitFor(() => {
      bootContext.run(bootGeneration, () => dom.window.dispatchEvent(new dom.window.Event('focus')));
      expect(quick.length).toBeGreaterThan(beforeReopen);
      expect([...doc.querySelectorAll('.chat-bubble .chat-text')].map((n) => n.textContent)).toEqual(['older', 'newest']);
    }, { timeout: 10_000, interval: 200 });
    expect([...doc.querySelectorAll('.chat-bubble .chat-text')].map((n) => n.textContent)).toEqual(['older', 'newest']);
  }, 25_000);

  it('a Slack conversation names its machine on the history read and the send (live proof finding)', async () => {
    const idb = fakeIndexedDB();
    const bd = await import('../../dashboard/console/browser-device.js');
    const { keyPair, publicKey } = await bd.generateDeviceKey();
    idb.stores.set('device', new Map([['m1', { machineId: 'm1', deviceId: 'dev-b1234567', host: 'localhost:4040', status: 'active', keyPair, publicKey, keyHash: await bd.keyHashOf(publicKey) }]]));
    const at = new Date().toISOString();
    const reads: string[] = [];
    let sent: Call | null = null;
    const { doc } = await boot((c) => {
      if (c.url.startsWith('/mobile/browser-devices/status')) return { status: 200, body: STATUS };
      if (c.url.startsWith('/mobile/conversations?scope=pool')) return { status: 200, body: { conversations: [{ id: -126660833, platform: 'slack', title: '#proof', lastActivity: at, lastPreview: 'hi', machine: 'm_slack' }], nextCursor: null } };
      if (c.url.startsWith('/mobile/chat/slack/-126660833/messages')) {
        reads.push(c.url);
        if (!/[?&]machine=m_slack(&|$)/.test(c.url)) return { status: 400, body: { error: 'machine-required' } };
        return { status: 200, body: { conversationKey: 'slack:T1:C1', messages: [{ eventId: 'slack:1.1', role: 'operator', text: 'Slack inbound', at }] } };
      }
      if (c.url === '/mobile/chat/slack/-126660833' && c.method === 'POST') { sent = c; return { status: 200, body: { ok: true, outcome: 'delivered', eventId: 'op-1' } }; }
      return undefined;
    }, '#/work/chats', idb);
    for (let i = 0; i < 10; i++) await flush();
    (doc.querySelector('.chat-row') as HTMLAnchorElement).click();
    dom.window.location.hash = `#/work/chats?c=${encodeURIComponent('slack:-126660833')}`;
    for (let i = 0; i < 20; i++) await flush();
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((u) => u.includes('machine=m_slack'))).toBe(true);
    expect([...doc.querySelectorAll('.chat-bubble .chat-text')].map((n) => n.textContent)).toContain('Slack inbound');
    const box = doc.querySelector('textarea.chat-compose') as HTMLTextAreaElement;
    box.value = 'from the dashboard';
    box.dispatchEvent(new dom.window.Event('input'));
    (doc.querySelector('button.chat-send') as HTMLButtonElement).click();
    for (let i = 0; i < 20; i++) await flush();
    expect(sent).not.toBeNull();
    expect(JSON.parse(sent!.body!).machine).toBe('m_slack');
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

  it('conversation-list pins: a Pinned group leads the list, and Pin posts the row\'s ref signed (conversation-list-pins)', async () => {
    const idb = fakeIndexedDB();
    const bd = await import('../../dashboard/console/browser-device.js');
    const { keyPair, publicKey } = await bd.generateDeviceKey();
    idb.stores.set('device', new Map([['m1', { machineId: 'm1', deviceId: 'dev-b1234567', host: 'localhost:4040', status: 'active', keyPair, publicKey, keyHash: await bd.keyHashOf(publicKey) }]]));
    const at = new Date().toISOString();
    const rows = [{ id: UUID, platform: 'app', title: 'Plans', lastActivity: at, lastPreview: '' }, { id: 7, platform: 'telegram', title: 'Ops', lastActivity: at, lastPreview: '' }];
    let pinned: unknown[] = [rows[1]];
    let pinCall: Call | null = null;
    const { doc } = await boot((c) => {
      if (c.url.startsWith('/mobile/browser-devices/status')) return { status: 200, body: STATUS };
      if (c.url.startsWith('/mobile/conversations?scope=pool')) return { status: 200, body: { conversations: rows, nextCursor: null, pinnedRefs: [], pinnedRows: pinned } };
      if (c.url === '/mobile/conversations/pins' && c.method === 'POST') { pinCall = c; pinned = [rows[0], rows[1]]; return { status: 200, body: { ok: true, changed: true, pinned: [] } }; }
      return undefined;
    }, '#/work/chats', idb);
    for (let i = 0; i < 10; i++) await flush();
    const labels = () => [...doc.querySelectorAll('.chat-group-label')].map((x) => x.textContent);
    expect(labels()).toEqual(['Pinned', 'All conversations']);
    const titles = () => [...doc.querySelectorAll('.chat-row-title')].map((x) => x.textContent);
    expect(titles()).toEqual(['Ops', 'Plans']);
    expect(doc.querySelector('.chat-list-unpin')?.textContent).toBe('Unpin');
    // Pin "Plans" from its button.
    ([...doc.querySelectorAll('.chat-list-pin')].find((b) => b.textContent === 'Pin') as HTMLButtonElement).click();
    for (let i = 0; i < 10; i++) await flush();
    expect(pinCall).not.toBeNull();
    expect(verifySigned(pinCall!, publicKey).ok).toBe(true);
    expect(JSON.parse(pinCall!.body!)).toEqual({ ref: `app:${UUID}`, pinned: true });
    expect(titles()).toEqual(['Plans', 'Ops']);
    expect(doc.querySelectorAll('.chat-list-unpin')).toHaveLength(2);
  });

  // ── the list grouped by the conversation hierarchy (console-chats-grouped) ──
  async function seeded() {
    const idb = fakeIndexedDB();
    const bd = await import('../../dashboard/console/browser-device.js');
    const { keyPair, publicKey } = await bd.generateDeviceKey();
    idb.stores.set('device', new Map([['m1', { machineId: 'm1', deviceId: 'dev-b1234567', host: 'localhost:4040', status: 'active', keyPair, publicKey, keyHash: await bd.keyHashOf(publicKey) }]]));
    return { idb, publicKey };
  }
  const at = () => new Date().toISOString();
  const LIST = () => ({ conversations: [
    { id: 1, platform: 'telegram', title: 'Chief of Staff', lastActivity: at(), lastPreview: '' },
    { id: 2, platform: 'telegram', title: '<img src=x onerror=alert(1)>Build', lastActivity: at(), lastPreview: '', unreadCount: 2 },
    { id: 3, platform: 'telegram', title: 'Loose', lastActivity: at(), lastPreview: '' },
    { id: 4, platform: 'telegram', title: 'Deep', lastActivity: at(), lastPreview: '', unreadCount: 1 },
  ], pinned: { id: 1, platform: 'telegram', title: 'Chief of Staff', lastActivity: at() }, nextCursor: null });
  const effort = { kind: 'effort', id: 'eff-a' };
  const worker = (topicId: number) => ({ ref: { kind: 'conversation', platform: 'telegram', chatId: '-100', topicId }, title: `T${topicId}`, kind: 'conversation', role: 'worker',
    primaryPath: [{ ref: effort, title: '<b>App work</b>' }], visibleChildCount: 0, source: { platform: 'telegram', conversationId: topicId, title: `T${topicId}` } });
  const GRAPH = { items: [worker(2), worker(4)], partial: false, nextCursor: null };

  it('grouped: Chief of Staff first, a "Groups" header, each group one collapsed row with folder, count and unread, the rest under "Not in a group yet"; All shows the flat list and is remembered', async () => {
    const { idb, publicKey } = await seeded();
    const { doc } = await boot((c) => {
      if (c.url.startsWith('/mobile/browser-devices/status')) return { status: 200, body: STATUS };
      if (c.url.startsWith('/mobile/conversations?scope=pool')) return { status: 200, body: LIST() };
      if (c.url.startsWith('/mobile/conversation-graph/roots?view=all')) return { status: 200, body: GRAPH };
      return undefined;
    }, '#/work/chats', idb);
    for (let i = 0; i < 10; i++) await flush();
    const graphRead = calls.find((c) => c.url.startsWith('/mobile/conversation-graph/roots'))!;
    expect(verifySigned(graphRead, publicKey).ok).toBe(true);
    const titles = () => [...doc.querySelectorAll('.chat-rows .chat-row-title')].map((x) => x.textContent);
    const toggle = doc.querySelector('.chat-view-toggle') as HTMLElement;
    expect(toggle.hidden).toBe(false);
    const chip = (t: string) => [...toggle.querySelectorAll('button')].find((b) => b.textContent === t) as HTMLButtonElement;
    expect(chip('Grouped').getAttribute('aria-pressed')).toBe('true');
    // Collapsed: Chief of Staff, the effort row (title as text, never markup), then the ungrouped row.
    expect(titles()).toEqual(['Chief of Staff', '<b>App work</b>', 'Loose']);
    const head = doc.querySelector('.chat-effort-row') as HTMLButtonElement;
    expect(head.querySelector('b')).toBeNull();
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(head.textContent).toContain('2 conversations');
    expect(head.querySelector('.chat-unread')?.textContent).toBe('3');
    expect(head.getAttribute('aria-label')).toBe('Group <b>App work</b>, 2 conversations, 3 unread');
    expect(head.classList.contains('chat-project-row')).toBe(false);
    expect(head.querySelector('.chat-group-icon svg')).not.toBeNull();
    expect(head.querySelector('.chat-group-icon-project, .chat-project-status')).toBeNull();
    expect(doc.querySelector('.chat-groups-label')?.textContent).toBe('Groups');
    // No tracked project: no "Projects" section header at all.
    expect(doc.querySelector('.chat-projects-label')).toBeNull();
    // Owner-facing words: never "effort"; a plain group (no tracked project) never says "project".
    const words = () => [doc.querySelector('.chat-rows')!.textContent!, ...[...doc.querySelectorAll('.chat-rows [aria-label]')].map((x) => x.getAttribute('aria-label')!)].join(' ').toLowerCase();
    expect(words()).not.toContain('effort');
    expect(words()).not.toContain('project');
    expect(doc.querySelector('.chat-ungrouped-label')?.textContent).toContain('Not in a group yet');
    expect(doc.querySelector('a.chat-review-suggestions')?.getAttribute('href')).toBe('#/work/conversations?view=suggestions');
    expect(doc.querySelector('.chat-rows img')).toBeNull();
    // Expand inline.
    head.click();
    expect(titles()).toEqual(['Chief of Staff', '<b>App work</b>', '<img src=x onerror=alert(1)>Build', 'Deep', 'Loose']);
    expect(doc.querySelector('.chat-open-project')).toBeNull();
    expect(words()).not.toContain('project');
    // All: today's flat list, remembered in this browser.
    chip('All').click();
    expect(doc.querySelector('.chat-effort-row')).toBeNull();
    expect(titles()).toEqual(['Chief of Staff', '<img src=x onerror=alert(1)>Build', 'Loose', 'Deep']);
    expect(chip('All').getAttribute('aria-pressed')).toBe('true');
    expect(dom.window.localStorage.getItem('instar_chats_list_view')).toBe('all');
  });

  it('a group linked to a tracked project shows the project mark, its status chip and, open, an "Open project" link; plain groups stay plain', async () => {
    const { idb } = await seeded();
    const effB = { kind: 'effort', id: 'eff-b' };
    const plain = { ref: { kind: 'conversation', platform: 'telegram', chatId: '-100', topicId: 3 }, title: 'T3', kind: 'conversation', role: 'worker',
      primaryPath: [{ ref: effB, title: 'Misc' }], visibleChildCount: 0, source: { platform: 'telegram', conversationId: 3, title: 'T3' } };
    // Topic 9 is the project's conversation: under the group but not loaded in the list; any conversation under the group counts.
    const hidden = { ...worker(9), ref: { kind: 'conversation', platform: 'telegram', chatId: '-100', topicId: 9 }, source: { platform: 'telegram', conversationId: 9, title: 'T9' } };
    const graph = { items: [worker(2), worker(4), hidden, plain], partial: false, nextCursor: null };
    const { doc } = await boot((c) => {
      if (c.url.startsWith('/mobile/browser-devices/status')) return { status: 200, body: STATUS };
      if (c.url.startsWith('/mobile/conversations?scope=pool')) return { status: 200, body: LIST() };
      if (c.url.startsWith('/mobile/conversation-graph/roots?view=all')) return { status: 200, body: graph };
      if (c.url === '/work/projects') return { status: 200, body: { projects: [{ key: 'telegram:9', conversationKey: 'telegram:9', title: 'App project', state: 'waiting-on-you' }] } };
      return undefined;
    }, '#/work/chats', idb);
    for (let i = 0; i < 10; i++) await flush();
    const rows = [...doc.querySelectorAll('.chat-effort-row')] as HTMLButtonElement[];
    expect(rows).toHaveLength(2);
    const [proj, folder] = rows;
    expect(proj.classList.contains('chat-project-row')).toBe(true);
    expect(proj.querySelector('.chat-group-icon-project svg')).not.toBeNull();
    expect(proj.querySelector('.chat-project-status')?.textContent).toBe('Needs you');
    expect(proj.querySelector('.chat-project-status')?.classList.contains('tone-attn')).toBe(true);
    // The tracked project's own title names the row (the group was titled "<b>App work</b>").
    expect(proj.querySelector('.chat-row-title')?.textContent).toBe('App project');
    expect(proj.getAttribute('aria-label')).toBe('Project App project, Needs you, 2 conversations, 3 unread');
    // Two sections, as on the iPhone: "Projects" above the project row, "Groups" above the plain one.
    const labels = [...doc.querySelectorAll('.chat-rows > .chat-group-label, .chat-rows > .chat-effort-row')].map((x) => x.classList.contains('chat-effort-row') ? `row:${x.querySelector('.chat-row-title')!.textContent}` : x.textContent);
    expect(labels.slice(0, 4)).toEqual(['Projects', 'row:App project', 'Groups', 'row:Misc']);
    expect(folder.classList.contains('chat-project-row')).toBe(false);
    expect(folder.querySelector('.chat-project-status, .chat-group-icon-project')).toBeNull();
    expect(folder.getAttribute('aria-label')).toBe('Group Misc, 1 conversation');
    expect(doc.querySelector('.chat-open-project')).toBeNull();
    proj.click();
    const open = doc.querySelector('a.chat-open-project') as HTMLAnchorElement;
    expect(open.textContent).toBe('Open project');
    expect(open.getAttribute('href')).toBe('#/work/board?project=telegram%3A9');
  });

  it('the projects read fails: every group looks plain', async () => {
    const { idb } = await seeded();
    const { doc } = await boot((c) => {
      if (c.url.startsWith('/mobile/browser-devices/status')) return { status: 200, body: STATUS };
      if (c.url.startsWith('/mobile/conversations?scope=pool')) return { status: 200, body: LIST() };
      if (c.url.startsWith('/mobile/conversation-graph/roots?view=all')) return { status: 200, body: GRAPH };
      if (c.url === '/work/projects') return { status: 500, body: {} };
      return undefined;
    }, '#/work/chats', idb);
    for (let i = 0; i < 10; i++) await flush();
    const head = doc.querySelector('.chat-effort-row') as HTMLButtonElement;
    expect(head).toBeTruthy();
    expect(head.classList.contains('chat-project-row')).toBe(false);
    expect(head.querySelector('.chat-project-status')).toBeNull();
  });

  it('a remembered "All" opens the flat list even when the hierarchy is available', async () => {
    const { idb } = await seeded();
    const { doc } = await boot((c) => {
      if (c.url.startsWith('/mobile/browser-devices/status')) { dom.window.localStorage.setItem('instar_chats_list_view', 'all'); return { status: 200, body: STATUS }; }
      if (c.url.startsWith('/mobile/conversations?scope=pool')) return { status: 200, body: LIST() };
      if (c.url.startsWith('/mobile/conversation-graph/roots?view=all')) return { status: 200, body: GRAPH };
      return undefined;
    }, '#/work/chats', idb);
    for (let i = 0; i < 10; i++) await flush();
    expect((doc.querySelector('.chat-view-toggle') as HTMLElement).hidden).toBe(false);
    expect(doc.querySelector('.chat-effort-row')).toBeNull();
    expect([...doc.querySelectorAll('.chat-rows .chat-row-title')]).toHaveLength(4);
  });

  for (const status of [403, 404, 503]) {
    it(`hierarchy answers ${status}: the flat list exactly as before, no toggle`, async () => {
      const { idb } = await seeded();
      const { doc } = await boot((c) => {
        if (c.url.startsWith('/mobile/browser-devices/status')) return { status: 200, body: STATUS };
        if (c.url.startsWith('/mobile/conversations?scope=pool')) return { status: 200, body: LIST() };
        if (c.url.startsWith('/mobile/conversation-graph/roots')) return { status, body: { code: 'x' } };
        return undefined;
      }, '#/work/chats', idb);
      for (let i = 0; i < 10; i++) await flush();
      expect((doc.querySelector('.chat-view-toggle') as HTMLElement).hidden).toBe(true);
      expect(doc.querySelector('.chat-effort-row')).toBeNull();
      expect(doc.querySelector('.chat-ungrouped-label')).toBeNull();
      expect([...doc.querySelectorAll('.chat-rows .chat-row-title')].map((x) => x.textContent)).toEqual(['Chief of Staff', '<img src=x onerror=alert(1)>Build', 'Loose', 'Deep']);
      // No PIN unlock in the page: the dashboard route is never tried.
      expect(calls.some((c) => c.url.startsWith('/conversation-graph/'))).toBe(false);
    });
  }

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

  it('an agent message shows its inline markdown as styling, built from elements, never markup', async () => {
    const idb = fakeIndexedDB();
    const bd = await import('../../dashboard/console/browser-device.js');
    const { keyPair, publicKey } = await bd.generateDeviceKey();
    idb.stores.set('device', new Map([['m1', { machineId: 'm1', deviceId: 'dev-b1234567', host: 'localhost:4040', status: 'active', keyPair, publicKey, keyHash: await bd.keyHashOf(publicKey) }]]));
    const text = '**Build things.** see `npm test`, [docs](https://example.com/a) and [bad](javascript:alert(1)) <img src=x onerror=alert(1)>';
    const { doc } = await boot((c) => {
      if (c.url.startsWith('/mobile/browser-devices/status')) return { status: 200, body: STATUS };
      if (c.url.startsWith('/mobile/conversations?scope=pool')) return { status: 200, body: { conversations: [{ id: UUID, platform: 'app', title: 'Plans', lastActivity: new Date().toISOString(), lastPreview: '' }], nextCursor: null } };
      if (c.url.startsWith(`/mobile/chat/app/${UUID}/messages`)) return { status: 200, body: { conversationKey: UUID, messages: [{ eventId: 'e1', messageId: 'msg-1', role: 'agent', text, at: new Date().toISOString() }], nextBefore: null } };
      if (c.url.startsWith(`/mobile/chat/app/${UUID}/events`)) return { status: 200, body: { events: [], cursor: 'c1' } };
      return undefined;
    }, `#/work/chats?c=${encodeURIComponent(`app:${UUID}`)}`, idb);
    for (let i = 0; i < 10; i++) await flush();
    const body = doc.querySelector('.chat-bubble.chat-left .chat-text')!;
    expect(body).toBeTruthy();
    expect(body.querySelector('strong')?.textContent).toBe('Build things.');
    expect(body.textContent).not.toContain('**');
    expect(body.querySelector('code')?.textContent).toBe('npm test');
    const links = [...body.querySelectorAll('a')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://example.com/a']);
    expect(links[0].getAttribute('target')).toBe('_blank');
    expect(links[0].getAttribute('rel')).toBe('noopener noreferrer');
    expect(body.textContent).toContain('[bad](javascript:alert(1))');
    expect(body.querySelector('img')).toBeNull();
    expect(body.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});


describe('card source message navigation', () => {
  async function sourcePage(history: (c: Call) => any, target = 'source-event') {
    const idb = fakeIndexedDB();
    const bd = await import('../../dashboard/console/browser-device.js');
    const { keyPair, publicKey } = await bd.generateDeviceKey();
    idb.stores.set('device', new Map([['m1', { machineId: 'm1', deviceId: 'dev-b1234567', host: 'localhost:4040', status: 'active', keyPair, publicKey, keyHash: await bd.keyHashOf(publicKey) }]]));
    const page = await boot(c => {
      if (c.url.startsWith('/mobile/browser-devices/status')) return { status: 200, body: STATUS };
      if (c.url.startsWith('/mobile/conversations?')) return { status: 200, body: { conversations: [{ id: UUID, platform: 'app', title: 'Project planning' }], nextCursor: null } };
      if (c.url.startsWith(`/mobile/chat/app/${UUID}/messages`)) return history(c);
      if (c.url.startsWith(`/mobile/chat/app/${UUID}/events`)) return { status: 200, body: { events: [], cursor: 'c1' } };
      return undefined;
    }, `#/work/chats?c=${encodeURIComponent(`app:${UUID}`)}&m=${encodeURIComponent(target)}`, idb);
    return { ...page, publicKey };
  }
  const message = (eventId: string) => ({ eventId, role: 'agent', text: eventId === 'source-event' ? 'The original request' : 'Later discussion', at: '2026-11-17T12:00:00Z' });
  const reply = (ids: string[], nextBefore: string | null = null) => ({ status: 200, body: { conversationKey: UUID, messages: ids.map(message), nextBefore } });

  it('finds an event id on a later page through signed reads, with explicit continued search', async () => {
    const { doc, publicKey } = await sourcePage(c => {
      const cursor = new URL(c.url, 'http://localhost').searchParams.get('before');
      const n = cursor ? Number(cursor) : 0;
      return n === 7 ? reply(['source-event']) : reply([`event-${n}`], String(n + 1));
    });
    await vi.waitFor(() => expect(doc.querySelector('.chat-source-target')?.textContent).toContain('More history is available'));
    expect(calls.filter(c => c.url.includes('/messages?'))).toHaveLength(6);
    (doc.querySelector('.chat-source-target button') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(doc.querySelector('[data-id="source-event"]')?.classList.contains('chat-flash')).toBe(true));
    expect(doc.querySelector('.chat-source-target')?.textContent).toContain('Original message');
    for (const call of calls.filter(c => c.url.includes('/messages?'))) expect(verifySigned(call, publicKey).ok).toBe(true);
  });

  it.each(['exhausted', 'failed', 'stalled'])('distinguishes %s history without retrying it silently', async kind => {
    const { doc } = await sourcePage(c => {
      if (!c.url.includes('before=')) return reply(['new'], kind === 'exhausted' ? null : '1');
      return kind === 'failed' ? { status: 500 } : reply(['new'], '1');
    });
    const expected = kind === 'exhausted' ? 'not in the available history' : 'Could not read earlier messages';
    await vi.waitFor(() => expect(doc.querySelector('.chat-source-target')?.textContent).toContain(expected));
    expect(calls.filter(c => c.url.includes('/messages?'))).toHaveLength(kind === 'exhausted' ? 1 : 2);
    expect((doc.querySelector('.chat-source-target button') as HTMLButtonElement).hidden).toBe(kind === 'exhausted');
  });

  it('finds a target even if the response repeats its history cursor', async () => {
    const { doc } = await sourcePage(c => c.url.includes('before=') ? reply(['source-event'], '1') : reply(['new'], '1'));
    await vi.waitFor(() => expect(doc.querySelector('[data-id="source-event"]')?.classList.contains('chat-flash')).toBe(true));
    expect(doc.querySelector('.chat-source-target')?.textContent).not.toContain('Could not read');
  });

  it('does not mistake a manual history request for a failed source read', async () => {
    let finish: ((value: any) => void) | undefined;
    let olderCalls = 0;
    const { doc } = await sourcePage(c => {
      if (!c.url.includes('before=')) return reply(['new'], '1');
      return ++olderCalls === 1 ? new Promise(resolve => { finish = resolve; }) : reply(['other-message'], '2');
    });
    await vi.waitFor(() => expect(finish).toBeDefined());
    // Dispatch represents navigation arriving while the source read is still in flight.
    doc.querySelector('.chat-earlier')!.dispatchEvent(new dom.window.Event('click'));
    await vi.waitFor(() => expect(doc.querySelector('[data-id="other-message"]')).toBeTruthy());
    finish!(reply(['source-event'])); await flush(50);
    expect(doc.querySelector('.chat-source-target')?.textContent).toContain('navigation paused');
    expect(doc.querySelector('[data-id="source-event"]')).toBeNull();
    expect(doc.querySelector('.chat-source-target')?.textContent).not.toContain('Could not read');
  });

  it('keeps the draft and ignores a superseded source read on the same conversation', async () => {
    let finish: ((value: any) => void) | undefined;
    const { doc } = await sourcePage(c => c.url.includes('before=') ? new Promise(resolve => { finish = resolve; }) : reply(['new-target'], '1'));
    await vi.waitFor(() => expect(finish).toBeDefined());
    const composer = doc.querySelector('.chat-compose textarea') as HTMLTextAreaElement || doc.querySelector('textarea') as HTMLTextAreaElement;
    expect(composer).toBeTruthy(); composer.value = 'Keep this unsent draft';
    dom.window.location.hash = `#/work/chats?c=${encodeURIComponent(`app:${UUID}`)}&m=new-target`;
    await vi.waitFor(() => expect(doc.querySelector('[data-id="new-target"]')?.classList.contains('chat-flash')).toBe(true));
    finish!(reply(['source-event'])); await flush(50);
    expect(doc.querySelector('textarea')).toBe(composer);
    expect(composer.value).toBe('Keep this unsent draft');
    expect(doc.querySelector('[data-id="source-event"]')).toBeNull();
    expect(calls.filter(c => c.url.includes('/messages?') && !c.url.includes('before='))).toHaveLength(1);
  });

  it('honors the signed reader refusal instead of presenting source content', async () => {
    const { doc } = await sourcePage(() => ({ status: 404 }));
    await vi.waitFor(() => expect(doc.body.textContent).toContain('This conversation is not here any more.'));
    expect(doc.querySelector('.chat-bubble')).toBeNull();
    expect((doc.querySelector('.chat-source-target') as HTMLElement).hidden).toBe(true);
  });

  it('a pasted screenshot and files dropped on the open conversation join the tray; a text paste and a link drag do not (Telegram parity M6/M7)', async () => {
    const idb = fakeIndexedDB();
    const bd = await import('../../dashboard/console/browser-device.js');
    const { keyPair, publicKey } = await bd.generateDeviceKey();
    idb.stores.set('device', new Map([['m1', { machineId: 'm1', deviceId: 'dev-b1234567', host: 'localhost:4040', status: 'active', keyPair, publicKey, keyHash: await bd.keyHashOf(publicKey) }]]));
    const { doc } = await boot((c) => {
      if (c.url.startsWith('/mobile/browser-devices/status')) return { status: 200, body: STATUS };
      if (c.url.startsWith('/mobile/conversations?scope=pool')) return { status: 200, body: { conversations: [{ id: UUID, platform: 'app', title: 'Plans', lastActivity: new Date().toISOString(), lastPreview: '' }], nextCursor: null } };
      if (c.url.startsWith(`/mobile/chat/app/${UUID}/messages`)) return { status: 200, body: { conversationKey: UUID, messages: [], nextBefore: null } };
      if (c.url.startsWith(`/mobile/chat/app/${UUID}/events`)) return { status: 200, body: { events: [], cursor: 'c1' } };
      return undefined;
    }, `#/work/chats?c=${encodeURIComponent(`app:${UUID}`)}`, idb);
    for (let i = 0; i < 10; i++) await flush();
    const W = dom.window as unknown as { File: typeof File; Event: typeof Event };
    const box = doc.querySelector('textarea.chat-compose') as HTMLTextAreaElement;
    const send = doc.querySelector('button.chat-send') as HTMLButtonElement;
    const chips = () => [...doc.querySelectorAll('.chat-file-chip')].map((n) => n.firstChild?.textContent ?? '');
    const fire = (target: Element, type: string, key: 'clipboardData' | 'dataTransfer', data: unknown) => {
      const ev = new W.Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(ev, key, { value: data });
      target.dispatchEvent(ev);
      return ev;
    };
    // A text paste is left to the browser.
    const textPaste = fire(box, 'paste', 'clipboardData', { files: [], items: [{ kind: 'string' }] });
    expect(textPaste.defaultPrevented).toBe(false);
    expect(chips()).toEqual([]);
    // A screenshot paste (a nameless image.png) joins the tray under a readable name.
    const shot = new W.File([new Uint8Array([1, 2, 3])], 'image.png', { type: 'image/png' });
    const imgPaste = fire(box, 'paste', 'clipboardData', { files: [shot] });
    expect(imgPaste.defaultPrevented).toBe(true);
    expect(chips()).toHaveLength(1);
    expect(chips()[0]).toMatch(/^Pasted image \d\d\.\d\d\.\d\d\.png · /);
    expect(send.disabled).toBe(false);
    // A link drag is not ours: the drop is not taken.
    const msgs = doc.querySelector('.chat-messages')!;
    const linkDrop = fire(msgs, 'drop', 'dataTransfer', { types: ['text/uri-list'], files: [] });
    expect(linkDrop.defaultPrevented).toBe(false);
    // Files dragged over the messages light the composer, and the drop adds them.
    fire(msgs, 'dragenter', 'dataTransfer', { types: ['Files'], files: [] });
    expect(doc.querySelector('.chat-composer')!.classList.contains('dropping')).toBe(true);
    const doc1 = new W.File([new Uint8Array([4])], 'notes.pdf', { type: 'application/pdf' });
    const drop = fire(msgs, 'drop', 'dataTransfer', { types: ['Files'], files: [doc1] });
    expect(drop.defaultPrevented).toBe(true);
    expect(doc.querySelector('.chat-composer')!.classList.contains('dropping')).toBe(false);
    expect(chips().map((c) => c.split(' · ')[0])).toEqual([expect.stringMatching(/^Pasted image /), 'notes.pdf']);
    // Removing a chip keeps the other.
    (doc.querySelector('.chat-unpick') as HTMLButtonElement).click();
    expect(chips().map((c) => c.split(' · ')[0])).toEqual(['notes.pdf']);
  });
});


describe('interactive chat history explanations', () => {
  async function openHistory(history: (call: Call) => Promise<{ status: number; body?: unknown }> | { status: number; body?: unknown }) {
    const idb = fakeIndexedDB();
    const bd = await import('../../dashboard/console/browser-device.js');
    const { keyPair, publicKey } = await bd.generateDeviceKey();
    idb.stores.set('device', new Map([['m1', { machineId: 'm1', deviceId: 'dev-b1234567', host: 'localhost:4040', status: 'active', keyPair, publicKey, keyHash: await bd.keyHashOf(publicKey) }]]));
    return boot(c => {
      if (c.url.startsWith('/mobile/browser-devices/status')) return { status: 200, body: STATUS };
      if (c.url.startsWith('/mobile/conversations?scope=pool')) return { status: 200, body: { conversations: [{ id: UUID, platform: 'app', title: 'Plans', lastActivity: new Date().toISOString(), lastPreview: '' }], nextCursor: null } };
      if (c.url.startsWith(`/mobile/chat/app/${UUID}/messages`)) return history(c);
      if (c.url.includes('/events')) return { status: 200, body: { events: [], cursor: 'c1' } };
      return undefined;
    }, `#/work/chats?c=${encodeURIComponent(`app:${UUID}`)}`, idb);
  }

  it('explains a pending first read, names the wait after ten seconds, then explains an empty result', async () => {
    let finish!: (value: { status: number; body: unknown }) => void;
    const pending = new Promise<{ status: number; body: unknown }>(resolve => { finish = resolve; });
    let reads = 0;
    const { doc } = await openHistory(() => { reads++; return pending; });
    expect(doc.querySelector('.chat-history-state')?.textContent).toContain('Loading messages');
    window.dispatchEvent(new dom.window.Event('focus'));
    window.dispatchEvent(new dom.window.Event('focus'));
    await flush(100);
    expect(reads).toBe(1);
    await flush(10_100);
    expect(doc.querySelector('.chat-history-state')?.textContent).toContain('Waiting for the agent to return this conversation');
    finish({ status: 200, body: { messages: [], nextBefore: null } });
    await flush(100);
    expect(doc.querySelector('.chat-history-state')?.textContent).toContain('No messages were returned');
    expect(doc.querySelector('.chat-history-state')?.textContent).not.toContain('Loading');
  }, 20_000);

  it('explains successful empty history without claiming a populated conversation has no history', async () => {
    const { doc } = await openHistory(() => ({ status: 200, body: { messages: [], nextBefore: null } }));
    expect(doc.querySelector('.chat-messages')?.textContent).toContain('No messages were returned');
    expect(doc.querySelector('.chat-history-retry')).not.toBeNull();
    expect(calls.some(c => c.method === 'POST' && /mobile\/chat.*$/.test(c.url))).toBe(false);
  });

  it('retries a failed history read once without changing typed text or sending a message', async () => {
    let reads = 0;
    let finish!: (value: { status: number; body: unknown }) => void;
    const pending = new Promise<{ status: number; body: unknown }>(resolve => { finish = resolve; });
    const { doc } = await openHistory(() => ++reads === 1 ? { status: 503 } : pending);
    const retry = doc.querySelector('.chat-history-retry') as HTMLButtonElement;
    expect(retry).not.toBeNull();
    const compose = doc.querySelector('.chat-compose') as HTMLTextAreaElement;
    compose.value = 'Keep this draft';
    sessionStorage.setItem('instar_chat_unfinished', JSON.stringify([{ ref: `app:${UUID}`, requestId: `${Date.now()}-unfinished`, deviceId: 'dev-b1234567', machineId: 'm1', text: 'Earlier unfinished send', uploads: [], firstSentAt: Date.now() }]));
    retry.click(); retry.click();
    await flush(100);
    expect(reads).toBe(2);
    expect(compose.value).toBe('Keep this draft');
    finish({ status: 200, body: { messages: [{ eventId: 'e1', messageId: 'm1', role: 'agent', text: 'Saved history', at: new Date().toISOString() }], nextBefore: null } });
    await flush(100);
    expect(doc.querySelector('.chat-messages')?.textContent).toContain('Saved history');
    expect((doc.querySelector('.chat-history-state') as HTMLElement).hidden).toBe(true);
    expect(compose.value).toBe('Keep this draft');
    expect(calls.some(c => c.method === 'POST' && /mobile\/chat.*$/.test(c.url))).toBe(false);
  });

  it('keeps messages received from another tab visible while the first history read is pending or empty', async () => {
    let finish!: (value: { status: number; body: unknown }) => void;
    const pending = new Promise<{ status: number; body: unknown }>(resolve => { finish = resolve; });
    const { doc } = await openHistory(() => pending);
    const otherTab = new BroadcastChannel('instar-chat');
    otherTab.postMessage({ type: 'result', mode: 'events', ref: `app:${UUID}`, data: { events: [{ kind: 'message', eventId: 'live-e1', messageId: 'live-m1', role: 'agent', text: 'Already received', at: new Date().toISOString() }] } });
    await flush(100);
    expect(doc.querySelector('.chat-messages')?.textContent).toContain('Already received');
    expect((doc.querySelector('.chat-history-state') as HTMLElement).hidden).toBe(true);
    finish({ status: 200, body: { messages: [], nextBefore: null } });
    await flush(100);
    expect(doc.querySelector('.chat-messages')?.textContent).toContain('Already received');
    expect((doc.querySelector('.chat-history-state') as HTMLElement).hidden).toBe(true);
    otherTab.close();
  });

  it('clears a failed-history notice when a successful background history read recovers', async () => {
    const { doc } = await openHistory(() => ({ status: 503 }));
    expect(doc.querySelector('.chat-history-state')?.textContent).toContain("Couldn't load");
    const otherTab = new BroadcastChannel('instar-chat');
    otherTab.postMessage({ type: 'result', mode: 'pool', ref: `app:${UUID}`, data: { messages: [{ eventId: 'recovered', messageId: 'recovered', role: 'agent', text: 'Recovered messages', at: new Date().toISOString() }], nextBefore: null } });
    await flush(100);
    expect(doc.querySelector('.chat-messages')?.textContent).toContain('Recovered messages');
    expect((doc.querySelector('.chat-history-state') as HTMLElement).hidden).toBe(true);
    otherTab.close();
  });

  it('shares a follower focus read that starts before the retry, without a second signed history request', async () => {
    const originalNavigator = globalThis.navigator;
    vi.stubGlobal('navigator', { userAgent: originalNavigator?.userAgent || 'fixture', locks: { request: () => new Promise(() => {}) } });
    try {
      let reads = 0;
      let finish!: (value: { status: number; body: unknown }) => void;
      const pending = new Promise<{ status: number; body: unknown }>(resolve => { finish = resolve; });
      const { doc } = await openHistory(() => ++reads === 1 ? { status: 503 } : pending);
      window.dispatchEvent(new dom.window.Event('focus'));
      await flush(100);
      expect(reads).toBe(2);
      (doc.querySelector('.chat-history-retry') as HTMLButtonElement).click();
      window.dispatchEvent(new dom.window.Event('focus'));
      await flush(100);
      expect(reads).toBe(2);
      finish({ status: 200, body: { messages: [{ eventId: 'shared', messageId: 'shared', role: 'agent', text: 'One shared history result', at: new Date().toISOString() }], nextBefore: null } });
      await flush(100);
      expect(doc.querySelector('.chat-messages')?.textContent).toContain('One shared history result');
      expect((doc.querySelector('.chat-history-state') as HTMLElement).hidden).toBe(true);
    } finally { vi.unstubAllGlobals(); }
  });

  it('does not apply an old pending history result after leaving the conversation', async () => {
    let finish!: (value: { status: number; body: unknown }) => void;
    const pending = new Promise<{ status: number; body: unknown }>(resolve => { finish = resolve; });
    const { doc } = await openHistory(() => pending);
    location.hash = '#/work/chats';
    window.dispatchEvent(new dom.window.HashChangeEvent('hashchange'));
    await flush(100);
    finish({ status: 200, body: { messages: [{ eventId: 'old', messageId: 'old', role: 'agent', text: 'Old conversation response', at: new Date().toISOString() }] } });
    await flush(100);
    expect(doc.querySelector('.chat-view')?.textContent).not.toContain('Old conversation response');
    expect(doc.querySelector('.chat-history-state')).toBeNull();
  });
});

describe('signed message actions', () => {
  const DEST = '87654321-4321-4321-8321-abcdefabcdef';
  const sourcePath = `/mobile/chat/app/${UUID}`;

  async function actionsPage(actionFields: Record<string, unknown>, handler: Parameters<typeof boot>[0], messageFields = {}) {
    const idb = fakeIndexedDB();
    const bd = await import('../../dashboard/console/browser-device.js');
    const { keyPair, publicKey } = await bd.generateDeviceKey();
    idb.stores.set('device', new Map([['m1', { machineId: 'm1', deviceId: 'dev-b1234567', host: 'localhost:4040', status: 'active', keyPair, publicKey, keyHash: await bd.keyHashOf(publicKey) }]]));
    const { doc } = await boot(async c => {
      if (c.url.startsWith('/mobile/browser-devices/status')) return { status: 200, body: STATUS };
      if (c.url.startsWith('/mobile/conversations?scope=pool')) return { status: 200, body: { conversations: [
        { id: UUID, platform: 'app', title: 'Plans', messageActions: actionFields },
        { id: DEST, platform: 'app', title: 'Notes', messageActions: { forward: { custodianMachineId: 'm1' } } },
      ] } };
      if (c.url.startsWith(sourcePath + '/messages')) return { status: 200, body: { conversationKey: UUID, messages: [
        { eventId: 'e1', messageId: 'msg-1', role: 'agent', text: 'Original text', at: new Date().toISOString(), ...messageFields },
      ] } };
      if (c.url.startsWith(sourcePath + '/events')) return { status: 200, body: { events: [], cursor: 'c1' } };
      return handler(c);
    }, `#/work/chats?c=${encodeURIComponent(`app:${UUID}`)}`, idb);
    await vi.waitFor(() => expect(doc.querySelector('.chat-bubble .chat-text')?.textContent).toBe('Original text'));
    const click = (text: string) => {
      const button = [...doc.querySelectorAll('button')].find(b => b.textContent === text);
      expect(button, text).toBeTruthy();
      button!.click();
    };
    const menu = () => (doc.querySelector('.chat-bubble button[aria-label="Message options"]') as HTMLButtonElement).click();
    return { doc, menu, click, publicKey };
  }

  it('stays dark without a positive source capability', async () => {
    const { doc, menu } = await actionsPage({}, () => undefined);
    menu();
    const options = [...doc.querySelectorAll('[role=dialog] button')].map(button => button.textContent);
    expect(options).not.toContain('Reply');
    expect(options).not.toContain('React');
    expect(options).not.toContain('Forward');
    expect(calls.some(c => /\/(reply|reactions|forward)(\?|$)/.test(c.url))).toBe(false);
  });

  it('signs an exact quoted reply and restores the draft when the original is refused', async () => {
    const { doc, menu, click, publicKey } = await actionsPage({ reply: true }, c =>
      c.url === sourcePath + '/reply' ? { status: 409, body: { error: 'reply-source-unavailable' } } : undefined);
    menu();
    click('Reply');
    expect(doc.body.textContent).toContain('Replying to: Original text');
    const input = doc.querySelector('textarea.chat-compose') as HTMLTextAreaElement;
    input.value = 'Keep this reply';
    input.dispatchEvent(new dom.window.Event('input'));
    click('Send');
    await vi.waitFor(() => expect(input.value).toBe('Keep this reply'));
    const sent = calls.find(c => c.url === sourcePath + '/reply');
    expect(verifySigned(sent!, publicKey).ok).toBe(true);
    expect(JSON.parse(sent!.body!)).toMatchObject({ replyTo: { eventId: 'e1' }, text: 'Keep this reply' });
    expect(doc.body.textContent).toContain('Replying to: Original text');
    expect(calls.some(c => c.method === 'POST' && c.url === sourcePath)).toBe(false);
  });

  it('renders a history quote only after a fresh exact read confirms the preview', async () => {
    const { doc, publicKey } = await actionsPage({ reply: true }, c =>
      c.url === sourcePath + '/reply-previews?eventId=e1' ? { status: 200, body: { conversationKey: UUID,
        messages: [{ eventId: 'e1', reply: { state: 'available', eventId: 'original', preview: 'Current preview' } }],
      } } : undefined,
    { reply: { state: 'available', eventId: 'original', preview: 'Stale history preview' } });
    await vi.waitFor(() => expect(doc.querySelector('blockquote')?.textContent).toBe('Current preview'));
    expect(doc.body.textContent).not.toContain('Stale history preview');
    expect(verifySigned(calls.find(c => c.url.includes('/reply-previews'))!, publicKey).ok).toBe(true);
  });

  it('reads the current reaction and signs a revision-bound change', async () => {
    const { doc, menu, click, publicKey } = await actionsPage({ reactions: { emoji: ['👍'] } }, c =>
      c.url === sourcePath + '/reactions?eventId=e1' ? { status: 200, body: { eventId: 'e1', own: { emoji: null, revision: 2 } } }
        : c.url === sourcePath + '/reactions' ? { status: 200, body: { eventId: 'e1', own: { emoji: '👍', revision: 3 } } } : undefined);
    menu();
    click('React');
    await vi.waitFor(() => expect(doc.body.textContent).toContain('React 👍'));
    click('React 👍');
    await vi.waitFor(() => expect(doc.body.textContent).toContain('Reaction set to 👍.'));
    const sent = calls.find(c => c.method === 'PUT' && c.url === sourcePath + '/reactions');
    expect(verifySigned(sent!, publicKey).ok).toBe(true);
    expect(JSON.parse(sent!.body!)).toMatchObject({ eventId: 'e1', emoji: '👍', expectedRevision: 2 });
  });

  it('forwards to the server-advertised destination and retries an unknown result with the same signed intent', async () => {
    const path = `/mobile/chat/app/${DEST}/forward`;
    let attempts = 0;
    const { doc, menu, click, publicKey } = await actionsPage({ forward: { custodianMachineId: 'm1' } }, c => {
      if (c.url !== path) return undefined;
      return ++attempts === 1 ? { status: 409, body: { error: 'outcome-unknown' } }
        : { status: 200, body: { eventId: 'fwd-event', messageId: 'fwd-message' } };
    });
    menu();
    click('Forward');
    click('Notes');
    await vi.waitFor(() => expect(doc.body.textContent).toContain('Retry: Notes'));
    click('Retry: Notes');
    await vi.waitFor(() => expect(doc.body.textContent).toContain('Forwarded to Notes.'));
    const writes = calls.filter(c => c.method === 'POST' && c.url === path);
    expect(writes).toHaveLength(2);
    expect(writes[0].body).toBe(writes[1].body);
    expect(verifySigned(writes[1], publicKey).ok).toBe(true);
    expect(JSON.parse(writes[1].body!)).toMatchObject({ custodianMachineId: 'm1', sourceConversationKey: UUID, sourceEventId: 'e1' });
  });
});

it('keeps a reader above the bottom in place and follows a tall new message from the bottom', async () => {
  const idb = fakeIndexedDB();
  const bd = await import('../../dashboard/console/browser-device.js');
  const { keyPair, publicKey } = await bd.generateDeviceKey();
  idb.stores.set('device', new Map([['m1', { machineId: 'm1', deviceId: 'dev-b1234567', host: 'localhost:4040', status: 'active', keyPair, publicKey, keyHash: await bd.keyHashOf(publicKey) }]]));
  const message = (id: number) => ({ eventId: `scroll-${id}`, messageId: `msg-${id}`, kind: 'message', role: 'agent',
    text: `Message ${id}`, at: new Date(Date.UTC(2026, 10, 25, 10, id)).toISOString() });
  const messages = Array.from({ length: 6 }, (_, i) => message(i + 1));
  const path = `/mobile/chat/app/${UUID}`;
  const { doc } = await boot(c => {
    if (c.url.startsWith('/mobile/browser-devices/status')) return { status: 200, body: STATUS };
    if (c.url.startsWith('/mobile/conversations?scope=pool')) return { status: 200, body: { conversations: [{ id: UUID, platform: 'app', title: 'Plans' }] } };
    if (c.url.startsWith(path + '/messages')) return { status: 200, body: { messages, nextBefore: null } };
    if (c.url.startsWith(path + '/events')) return { status: 200, body: { events: messages.slice(6), cursor: `cursor-${messages.length}` } };
    return undefined;
  }, `#/work/chats?c=app%3A${UUID}`, idb);
  const log = doc.querySelector('.chat-messages') as HTMLElement;
  await vi.waitFor(() => expect(log.querySelector('[data-id="scroll-6"]')).toBeTruthy());
  let top = 250;
  const height = () => [...log.querySelectorAll('[data-id]')].reduce((sum, row) => sum + (row.getAttribute('data-id') === 'scroll-8' ? 400 : 100), 0);
  Object.defineProperties(log, {
    clientHeight: { get: () => 300 },
    scrollHeight: { get: height },
    scrollTop: { get: () => top, set: (value: number) => { top = Math.max(0, Math.min(value, height() - 300)); } },
  });
  messages.push(message(7));
  window.dispatchEvent(new dom.window.Event('focus'));
  await vi.waitFor(() => expect(log.querySelector('[data-id="scroll-7"]')).toBeTruthy());
  expect(top).toBe(250);
  const pill = doc.querySelector('.chat-new-messages') as HTMLButtonElement;
  expect(pill.hidden).toBe(false);
  pill.click();
  expect(top).toBe(400);
  expect(pill.hidden).toBe(true);

  messages.push(message(8));
  window.dispatchEvent(new dom.window.Event('focus'));
  await vi.waitFor(() => expect(log.querySelector('[data-id="scroll-8"]')).toBeTruthy());
  expect(top).toBe(800);
  expect(pill.hidden).toBe(true);
});
