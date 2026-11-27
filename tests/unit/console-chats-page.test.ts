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
import { File as NodeFile } from 'node:buffer';
import { verifyDeviceRequest, ReplayGuard, parseDevicePublicKey } from '../../src/core/MobileDeviceKeys.js';

// Logic fixture only. Real CryptoKey cloning, transaction and restart durability are proved in
// console-chat-outbox-browser.test.ts with actual isolated Chrome, not this model.
function fakeIndexedDB() {
  const stores = new Map<string, Map<any, any>>(); // Preserve the existing device seeding seam.
  const databases = new Map<string, any>();
  const clone = (value: any) => value === undefined ? undefined : structuredClone(value);
  const token = (key: any) => Array.isArray(key) ? `array:${JSON.stringify(key)}` : key;
  const keyOf = (value: any, keyPath: string | string[]) => Array.isArray(keyPath)
    ? keyPath.map((key) => value[key]) : value[keyPath];
  const compare = (a: any, b: any): number => {
    if (Array.isArray(a) && Array.isArray(b)) {
      for (let i = 0; i < Math.min(a.length, b.length); i++) { const c = compare(a[i], b[i]); if (c) return c; }
      return a.length - b.length;
    }
    return a === b ? 0 : a < b ? -1 : 1;
  };
  const matches = (key: any, query: any) => query == null || (typeof query === 'object' && !Array.isArray(query) && typeof query.includes === 'function' ? query.includes(key) : compare(key, query) === 0);
  const keyRange = {
    only(value: any) { return this.bound(value, value); },
    bound(lower: any, upper: any, lowerOpen = false, upperOpen = false) {
      return { lower, upper, lowerOpen, upperOpen, includes: (key: any) => (lowerOpen ? compare(key, lower) > 0 : compare(key, lower) >= 0) && (upperOpen ? compare(key, upper) < 0 : compare(key, upper) <= 0) };
    },
  };
  return {
    stores, keyRange,
    open(name: string, version = 1) {
      const r: any = {};
      setTimeout(() => {
        let model = databases.get(name);
        if (!model) {
          model = { stores: name === 'instar-console' ? stores : new Map(), schema: new Map(), version: 0, running: false, queue: [] };
          for (const storeName of model.stores.keys()) model.schema.set(storeName, { keyPath: 'machineId', indexes: new Map() });
          databases.set(name, model);
        }
        const db: any = {
          objectStoreNames: { contains: (n: string) => model.stores.has(n) },
          createObjectStore(n: string, opts: { keyPath?: string | string[] } = {}) {
            if (model.stores.has(n)) throw new DOMException('Store exists', 'ConstraintError');
            model.stores.set(n, new Map());
            const schema = { keyPath: opts.keyPath, indexes: new Map() }; model.schema.set(n, schema);
            return { createIndex(index: string, keyPath: string | string[]) { schema.indexes.set(index, keyPath); } };
          },
          transaction(names: string | string[], mode = 'readonly') {
            const included = Array.isArray(names) ? names : [names];
            for (const n of included) if (!model.stores.has(n)) throw new DOMException('Unknown store', 'NotFoundError');
            let working: Map<string, Map<any, any>>;
            let active = false, ended = false, aborted = false, pending = 0, completing: ReturnType<typeof setTimeout> | undefined;
            const jobs: Array<() => void> = [];
            const t: any = { mode, error: null };
            const release = () => { model.running = false; const next = model.queue.shift(); if (next) next(); };
            const abort = (reason?: any) => {
              if (ended) return;
              aborted = true; ended = true; t.error = reason || new DOMException('Aborted', 'AbortError');
              if (completing) clearTimeout(completing);
              setTimeout(() => { t.onabort?.({ target: t }); if (active) release(); }, 0);
            };
            t.abort = () => abort();
            const completion = () => {
              if (!active || ended || pending) return;
              if (completing) clearTimeout(completing);
              completing = setTimeout(() => {
                if (ended || pending) return;
                if (mode === 'readwrite') for (const n of included) {
                  const target = model.stores.get(n); target.clear();
                  for (const [key, value] of working.get(n)!) target.set(key, clone(value));
                }
                ended = true; t.oncomplete?.({ target: t }); release();
              }, 0);
            };
            const request = (fn: () => any, reuse?: any) => {
              if (ended) throw new DOMException('Inactive transaction', 'TransactionInactiveError');
              const req: any = reuse || {}; pending++;
              const job = () => setTimeout(() => {
                if (aborted || ended) return;
                try { req.result = fn(); req.onsuccess?.({ target: req }); }
                catch (e) { req.error = e; req.onerror?.({ target: req }); t.onerror?.({ target: t }); abort(e); }
                finally { pending--; completion(); }
              }, 0);
              if (active) job(); else jobs.push(job);
              return req;
            };
            const writable = () => { if (mode !== 'readwrite') throw new DOMException('Readonly', 'ReadOnlyError'); };
            const storeFor = (n: string): any => {
              if (!included.includes(n)) throw new DOMException('Unknown store', 'NotFoundError');
              const schema = model.schema.get(n);
              const store: any = {
                name: n,
                get: (key: any) => request(() => clone(working.get(n)!.get(token(key)))),
                getAll: () => request(() => [...working.get(n)!.values()].map(clone)),
                put: (value: any, explicit?: any) => {
                  writable(); const captured = clone(value);
                  return request(() => { const key = explicit ?? keyOf(captured, schema.keyPath); working.get(n)!.set(token(key), captured); return key; });
                },
                delete: (key: any) => { writable(); return request(() => working.get(n)!.delete(token(key))); },
                clear: () => { writable(); return request(() => working.get(n)!.clear()); },
              };
              const cursor = (query: any, indexPath = schema.keyPath) => {
                let rows: any[] | undefined; let i = 0; const req: any = {};
                const next = () => request(() => {
                  rows ||= [...working.get(n)!.values()].map((value) => ({ key: keyOf(value, indexPath), primaryKey: keyOf(value, schema.keyPath), value: clone(value) }))
                    .filter((row) => matches(row.key, query)).sort((a, b) => compare(a.key, b.key) || compare(a.primaryKey, b.primaryKey));
                  const row = rows[i++];
                  return row ? { ...row, continue: next, delete: () => store.delete(row.primaryKey) } : null;
                }, req);
                return next();
              };
              store.openCursor = (query: any) => cursor(query);
              store.index = (index: string) => {
                if (!schema.indexes.has(index)) throw new DOMException('Unknown index', 'NotFoundError');
                return { openCursor: (query: any) => cursor(query, schema.indexes.get(index)) };
              };
              return store;
            };
            t.objectStore = storeFor;
            const start = () => {
              if (ended) { release(); return; }
              model.running = true; active = true;
              working = new Map(included.map((n) => [n, new Map([...model.stores.get(n)].map(([key, value]: any[]) => [key, clone(value)]))]));
              for (const job of jobs.splice(0)) job(); completion();
            };
            if (model.running) model.queue.push(start); else { model.running = true; setTimeout(start, 0); }
            return t;
          },
          close() {},
        };
        r.result = db;
        try {
          if (version < model.version) throw new DOMException('Older database version', 'VersionError');
          if (version > model.version) { r.onupgradeneeded?.({ oldVersion: model.version, newVersion: version, target: r }); model.version = version; }
          r.onsuccess?.({ target: r });
        } catch (e) { r.error = e; r.onerror?.({ target: r }); }
      }, 0);
      return r;
    },
  };
}

