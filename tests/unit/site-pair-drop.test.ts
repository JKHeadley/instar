/** instar.sh pair-drop point (docs/specs/mac-qr-pairing.md §5): sealed blobs only, first writer wins, reads never delete. */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const ROUTE = path.join(__dirname, '../../site/src/pages/api/pair-drop/[id].ts');
// Loaded from a copy outside site/ (the site's own install is not resolvable from the root), with
// the one runtime import pointed at a stub that records whether the real cache would be asked for.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-drop-'));
afterAll(() => SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/site-pair-drop.test.ts' }));

type Mod = {
  pairDrop: (m: string, id: string | undefined, body: string, also: string | null, store: unknown) => Promise<Response>;
  GET: (ctx: unknown) => Promise<Response>;
  PUT: (ctx: unknown) => Promise<Response>;
  SLOT_TTL_SECONDS: number; MAX_BLOB_CHARS: number;
};
async function load(): Promise<Mod> {
  // The stub applies the options the route passes the way the library does (namespace + key function).
  fs.writeFileSync(path.join(tmp, 'functions-stub.mjs'), [
    'const djb = (k) => { let h = 5381; for (let i = 0; i < k.length; i++) h = ((h << 5) + h + k.charCodeAt(i)) >>> 0; return h.toString(16); };',
    'export default { getCache: (...a) => getCache(...a) };',
    'export const getCache = (o = {}) => { globalThis.__cacheOpts = o; const s = globalThis.__cacheStore; const key = (k) => `${o.namespace ?? ""}$${(o.keyHashFunction ?? djb)(k)}`;',
    '  return { get: (k) => s.get(key(k)), set: (k, v, opt) => s.set(key(k), v, opt) }; };',
  ].join('\n'));
  const src = fs.readFileSync(ROUTE, 'utf8');
  expect(src).toContain("import * as vercelFunctions from '@vercel/functions';");
  fs.writeFileSync(path.join(tmp, 'pair-drop.ts'), src.replace("from '@vercel/functions'", "from './functions-stub.mjs'"));
  return await import(pathToFileURL(path.join(tmp, 'pair-drop.ts')).href) as Mod;
}
function memStore(now: () => number) {
  const kv = new Map<string, { v: string; until: number }>();
  return {
    kv,
    async get(k: string) { const e = kv.get(k); if (e && e.until <= now()) { kv.delete(k); return null; } return e ? e.v : null; },
    async set(k: string, v: string, ttl: number) { kv.set(k, { v, until: now() + ttl * 1000 }); },
  };
}
// The platform hands a function its request context through this global (as the library reads it).
const setCtx = (ctx: unknown) => { (globalThis as Record<symbol, unknown>)[Symbol.for('@vercel/request-context')] = { get: () => ctx }; };
const ID = 'AbCdEfGhIjKlMnOpQrStUv';
const ID2 = 'ZyXwVuTsRqPoNmLkJiHgFe';
const BLOB = 'c2VhbGVkLWJsb2ItYnl0ZXM';

describe('pair-drop', () => {
  it('stores once, tells a second writer 409, and reads never delete', async () => {
    const { pairDrop } = await load();
    const s = memStore(() => 0);
    expect((await pairDrop('PUT', ID, BLOB, null, s)).status).toBe(201);
    const first = await pairDrop('GET', ID, '', null, s);
    expect(first.status).toBe(200);
    expect(await first.text()).toBe(BLOB);
    expect(first.headers.get('Cache-Control')).toBe('no-store');
    // A lost answer can be read again, and a writer after the read is still refused.
    expect((await pairDrop('GET', ID, '', null, s)).status).toBe(200);
    expect((await pairDrop('PUT', ID, 'b3RoZXI', null, s)).status).toBe(409);
    expect(await (await pairDrop('GET', ID, '', null, s)).text()).toBe(BLOB);
  });

  it('one read covers the current and the previous slot', async () => {
    const { pairDrop } = await load();
    const s = memStore(() => 0);
    expect((await pairDrop('GET', ID, '', ID2, s)).status).toBe(404);
    await pairDrop('PUT', ID2, BLOB, null, s);
    expect(await (await pairDrop('GET', ID, '', ID2, s)).text()).toBe(BLOB);
    expect((await pairDrop('GET', ID, '', 'bad', s)).status).toBe(400);
  });

  it('a slot is gone 120 seconds after it was written', async () => {
    const { pairDrop, SLOT_TTL_SECONDS } = await load();
    expect(SLOT_TTL_SECONDS).toBe(120);
    let t = 0; const s = memStore(() => t);
    await pairDrop('PUT', ID, BLOB, null, s);
    t = 119_000; expect((await pairDrop('GET', ID, '', null, s)).status).toBe(200);
    t = 120_001; expect((await pairDrop('GET', ID, '', null, s)).status).toBe(404);
  });

  it('refuses bad ids, bad or oversized blobs and other methods', async () => {
    const { pairDrop, MAX_BLOB_CHARS } = await load();
    const s = memStore(() => 0);
    expect((await pairDrop('PUT', 'short', BLOB, null, s)).status).toBe(400);
    expect((await pairDrop('PUT', ID, 'not base64url!', null, s)).status).toBe(400);
    expect((await pairDrop('PUT', ID, '', null, s)).status).toBe(400);
    expect((await pairDrop('PUT', ID, 'A'.repeat(MAX_BLOB_CHARS + 1), null, s)).status).toBe(413);
    expect((await pairDrop('DELETE', ID, '', null, s)).status).toBe(405);
    expect(s.kv.size).toBe(0);
  });

  it('a failing store answers 503, never 500, and logs no body and no id', async () => {
    const { pairDrop } = await load();
    const broken = { get: async () => { throw new Error('down'); }, set: async () => { throw new Error('down'); } };
    const logs: string[] = [];
    const orig = console.warn; console.warn = (m: string) => logs.push(m);
    try { expect((await pairDrop('PUT', ID, BLOB, null, broken)).status).toBe(503); } finally { console.warn = orig; }
    expect(logs.join(' ')).not.toContain(BLOB);
    expect(logs.join(' ')).not.toContain(ID.slice(0, 4));
  });

  it('uses the shared cache only by the library\'s own test, and refuses the per-instance memory cache', async () => {
    const m = await load() as Mod & { sharedCachePath: (env: Record<string, string>, ctx: () => { cache?: unknown }) => string };
    expect(m.sharedCachePath({}, () => ({ cache: {} }))).toBe('context');
    expect(m.sharedCachePath({ RUNTIME_CACHE_ENDPOINT: 'e', RUNTIME_CACHE_HEADERS: '{}' }, () => ({}))).toBe('env');
    expect(m.sharedCachePath({ RUNTIME_CACHE_ENDPOINT: 'e', RUNTIME_CACHE_HEADERS: '{}', RUNTIME_CACHE_DISABLE_BUILD_CACHE: 'true' }, () => ({}))).toBe('none');
    expect(m.sharedCachePath({}, () => ({}))).toBe('none');
    setCtx({});
    const saved = { e: process.env.RUNTIME_CACHE_ENDPOINT, h: process.env.RUNTIME_CACHE_HEADERS };
    delete process.env.RUNTIME_CACHE_ENDPOINT; delete process.env.RUNTIME_CACHE_HEADERS;
    try {
      const r = await m.GET({ request: new Request(`https://instar.sh/api/pair-drop/${ID}`), params: { id: ID }, url: new URL(`https://instar.sh/api/pair-drop/${ID}`) });
      expect(r.status).toBe(503);
      expect(r.headers.get('X-Pair-Drop-Store')).toBe('none');
    } finally {
      if (saved.e !== undefined) process.env.RUNTIME_CACHE_ENDPOINT = saved.e;
      if (saved.h !== undefined) process.env.RUNTIME_CACHE_HEADERS = saved.h;
    }
  });

  it('asks the platform cache for verbatim keys, so the 32-bit default hash cannot merge two slots', async () => {
    const { PUT, GET } = await load();
    const kv = new Map<string, string>();
    setCtx({ cache: {} });
    (globalThis as { __cacheStore?: unknown }).__cacheStore = { get: async (k: string) => kv.get(k) ?? null, set: async (k: string, v: string) => { kv.set(k, v); } };
    // Two valid slots that the library's default key hash maps to the same entry (found in round-2 review).
    const A = 'Xvb98yUTqnzRH3K-zPEyuQ', B = 'C6uC5X19QzP9Qn5Uv4NDYg';
    const call = (h: (c: unknown) => Promise<Response>, id: string, method: string, body?: string) =>
      h({ request: new Request(`https://instar.sh/api/pair-drop/${id}`, { method, body }), params: { id }, url: new URL(`https://instar.sh/api/pair-drop/${id}`) });
    expect((await call(PUT as never, A, 'PUT', BLOB)).status).toBe(201);
    expect((await call(GET, B, 'GET')).status).toBe(404);
    const got = await call(GET, A, 'GET');
    expect(got.status).toBe(200);
    expect(got.headers.get('X-Pair-Drop-Store')).toBe('context');
    const opts = (globalThis as { __cacheOpts?: { namespace?: string; keyHashFunction?: (k: string) => string } }).__cacheOpts;
    expect(opts?.namespace).toBe('pair-mac-v1');
    expect(opts?.keyHashFunction?.('pd:abc')).toBe('pd:abc');
  });
});
