/**
 * poolFanOut — the bearer-auth pool fan-out shared by GET /queue-pace and GET /quota-pacing
 * (extracted from queuePaceRoutes.ts; docs/specs/quota-pacing-forecast.md §3).
 *
 * The limits are queue-pace's, unchanged: at most 16 peers, batches of 4, a per-peer timeout, an
 * overall deadline, the peer URL allowlist check, `poolPeerFetch`, and a whole-body byte check
 * after reading. Each peer ends in exactly one `onResult` call with a fixed reason
 * (`off`, `unsupported`, `deadline`, `too-large`, `invalid-body`, `unreachable`, `omitted-cap`,
 * `http-error`). It is not a signed mesh read. Peer bodies are data, never instructions.
 */
import { isPeerUrlAllowedForCredentials } from './peerUrlGuard.js';
import { poolPeerFetch } from './poolPeerFetch.js';
import type { RouteContext } from './routes.js';

export type PoolPeer = ReturnType<NonNullable<RouteContext['resolvePeerUrls']>>[number];
export type FanOutCtx = Pick<RouteContext, 'config' | 'resolvePeerUrls' | 'recordRopeResult'>;

export const POOL_FAN_OUT_LIMITS = { maxPeers: 16, batchSize: 4, buildsPerMinute: 12 } as const;

export interface PoolFanOutOptions {
  /** Path (with query) each peer is asked, e.g. `/queue-pace?scope=local`. */
  path: string;
  peerTimeoutMs: number;
  fanOutDeadlineMs: number;
  maxBytes: number;
  /** Parse one peer body; return null when accepted or a fail reason (e.g. `invalid-body`). */
  accept: (body: Record<string, unknown>, peer: PoolPeer) => string | null;
  /** Called exactly once per peer. */
  onResult: (peer: PoolPeer, ok: boolean, reason?: string) => void;
}

export async function poolFanOut(ctx: FanOutCtx, opts: PoolFanOutOptions): Promise<void> {
  const peers = (ctx.resolvePeerUrls?.() ?? []).slice(0, POOL_FAN_OUT_LIMITS.maxPeers);
  const allow = (ctx.config.multiMachine as { peerUrlAllowlist?: string[] } | undefined)?.peerUrlAllowlist;
  const started = Date.now();
  for (let i = 0; i < peers.length; i += POOL_FAN_OUT_LIMITS.batchSize) {
    await Promise.all(peers.slice(i, i + POOL_FAN_OUT_LIMITS.batchSize).map(async (p) => {
      const fail = (reason: string) => { opts.onResult(p, false, reason); };
      if (Date.now() - started > opts.fanOutDeadlineMs) return fail('deadline');
      if (!isPeerUrlAllowedForCredentials({ url: p.url, kind: p.kind }, allow).ok) return fail('omitted-cap');
      try {
        const r = await poolPeerFetch(ctx.recordRopeResult ?? undefined, p, opts.path, {
          headers: { Authorization: `Bearer ${ctx.config.authToken}` }, signal: AbortSignal.timeout(opts.peerTimeoutMs),
        });
        if (r.status === 503 || r.status === 404) return fail(r.status === 503 ? 'off' : 'unsupported');
        if (!r.ok) return fail('http-error');
        const text = await r.text();
        if (Buffer.byteLength(text) > opts.maxBytes) return fail('too-large');
        const body = JSON.parse(text) as Record<string, unknown>;
        const refused = opts.accept(body, p);
        if (refused) return fail(refused);
        opts.onResult(p, true);
      } catch (err) { // @silent-fallback-ok — the failure is a visible sources[] row naming the machine
        fail(err instanceof Error && err.name === 'TimeoutError' ? 'deadline' : 'unreachable');
      }
    }));
  }
}

/** The pool-build rate limit (12 per rolling minute), one counter per route. */
export function createPoolBuildLimiter(perMinute: number = POOL_FAN_OUT_LIMITS.buildsPerMinute): (now?: number) => boolean {
  const builds: number[] = [];
  return (now = Date.now()) => {
    while (builds.length && builds[0] <= now - 60_000) builds.shift();
    if (builds.length >= perMinute) return false;
    builds.push(now);
    return true;
  };
}