// Test-only scheduling model, not proof of browser ownership. Actual Web Locks run in Chrome.
// A test that must run as a follower tab sets a never-granted lock here; bootPage installs it.
let locksOverride: unknown = null;
function serializedLocks() {
  const tails = new Map<string, Promise<unknown>>();
  return { request(name: string, options: any, callback?: any) {
    const fn = typeof options === 'function' ? options : callback;
    const signal: AbortSignal | undefined = typeof options === 'function' ? undefined : options?.signal;
    let cancelled = signal?.aborted || false;
    const previous = tails.get(name) || Promise.resolve();
    const work = previous.catch(() => {}).then(() => {
      if (cancelled) throw new DOMException('Aborted', 'AbortError');
      return fn({ name, mode: 'exclusive' });
    });
    tails.set(name, work.catch(() => {}));
    if (!signal) return work;
    return new Promise((resolve, reject) => {
      const stop = () => { cancelled = true; reject(new DOMException('Aborted', 'AbortError')); };
      signal.addEventListener('abort', stop, { once: true });
      if (cancelled) stop();
      work.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
    });
  } };
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
const pageOutboxes = new Set<{ dispose: () => void }>();

function disposePage() {
  // A console-lifetime runner outlives page navigation, so stop it explicitly between test windows.
  for (const controller of pageOutboxes) controller.dispose();
  pageOutboxes.clear();
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
  g.IDBKeyRange = idb.keyRange;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
  Object.defineProperty(dom.window.navigator, 'locks', { configurable: true, value: locksOverride ?? serializedLocks() });
  g.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(cb, 0);
  dom.window.localStorage.setItem('instar_token', 'tok');
  calls = [];
  g.fetch = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array } = {}) => {
    const owner = bootContext.getStore();
    if (owner !== undefined && owner !== bootGeneration) return new Promise<Response>(() => { /* an earlier test's page: never answered */ });
    const c: Call = { url, method: init.method || 'GET', headers: init.headers || {}, body: typeof init.body === 'string' ? init.body : init.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : undefined };
    calls.push(c);
    const base: Record<string, unknown> = {
      '/sessions': { sessions: [] }, '/health': { project: { name: 'echo' } }, '/dashboard/unlock-check': { accepted: true },
    };
    const out = await handler(c) ?? (base[url] !== undefined ? { status: 200, body: base[url] } : { status: 404, body: {} });
    return { ok: out.status >= 200 && out.status < 300, status: out.status, json: async () => JSON.parse(JSON.stringify(out.body ?? {})), headers: new dom.window.Headers() } as unknown as Response;
  };
  vi.resetModules();
  const outboxModule = await import('../../dashboard/console/outbox-runner.js');
  const beginOutbox = outboxModule.beginConsoleOutbox;
  vi.spyOn(outboxModule, 'beginConsoleOutbox').mockImplementation(async (options) => {
    const controller = await beginOutbox(options); pageOutboxes.add(controller); return controller;
  });
  const lifecycleModule = await import('../../dashboard/console/page-lifecycle.js');
  const createLifecycle = lifecycleModule.createLifecycle;
  vi.spyOn(lifecycleModule, 'createLifecycle').mockImplementation((options) => {
    const lifecycle = createLifecycle(options);
    pageLifecycles.add(lifecycle);
    return lifecycle;
  });
  const chatsModule = await import('../../dashboard/console/chats.js');
  const renderChats = chatsModule.renderChats;
  let page: any;
  vi.spyOn(chatsModule, 'renderChats').mockImplementation((...args: any[]) => { page = renderChats(...args); return page; });
  await import('../../dashboard/console/console.js');
  for (let i = 0; i < 10; i++) await flush();
  return { doc: dom.window.document, idb, get page() { return page; } };
}

