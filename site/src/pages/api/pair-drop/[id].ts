// The pair-drop point for "Pair a computer" (docs/specs/mac-qr-pairing.md §5).
// A phone leaves one sealed blob under a random slot id the computer showed in its QR code; the
// computer polls for it. The blob is HPKE-sealed to a key only that computer holds, so this route
// sees ciphertext only and can never pair anything. It is dumb (decides nothing), short-lived (slots
// expire 120 s after they are written) and optional (pasting a pairing link works without it).
// Reads never delete, so a lost answer can be read again, and a writer that finds the slot occupied
// is told 409 (best effort: two racing writers can both be accepted). No body and no id is logged.
// Storage: Vercel Runtime Cache (part of the hosting plan), best effort: non-durable, per region, no
// conditional write. Safety never depends on it (the computer opens only a blob sealed to its key and
// waits for a click). Keys are used verbatim: the library's default key hash is 32 bits, so two
// random slots could otherwise share an entry. The deployed health check proves the shared cache is
// in use (the library's last fallback is a per-instance memory cache).
import type { APIRoute } from 'astro';
import * as vercelFunctions from '@vercel/functions';

// The package is CommonJS: Node cannot see its named exports from an ES module import, so take them
// from the module object (default when the runtime wraps it, the namespace when a bundler does not).
const vf = ((vercelFunctions as unknown as { default?: typeof vercelFunctions }).default ?? vercelFunctions);
const { getCache } = vf;
/** The request context exactly as the pinned library reads it (@vercel/functions 3.10.4, get-context.js; not exported). */
function getContext(): { cache?: unknown } {
  const holder = (globalThis as Record<symbol, { get?: () => { cache?: unknown } } | undefined>)[Symbol.for('@vercel/request-context')];
  return holder?.get?.() ?? {};
}

export const prerender = false;

export const SLOT_TTL_SECONDS = 120;
export const MAX_BLOB_CHARS = 2048;
const ID_RE = /^[A-Za-z0-9_-]{22}$/;
/** Random per module load: a GET whose tag differs from its PUT's proves delivery across instances. */
const INSTANCE = Math.random().toString(36).slice(2, 10);
const BLOB_RE = /^[A-Za-z0-9_-]+$/;

/** The two cache operations the route needs; Vercel Runtime Cache in production, a map in tests. */
export interface DropStore {
  get(key: string): Promise<unknown | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

/** Which cache path served the call: `context` (the platform's request cache), `env`, or `none`. */
type StorePath = 'context' | 'env' | 'none';
const text = (status: number, body = ''): Response =>
  new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });

/** The whole behavior, independent of Astro and Vercel so it can be tested directly. */
export async function pairDrop(method: string, id: string | undefined, body: string, also: string | null, store: DropStore | null): Promise<Response> {
  if (method !== 'PUT' && method !== 'GET') return text(405);
  if (!id || !ID_RE.test(id)) return text(400, 'bad-id');
  if (also !== null && !ID_RE.test(also)) return text(400, 'bad-id');
  if (!store) return text(503, 'unavailable');
  try {
    if (method === 'GET') {
      for (const slot of also ? [id, also] : [id]) {
        const v = await store.get(`pd:${slot}`);
        if (typeof v === 'string' && v) return text(200, v);
      }
      return text(404);
    }
    const blob = body.trim();
    if (blob.length > MAX_BLOB_CHARS) return text(413, 'too-large');
    if (!blob || !BLOB_RE.test(blob)) return text(400, 'bad-blob');
    // Best effort: 409 only when a value is observed; two racing writers can both get 201.
    if (await store.get(`pd:${id}`)) return text(409, 'taken');
    await store.set(`pd:${id}`, blob, SLOT_TTL_SECONDS);
    return text(201);
  } catch {
    console.warn(`pair-drop ${method}: store unavailable`);
    return text(503, 'unavailable');
  }
}

/**
 * Whether the library would use a shared cache, by the same test it applies (@vercel/functions 3.10.4,
 * cache/index.js): the request context's cache, else one named by the environment. Otherwise it
 * would fall back to a per-instance memory cache, which is refused (503).
 */
export function sharedCachePath(env: NodeJS.ProcessEnv = process.env, ctx: () => { cache?: unknown } = getContext): StorePath {
  if (ctx()?.cache) return 'context';
  if (env.RUNTIME_CACHE_DISABLE_BUILD_CACHE === 'true') return 'none';
  return env.RUNTIME_CACHE_ENDPOINT && env.RUNTIME_CACHE_HEADERS ? 'env' : 'none';
}

function storeFor(path: StorePath): DropStore | null {
  if (path === 'none') return null;
  const cache = getCache({ namespace: 'pair-mac-v1', keyHashFunction: (k: string) => k });
  return {
    get: (key) => cache.get(key),
    set: (key, value, ttl) => cache.set(key, value, { ttl, name: 'pair-drop' }),
  };
}

const handle: APIRoute = async ({ request, params, url }) => {
  const body = request.method === 'PUT' ? await request.text().catch(() => '') : '';
  // A body far past the cap is refused before anything else.
  if (body.length > MAX_BLOB_CHARS * 4) return text(413, 'too-large');
  let path: StorePath = 'none';
  let store: DropStore | null = null;
  try { path = sharedCachePath(); store = storeFor(path); } catch { path = 'none'; store = null; }
  const res = await pairDrop(request.method, params.id, body, url.searchParams.get('also'), store);
  res.headers.set('X-Pair-Drop-Store', path);
  res.headers.set('X-Pair-Drop-Instance', INSTANCE);
  return res;
};

export const GET = handle;
export const PUT = handle;
