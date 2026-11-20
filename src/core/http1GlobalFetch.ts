/**
 * Keep Node's global `fetch` on HTTP/1.1, whatever Node version runs instar.
 *
 * Why (2026-11-20 outage post-mortem, A3): Node 26 bundles undici 8, whose default
 * dispatcher negotiates HTTP/2 with any host that offers it (Telegram, Slack, the Claude
 * API, every Cloudflare-fronted tunnel). Node 22 and 24 stay on HTTP/1.1. On the Node 26
 * machine the agent server's main thread got stuck in `Http2Session::SendPendingData`,
 * packing frames for a stream that no longer existed, and its memory grew by gigabytes a
 * minute (10-37 GB, killed five times in 16 hours). The same agent on Node 22 never did.
 * Every outbound request instar makes through `fetch` works on HTTP/1.1, so the protocol
 * Node 22 already uses is pinned for every version.
 *
 * How: the Agent class that Node's fetch understands is Node's OWN bundled undici, which is
 * not importable. The npm `undici` package is a different copy, and Node 26's fetch refuses
 * an undici 6.x dispatcher outright (see telegram-egress.ts). So one `data:` fetch makes
 * Node create its default dispatcher, and that dispatcher's own constructor builds the
 * replacement with `allowH2: false`. A dispatcher someone else installed on purpose (a proxy
 * agent from a preload, a test mock) is left alone and reported.
 *
 * `node:http2` used directly (APNs in MobilePush.ts) is not affected: Apple requires
 * HTTP/2 there.
 *
 * Opt-out: INSTAR_ALLOW_FETCH_HTTP2=1.
 */

/** Node keeps its fetch dispatcher on globalThis under one of these (newest first). */
export const GLOBAL_DISPATCHER_SYMBOLS: readonly symbol[] = [
  Symbol.for('undici.globalDispatcher.2'), // undici 7+ (Node 26)
  Symbol.for('undici.globalDispatcher.1'), // undici 5/6 (Node 20, 22, 24)
];

/** Dispatcher classes whose options accept `allowH2` and that Node installs by itself. */
const REPLACEABLE = new Set(['Agent', 'EnvHttpProxyAgent']);

const PINNED = Symbol.for('instar.fetchHttp1Pinned');

export type Http1PinResult =
  | { status: 'pinned'; slot: string; dispatcher: string; node: string; undici: string | undefined }
  | { status: 'already-pinned' }
  | { status: 'opted-out' }
  | { status: 'left-alone'; reason: 'no-global-dispatcher' | 'custom-dispatcher'; dispatcher?: string }
  | { status: 'failed'; error: string };

type G = Record<symbol, unknown>;

let lastResult: Http1PinResult | null = null;

/** The outcome of the last pin attempt in this process (null before the first). */
export function http1PinStatus(): Http1PinResult | null { return lastResult; }

/**
 * Replace Node's default fetch dispatcher with an identical one that never negotiates
 * HTTP/2. Idempotent; never throws (a failure is returned and logged, and fetch keeps
 * working on Node's default).
 */
export async function pinGlobalFetchToHttp1(opts: {
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
} = {}): Promise<Http1PinResult> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((line: string) => console.warn(line));
  const g = globalThis as unknown as G;
  if (env.INSTAR_ALLOW_FETCH_HTTP2 === '1') return (lastResult = { status: 'opted-out' });
  if (g[PINNED]) return (lastResult = { status: 'already-pinned' });
  try {
    // Makes Node create its default dispatcher; no network I/O.
    await fetch('data:,').then((r) => r.arrayBuffer()).catch(() => undefined); // @silent-fallback-ok — an unreadable data: URL still initialises the dispatcher; the slot check below decides
    const slot = GLOBAL_DISPATCHER_SYMBOLS.find((s) => g[s] != null);
    if (!slot) return (lastResult = { status: 'left-alone', reason: 'no-global-dispatcher' });
    const current = g[slot] as { constructor?: new (o: Record<string, unknown>) => unknown } | null;
    const Ctor = current?.constructor;
    const name = typeof Ctor === 'function' ? Ctor.name : typeof current;
    if (typeof Ctor !== 'function' || !REPLACEABLE.has(Ctor.name)) {
      log(`[http1-fetch] left Node's fetch dispatcher alone: it is a ${name}, not one Node installs by itself`);
      return (lastResult = { status: 'left-alone', reason: 'custom-dispatcher', dispatcher: name });
    }
    g[slot] = new Ctor({ allowH2: false });
    g[PINNED] = true;
    return (lastResult = {
      status: 'pinned', slot: slot.description ?? String(slot), dispatcher: Ctor.name,
      node: process.version, undici: process.versions.undici,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log(`[http1-fetch] could not keep fetch on HTTP/1.1 (${error}); fetch uses Node's default protocol choice in this process`);
    return (lastResult = { status: 'failed', error });
  }
}

/** For tests: forget the pin marker so a fresh dispatcher can be pinned again. */
export function resetHttp1PinForTests(): void {
  delete (globalThis as unknown as G)[PINNED];
  lastResult = null;
}