afterEach(() => {
  disposePage();
  for (const c of pageChannels) { try { c.close(); } catch { /* already closed */ } }
  pageChannels.clear();
  dom?.window.close();
});

// The production status route samples the server clock per answer. A frozen stamp would rewind
// the corrected client clock at every retry and keep a valid cooldown perpetually in the future.
const STATUS = { enabled: true, machineId: 'm1', nickname: 'Studio', get serverTime() { return Date.now(); }, approvalPath: 'dashboard', approveEnabled: true, telegramSend: true, key: { state: 'active' }, outbox: { version: 1, enabled: true, text: true, media: true, recoveryGeneration: 'test-generation-1', stopPhrases: ['stop', '/stop', 'stop everything', 'emergency stop', 'kill all sessions'] }, limits: { maxFiles: 10, maxMessageBytes: 64 << 20, maxFileBytes: 50 << 20, chunkBytes: 1 << 20 } };
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
    idb.stores.set('device', new Map([['m_slack', { machineId: 'm_slack', deviceId: 'dev-b1234567', host: 'localhost:4040', status: 'active', keyPair, publicKey, keyHash: await bd.keyHashOf(publicKey) }]]));
    const at = new Date().toISOString();
    const reads: string[] = [];
    let sent: Call | null = null;
    const { doc } = await boot((c) => {
      if (c.url.startsWith('/mobile/browser-devices/status')) return { status: 200, body: { ...STATUS, machineId: 'm_slack' } };
      if (c.url.startsWith('/mobile/conversations?scope=pool')) return { status: 200, body: { conversations: [{ id: -126660833, platform: 'slack', title: '#proof', lastActivity: at, lastPreview: 'hi', machine: 'm_slack' }], nextCursor: null } };
      if (c.url.startsWith('/mobile/chat/slack/-126660833/messages')) {
        reads.push(c.url);
        if (!/[?&]machine=m_slack(&|$)/.test(c.url)) return { status: 400, body: { error: 'machine-required' } };
        return { status: 200, body: { conversationKey: 'slack:T1:C1', messages: [{ eventId: 'slack:1.1', role: 'operator', text: 'Slack inbound', at }] } };
      }
      if (c.url === '/mobile/chat/slack/-126660833' && c.method === 'POST') { sent = c; return { status: 200, body: { ok: true, outcome: 'delivered', eventId: 'op-1', messageId: 'msg-slack-1', deliveryState: 'delivered' } }; }
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

  it('keeps a remote-holder Slack send saved for review and starts no write on the wrong machine', async () => {
    const idb = fakeIndexedDB();
    const bd = await import('../../dashboard/console/browser-device.js');
    const { keyPair, publicKey } = await bd.generateDeviceKey();
    idb.stores.set('device', new Map([['m1', { machineId: 'm1', deviceId: 'dev-b1234567', host: 'localhost:4040', status: 'active', keyPair, publicKey, keyHash: await bd.keyHashOf(publicKey) }]]));
    const { doc } = await boot((c) => {
      if (c.url.startsWith('/mobile/browser-devices/status')) return { status: 200, body: STATUS };
      if (c.url.startsWith('/mobile/conversations?scope=pool')) return { status: 200, body: { conversations: [{ id: -126660833, platform: 'slack', title: '#remote', lastActivity: new Date().toISOString(), machine: 'm_slack' }], nextCursor: null } };
      // The server can proxy this signed read; mobileSlackRoutes does not proxy a write.
      if (c.url.startsWith('/mobile/chat/slack/-126660833/messages')) return { status: 200, body: { conversationKey: 'slack:T1:C1', messages: [], nextBefore: null } };
      if (c.url === '/mobile/chat/slack/-126660833' && c.method === 'POST') return { status: 409, body: { error: 'wrong-machine' } };
      return undefined;
    }, `#/work/chats?c=${encodeURIComponent('slack:-126660833')}`, idb);
    for (let i = 0; i < 10; i++) await flush();
    const box = doc.querySelector('textarea.chat-compose') as HTMLTextAreaElement;
    expect(box).toBeTruthy(); box.value = 'Keep my message for the original Slack holder';
    box.dispatchEvent(new dom.window.Event('input'));
    (doc.querySelector('button.chat-send') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(doc.querySelector('.chat-pending')?.textContent).toContain('machine that holds this Slack conversation'));
    expect(calls.filter((c) => c.url === '/mobile/chat/slack/-126660833' && c.method === 'POST')).toHaveLength(0);
    const controller = (await import('../../dashboard/console/outbox-runner.js')).getConsoleOutbox()!;
    const saved = await controller.store.list(controller.session, controller.record);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ phase: 'held', text: 'Keep my message for the original Slack holder', slackHolder: 'm_slack', actor: { machineId: 'm1' } });
    expect(JSON.parse(saved[0].finalBody).machine).toBe('m_slack');
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

describe('durable send admission', () => {
  it('keeps the actual draft and starts no send when durable admission fails', async () => {
    const idb = fakeIndexedDB();
    const bd = await import('../../dashboard/console/browser-device.js');
    const { keyPair, publicKey } = await bd.generateDeviceKey();
    idb.stores.set('device', new Map([['m1', { machineId: 'm1', deviceId: 'dev-b1234567', host: 'localhost:4040', status: 'active', keyPair, publicKey, keyHash: await bd.keyHashOf(publicKey) }]]));
    const { doc } = await boot((c) => {
      if (c.url.startsWith('/mobile/browser-devices/status')) return { status: 200, body: STATUS };
      if (c.url.startsWith('/mobile/conversations?scope=pool')) return { status: 200, body: { conversations: [{ id: UUID, platform: 'app', title: 'Plans', lastActivity: new Date().toISOString() }], nextCursor: null } };
      if (c.url.startsWith(`/mobile/chat/app/${UUID}/messages`)) return { status: 200, body: { conversationKey: UUID, messages: [], nextBefore: null } };
      if (c.url.startsWith(`/mobile/chat/app/${UUID}/events`)) return { status: 200, body: { events: [], cursor: 'c1' } };
      if (c.url === `/mobile/chat/app/${UUID}` && c.method === 'POST') return { status: 200, body: { ok: true, messageId: 'should-not-send', deliveryState: 'delivered' } };
      return undefined;
    }, `#/work/chats?c=${encodeURIComponent(`app:${UUID}`)}`, idb);
    for (let i = 0; i < 10; i++) await flush();
    const box = doc.querySelector('textarea.chat-compose') as HTMLTextAreaElement;
    expect(box).not.toBeNull();
    box.value = 'Keep my offline draft';
    box.dispatchEvent(new dom.window.Event('input'));
    idb.open = () => { throw new DOMException('The disk is full', 'QuotaExceededError'); };
    (doc.querySelector('button.chat-send') as HTMLButtonElement).click();
    for (let i = 0; i < 10; i++) await flush();
    expect(box.value).toBe('Keep my offline draft');
    expect(calls.filter((c) => c.url === `/mobile/chat/app/${UUID}` && c.method === 'POST')).toHaveLength(0);
  });
  async function activeDraftPage(override?: (c: Call) => any) {
    const idb = fakeIndexedDB();
    const bd = await import('../../dashboard/console/browser-device.js');
    const { keyPair, publicKey } = await bd.generateDeviceKey();
    idb.stores.set('device', new Map([['m1', { machineId: 'm1', deviceId: 'dev-b1234567', host: 'localhost:4040', status: 'active', keyPair, publicKey, keyHash: await bd.keyHashOf(publicKey) }]]));
    const opened = await boot((c) => {
      const overridden = override?.(c); if (overridden !== undefined) return overridden;
      if (c.url.startsWith('/mobile/browser-devices/status')) return { status: 200, body: STATUS };
      if (c.url.startsWith('/mobile/conversations?scope=pool')) return { status: 200, body: { conversations: [{ id: UUID, platform: 'app', title: 'Plans', lastActivity: new Date().toISOString() }], nextCursor: null } };
      if (c.url.startsWith(`/mobile/chat/app/${UUID}/messages`)) return { status: 200, body: { conversationKey: UUID, messages: [], nextBefore: null } };
      if (c.url.startsWith(`/mobile/chat/app/${UUID}/events`)) return { status: 200, body: { events: [], cursor: 'c1' } };
      return undefined;
    }, `#/work/chats?c=${encodeURIComponent(`app:${UUID}`)}`, idb);
    const controller = (await import('../../dashboard/console/outbox-runner.js')).getConsoleOutbox()!;
    await vi.waitFor(() => expect(controller.record?.deviceId).toBe('dev-b1234567'));
    return { ...opened, controller };
  }

  it('preserves a newer draft and file tray while an earlier captured send finishes durable admission', async () => {
    const { doc, controller } = await activeDraftPage();
    Object.defineProperty(dom.window.navigator, 'onLine', { configurable: true, value: false });
    const original = controller.store.admit.bind(controller.store);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const admission = vi.spyOn(controller.store, 'admit').mockImplementation(async (...args: any[]) => { await gate; return original(...args); });
    const composer = doc.querySelector('textarea.chat-compose') as HTMLTextAreaElement;
    const paste = (file: NodeFile) => {
      const ev = new dom.window.Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'clipboardData', { value: { files: [file] } }); composer.dispatchEvent(ev);
    };
    const firstBytes = Buffer.from('old selected file bytes');
    const oldFile = new NodeFile([firstBytes], 'old-note.txt', { type: 'text/plain' });
    const newFile = new NodeFile(['new selected bytes'], 'new-note.txt', { type: 'text/plain' });
    composer.value = 'The original captured send'; composer.dispatchEvent(new dom.window.Event('input')); paste(oldFile);
    (doc.querySelector('button.chat-send') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(admission).toHaveBeenCalledTimes(1));
    expect(await controller.store.list(controller.session, controller.record)).toEqual([]);
    composer.value = 'A newer draft I am still writing'; composer.dispatchEvent(new dom.window.Event('input')); paste(newFile);
    expect([...doc.querySelectorAll('.chat-file-chip')].map((n) => n.firstChild?.textContent?.split(' · ')[0])).toEqual(['old-note.txt', 'new-note.txt']);
    release();
    await vi.waitFor(() => expect([...doc.querySelectorAll('.chat-file-chip')].map((n) => n.firstChild?.textContent?.split(' · ')[0])).toEqual(['new-note.txt']));
    expect(doc.querySelector('textarea.chat-compose')).toBe(composer);
    expect(composer.value).toBe('A newer draft I am still writing');
    const saved = await controller.store.list(controller.session, controller.record);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ text: 'The original captured send', files: [{ filename: 'old-note.txt', size: firstBytes.length, sha256: crypto.createHash('sha256').update(firstBytes).digest('hex') }] });
    expect(new TextDecoder().decode(await controller.store.part(controller.session, controller.record, saved[0], 0, 0))).toBe(firstBytes.toString());
    expect(calls.filter((c) => c.method === 'POST' && (c.url === `/mobile/chat/app/${UUID}` || c.url === '/mobile/media/uploads'))).toHaveLength(0);
  });

  it.each(['cancel', 'secret drop'])('does not admit credential-shaped text while its choice is open or after %s', async (choice) => {
    const { doc, controller } = await activeDraftPage();
    const admission = vi.spyOn(controller.store, 'admit');
    const composer = doc.querySelector('textarea.chat-compose') as HTMLTextAreaElement;
    composer.value = 'my key is ghp_' + 'A'.repeat(36); composer.dispatchEvent(new dom.window.Event('input'));
    (doc.querySelector('button.chat-send') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(doc.body.textContent).toContain('This looks like a password or key.'));
    expect(admission).not.toHaveBeenCalled();
    expect(await controller.store.list(controller.session, controller.record)).toEqual([]);
    if (choice === 'cancel') (doc.querySelector('.sheet-close') as HTMLButtonElement).click();
    else ([...doc.querySelectorAll('button')].find((b) => b.textContent === 'Use a Secret Drop link') as HTMLButtonElement).click();
    for (let i = 0; i < 5; i++) await flush();
    expect(admission).not.toHaveBeenCalled();
    expect(await controller.store.list(controller.session, controller.record)).toEqual([]);
    expect(calls.filter((c) => c.method === 'POST' && (c.url === `/mobile/chat/app/${UUID}` || c.url === '/mobile/media/uploads'))).toHaveLength(0);
  });

  it('offers exact local file copies for an expired held send without discarding it or the current draft', async () => {
    const { doc, controller, page } = await activeDraftPage();
    Object.defineProperty(dom.window.navigator, 'onLine', { configurable: true, value: false });
    page.releaseLeadership();
    await vi.waitFor(() => expect(controller.running).toBeNull());
    const bd = await import('../../dashboard/console/browser-device.js');
    const original = new Uint8Array([0, 1, 2, 255, 127, 42]);
    const selected = new NodeFile([original], 'held-original.bin', { type: 'application/octet-stream' });
    const saved = await controller.store.admit(controller.session, controller.record, {
      requestId: bd.newRequestId(Date.now()), ref: `app:${UUID}`, path: `/mobile/chat/app/${UUID}`,
      actor: controller.record, text: 'Expired original with retained file bytes', phase: 'held', holdCode: 'expired',
      reason: 'The original upload expired. Your file is still saved.', stopEvidence: 'unmatched', recoveryGeneration: STATUS.outbox.recoveryGeneration,
    }, [selected], { chunkBytes: STATUS.limits.chunkBytes, maxMessageBytes: STATUS.limits.maxMessageBytes });
    await controller.refreshView();
    const composer = doc.querySelector('textarea.chat-compose') as HTMLTextAreaElement;
    composer.value = 'A different current draft'; composer.dispatchEvent(new dom.window.Event('input'));
    let captured: Blob | undefined;
    const url = 'blob:http://localhost:4040/held-file-copy';
    const create = vi.spyOn(URL, 'createObjectURL').mockImplementation((blob: Blob) => { captured = blob; return url; });
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const networkBefore = calls.length;
    try {
      const save = [...doc.querySelectorAll('button')].find((b) => b.textContent === 'Save file copies') as HTMLButtonElement;
      expect(save).toBeTruthy(); save.click();
      await vi.waitFor(() => expect(doc.querySelector('a[download="held-original.bin"]')).toBeTruthy());
      const link = doc.querySelector('a[download="held-original.bin"]') as HTMLAnchorElement;
      expect(link.textContent).toBe('Save held-original.bin'); expect(link.href).toBe(url);
      expect(captured).toBeDefined();
      expect(new Uint8Array(await captured!.arrayBuffer())).toEqual(original);
      expect((await controller.store.get(controller.session, controller.record, saved.requestId))?.requestId).toBe(saved.requestId);
      expect(composer.value).toBe('A different current draft');
      expect(calls).toHaveLength(networkBefore);
      (doc.querySelector('.sheet-close') as HTMLButtonElement).click();
      expect(revoke).toHaveBeenCalledWith(url);
      expect(doc.querySelector('[role="dialog"]')).toBeNull();
    } finally { create.mockRestore(); revoke.mockRestore(); }
  });

  it('keeps removal open with a retry message when the saved-copy snapshot is stale', async () => {
    const { doc, controller } = await activeDraftPage();
    Object.defineProperty(dom.window.navigator, 'onLine', { configurable: true, value: false });
    const bd = await import('../../dashboard/console/browser-device.js');
    const saved = await controller.store.admit(controller.session, controller.record, {
      requestId: bd.newRequestId(Date.now()), ref: `app:${UUID}`, path: `/mobile/chat/app/${UUID}`,
      actor: controller.record, text: 'Keep this saved copy unless removal succeeds', phase: 'held', holdCode: 'unknown',
      reason: 'Check the conversation.', stopEvidence: 'unmatched', recoveryGeneration: STATUS.outbox.recoveryGeneration,
    }, [], { chunkBytes: STATUS.limits.chunkBytes, maxMessageBytes: STATUS.limits.maxMessageBytes });
    await controller.refreshView();
    const remove = vi.spyOn(controller, 'remove').mockResolvedValue(false);
    ([...doc.querySelectorAll('button')].find((b) => b.textContent === 'Remove saved copy') as HTMLButtonElement).click();
    const confirm = [...doc.querySelectorAll('button')].find((b) => b.textContent === 'Remove this saved copy') as HTMLButtonElement;
    confirm.click(); await vi.waitFor(() => expect(remove).toHaveBeenCalledTimes(1)); await flush();
    const dialog = doc.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toMatch(/changed|retry|try again|could not|not removed/i);
    expect(confirm.disabled).toBe(false);
    expect((await controller.store.get(controller.session, controller.record, saved.requestId))?.requestId).toBe(saved.requestId);
    expect(calls.filter((c) => c.method === 'POST' && c.url === `/mobile/chat/app/${UUID}`)).toHaveLength(0);
  });

  it('keeps Updating through actual registered reconnect event pages without remounting the newer composer', async () => {
    let armed = false;
    let releaseSecond!: (value: any) => void;
    const eventReads: string[] = [];
    const opened = await activeDraftPage((c) => {
      if (!armed || !c.url.startsWith(`/mobile/chat/app/${UUID}/events`)) return undefined;
      eventReads.push(c.url);
      if (c.url.includes('cursor=after-hundred')) return new Promise((resolve) => { releaseSecond = resolve; });
      return { status: 200, body: {
        events: Array.from({ length: 100 }, (_, i) => ({ kind: 'message', eventId: `catchup-${i}`, messageId: `catchup-message-${i}`, role: 'agent', text: `Actual update ${i}`, at: new Date().toISOString() })),
        cursor: 'after-hundred',
      } };
    });
    const { doc, page } = opened;
    page.releaseLeadership();
    const composer = doc.querySelector('textarea.chat-compose') as HTMLTextAreaElement;
    composer.value = 'A newer draft during real catch-up'; composer.dispatchEvent(new dom.window.Event('input'));
    const selected = new NodeFile(['retained selected bytes'], 'catchup-file.txt', { type: 'text/plain' });
    const pasted = new dom.window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(pasted, 'clipboardData', { value: { files: [selected] } }); composer.dispatchEvent(pasted);
    armed = true;
    dom.window.dispatchEvent(new dom.window.Event('offline'));
    dom.window.dispatchEvent(new dom.window.Event('online'));
    await vi.waitFor(() => expect(releaseSecond).toBeDefined());
    const line = doc.querySelector('.net-line') as HTMLElement;
    expect(line.dataset.mode).toBe('updating'); expect(line.hidden).toBe(false);
    expect(doc.querySelector('textarea.chat-compose')).toBe(composer);
    expect(composer.value).toBe('A newer draft during real catch-up');
    expect(doc.querySelector('.chat-file-chip')?.textContent).toContain('catchup-file.txt');
    await globalThis.fetch('/health');
    expect(line.dataset.mode).toBe('updating');
    releaseSecond({ status: 200, body: { events: [], cursor: 'caught-up' } });
    await vi.waitFor(() => expect(line.dataset.mode).toBe('fresh'));
    expect(line.hidden).toBe(true);
    expect(eventReads.some((url) => url.includes('cursor=after-hundred'))).toBe(true);
    expect(doc.querySelector('textarea.chat-compose')).toBe(composer);
    expect(composer.value).toBe('A newer draft during real catch-up');
    expect(doc.querySelector('.chat-file-chip')?.textContent).toContain('catchup-file.txt');
    expect(calls.filter((c) => c.method === 'POST' && c.url === `/mobile/chat/app/${UUID}`)).toHaveLength(0);
  });

  it('keeps a newer composer draft until the person explicitly replaces it with saved text', async () => {
    const { doc, controller } = await activeDraftPage();
    Object.defineProperty(dom.window.navigator, 'onLine', { configurable: true, value: false });
    const bd = await import('../../dashboard/console/browser-device.js');
    await controller.store.admit(controller.session, controller.record, {
      requestId: bd.newRequestId(Date.now()), ref: `app:${UUID}`, path: `/mobile/chat/app/${UUID}`,
      actor: controller.record, text: 'Earlier held saved text', phase: 'held', holdCode: 'unknown',
      reason: 'Check the conversation before making a new send.', stopEvidence: 'unmatched', recoveryGeneration: STATUS.outbox.recoveryGeneration,
    }, [], { chunkBytes: STATUS.limits.chunkBytes, maxMessageBytes: STATUS.limits.maxMessageBytes });
    await controller.refreshView();
    const composer = doc.querySelector('textarea.chat-compose') as HTMLTextAreaElement;
    composer.value = 'A newer unsent draft'; composer.dispatchEvent(new dom.window.Event('input'));
    const selected = new NodeFile(['new file content'], 'newer-file.txt', { type: 'text/plain' });
    const pasted = new dom.window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(pasted, 'clipboardData', { value: { files: [selected] } }); composer.dispatchEvent(pasted);
    const useSaved = () => ([...doc.querySelectorAll('button')].find((b) => b.textContent === 'Use text in composer') as HTMLButtonElement).click();
    useSaved();
    expect(composer.value).toBe('A newer unsent draft');
    const keep = [...doc.querySelectorAll('button')].find((b) => b.textContent === 'Keep current draft') as HTMLButtonElement;
    expect(keep).toBeTruthy(); keep.click();
    expect(composer.value).toBe('A newer unsent draft');
    useSaved(); expect(composer.value).toBe('A newer unsent draft');
    const replace = [...doc.querySelectorAll('button')].find((b) => b.textContent === 'Use saved text') as HTMLButtonElement;
    expect(replace).toBeTruthy(); replace.click();
    expect(composer.value).toBe('Earlier held saved text');
    expect(doc.querySelector('textarea.chat-compose')).toBe(composer);
    expect(doc.querySelector('.chat-file-chip')?.textContent).toContain('newer-file.txt');
    expect(calls.filter((c) => c.method === 'POST' && c.url === `/mobile/chat/app/${UUID}`)).toHaveLength(0);
  });

});


describe('definitive reconnect startup outcomes', () => {
  it.each([503, 401, 403])('finishes catch-up after network Retry receives definitive HTTP %i', async (status) => {
    let current: 'network' | 'definite' = 'network';
    const opened = await boot((c) => {
      if (c.url.startsWith('/mobile/browser-devices/status')) {
        if (current === 'network') throw new TypeError('Network unavailable');
        return { status, body: { error: status === 503 ? 'browser-devices-off' : 'refused' } };
      }
      return undefined;
    });
    await vi.waitFor(() => expect(opened.page?.startOutcome).toBe('network'));
    expect(opened.doc.body.textContent).toContain("Couldn't reach the agent");
    current = 'definite';
    expect(await opened.page.reconnectPage()).toBe(true);
    expect(opened.page.startOutcome).toBe('definite');
    if (status === 503) expect(opened.doc.body.textContent).toContain('Conversations in the dashboard are switched off');
    expect(calls.filter((c) => c.method === 'POST' && c.url.startsWith('/mobile/chat/'))).toHaveLength(0);
  });

  it('does not call a still-unreachable startup a completed catch-up', async () => {
    const opened = await boot((c) => {
      if (c.url.startsWith('/mobile/browser-devices/status')) throw new TypeError('Network unavailable');
      return undefined;
    });
    await vi.waitFor(() => expect(opened.page?.startOutcome).toBe('network'));
    expect(await opened.page.reconnectPage()).toBe(false);
  });

  it('a delayed revoked-other-machine answer cannot delete a replacement enrollment', async () => {
    const idb = fakeIndexedDB(); const bd = await import('../../dashboard/console/browser-device.js');
    const oldKeys = await bd.generateDeviceKey(); const newKeys = await bd.generateDeviceKey();
    const old = { machineId: 'm1', deviceId: 'old-device', host: 'localhost:4040', status: 'active', ...oldKeys, keyHash: await bd.keyHashOf(oldKeys.publicKey) };
    const replacement = { machineId: 'm1', deviceId: 'replacement-device', host: 'localhost:4040', status: 'active', ...newKeys, keyHash: await bd.keyHashOf(newKeys.publicKey) };
    idb.stores.set('device', new Map([['m1', old]]));
    let finish!: (value: any) => void;
    const opened = await boot((c) => {
      if (c.url.startsWith(`/mobile/browser-devices/status?keyHash=${old.keyHash}`)) return new Promise((resolve) => { finish = resolve; });
      if (c.url.startsWith('/mobile/browser-devices/status')) return { status: 200, body: { ...STATUS, machineId: 'm2' } };
      return undefined;
    }, '#/work/chats', idb);
    await vi.waitFor(() => expect(finish).toBeDefined());
    idb.stores.get('device')!.set('m1', replacement);
    finish({ status: 200, body: { ...STATUS, machineId: 'm2', key: { state: 'revoked' } } });
    await vi.waitFor(() => expect(opened.doc.body.textContent).toContain('identity changed while it was being checked'));
    expect(idb.stores.get('device')!.get('m1')?.keyHash).toBe(replacement.keyHash);
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
    // bootPage installs its own navigator, so the never-granted lock goes through locksOverride.
    locksOverride = { request: () => new Promise(() => {}) };
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
    } finally { locksOverride = null; }
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
