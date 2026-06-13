/**
 * Express middleware — JSON parsing, CORS, auth, error handling.
 */

import type { Request, Response, NextFunction } from 'express';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const guardedResponses = new WeakSet<Response>();
const GUARDED_RESPONSE_METHODS = ['json', 'send', 'sendStatus', 'redirect', 'download', 'sendFile'] as const;

function responseAlreadyCommitted(res: Response): boolean {
  return res.headersSent || res.writableEnded;
}

function logDuplicateResponse(req: Request, method: string): void {
  const stack = new Error().stack?.split('\n').slice(2).join('\n');
  console.warn(
    `[server] Suppressed duplicate response send: ${req.method} ${req.originalUrl || req.url} via res.${method}()`
    + (stack ? `\n${stack}` : ''),
  );
}

/**
 * Prevent a late duplicate Express response from throwing
 * ERR_HTTP_HEADERS_SENT after a handler has already committed a response.
 *
 * This is a last-resort process guard; route handlers should still return
 * immediately after early response branches.
 */
export function duplicateResponseGuard(req: Request, res: Response, next: NextFunction): void {
  if (guardedResponses.has(res)) {
    next();
    return;
  }
  guardedResponses.add(res);

  for (const method of GUARDED_RESPONSE_METHODS) {
    const original = res[method].bind(res) as (...args: unknown[]) => Response;
    (res[method] as unknown as (...args: unknown[]) => Response) = (...args: unknown[]) => {
      if (responseAlreadyCommitted(res)) {
        logDuplicateResponse(req, method);
        return res;
      }
      return original(...args);
    };
  }

  next();
}

export function corsMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Restrict CORS to localhost origins only — this is a local management API
  const origin = req.headers.origin;
  if (origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
}

/**
 * In-memory dedup cache for deprecation log lines.
 *
 * Per spec § Layer 1c "Backward upgrade path": when a client sends a
 * Bearer token without `X-Instar-AgentId`, we accept the request during
 * the deprecation window, but log it at most once per hour per source.
 * The "source" key is the token's SHA-256 prefix (we never log the token
 * itself) plus the request remote — a bare-token caller behind a fixed
 * IP rotates faster than caller behind shifting IPs, but neither floods.
 */
const deprecationLogCache = new Map<string, number>();
const DEPRECATION_LOG_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const DEPRECATION_LOG_CACHE_MAX = 1024; // bound memory

function shouldLogDeprecation(sourceKey: string, now: number = Date.now()): boolean {
  const last = deprecationLogCache.get(sourceKey);
  if (last !== undefined && now - last < DEPRECATION_LOG_INTERVAL_MS) {
    return false;
  }
  // Bound memory: when at cap, drop the oldest entry before insert.
  if (deprecationLogCache.size >= DEPRECATION_LOG_CACHE_MAX) {
    const oldestKey = deprecationLogCache.keys().next().value;
    if (oldestKey !== undefined) deprecationLogCache.delete(oldestKey);
  }
  deprecationLogCache.set(sourceKey, now);
  return true;
}

/** Test hook — clear the deprecation log cache. */
export function _resetDeprecationLogCache(): void {
  deprecationLogCache.clear();
}

/**
 * Auth middleware — enforces Bearer token on API endpoints.
 * Health endpoint is exempt (used for external monitoring).
 *
 * @param authToken  The configured server bearer token, or a getter that
 *   returns it. A getter is resolved on EVERY request so the token can be
 *   rotated at runtime (tunnel credential rotation, Part 6 of the
 *   tunnel-failure-resilience spec) and take effect immediately — old
 *   bearer tokens and old HMAC-signed view URLs are rejected the moment
 *   rotation completes, without a server restart. If omitted (or the
 *   getter returns undefined), all requests pass through (used in tests
 *   and unauthenticated dev runs).
 * @param agentId    The configured server agent identity (e.g. projectName).
 *   When set, the middleware additionally validates the
 *   `X-Instar-AgentId` request header BEFORE comparing the bearer
 *   token. A mismatch returns a structured 403 — the goal is to make
 *   tokens sent to the wrong agent's server structurally inert before
 *   token bytes are even compared. Missing header is accepted during
 *   the backward-compatibility deprecation window with a deduped log
 *   line. See spec docs/specs/telegram-delivery-robustness.md § Layer 1b.
 */
export function authMiddleware(authToken?: string | (() => string | undefined), agentId?: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Resolve the token per-request so runtime rotation takes effect
    // immediately (a getter is re-read on every request).
    const resolvedToken = typeof authToken === 'function' ? authToken() : authToken;

    // Skip auth if no token configured
    if (!resolvedToken) {
      next();
      return;
    }

    // Health endpoint is always public (Phase 0 migration: will require auth in future)
    if (req.path === '/health') {
      next();
      return;
    }

    // Ping endpoint is always public (lightweight health check for external monitors)
    if (req.path === '/ping') {
      next();
      return;
    }

    // SSE endpoints handle auth inline (supports both header and query param for EventSource)
    if (req.path === '/jobs/events') {
      next();
      return;
    }

    // Dashboard unlock (PIN → token exchange) is unauthenticated by design
    if (req.path === '/dashboard/unlock' && req.method === 'POST') {
      next();
      return;
    }

    // Message relay endpoints use their own auth (agent tokens / machine-HMAC),
    // not the general API bearer token. Auth is enforced in the route handlers.
    // /a2a/inbox is the same-machine a2a transport — callers hold the TARGET
    // agent's per-agent token (from AgentRegistry), not the API bearer token,
    // so the inbox route enforces `verifyAgentToken` in its handler.
    if (req.path === '/messages/relay-agent' || req.path === '/messages/relay-machine' || req.path === '/a2a/inbox') {
      next();
      return;
    }

    // /mesh/rpc is the §L0 Multi-Machine Session Pool machine-to-machine command
    // transport. It is authed by the signed, recipient-bound MeshEnvelope (Ed25519
    // verify → RBAC → nonce-burn in the dispatcher), NOT the API bearer token — a
    // shared bearer token cannot work cross-machine, since each install holds its
    // own authToken. So it is exempt from the bearer gate here; the dispatcher in
    // the route handler rejects any envelope that fails verification. WITHOUT this
    // exemption every cross-machine MeshRpc call (capacity/session-status,
    // deliverMessage, place/claim/transfer) 401s before the envelope is ever
    // checked — i.e. the entire pool is non-functional over the wire.
    if (req.path === '/mesh/rpc') {
      next();
      return;
    }

    // Threadline protocol endpoints use their own auth (relay tokens + Ed25519 signatures).
    // Handshake and health endpoints are unauthenticated by design.
    // Authenticated threadline endpoints enforce Threadline-Relay auth in route handlers.
    if (req.path.startsWith('/threadline/')) {
      next();
      return;
    }

    // Internal endpoints: enforce localhost AND bearer token.
    //
    // Per context-death-pitfall-prevention spec § P0.5 (PR3 fix):
    // /internal/* routes are bearer-token authenticated using the
    // same .instar/config.json#authToken. The prior localhost-only
    // check left a gap: any process on the local machine could flip
    // the stop-gate kill-switch or drive /internal/stop-gate/evaluate
    // without credentials. Drift-correction threat model accepts that
    // a truly adversarial session with token access can still bypass;
    // this closes the casual-process gap.
    //
    // Additionally: reject /internal/* when X-Forwarded-For is set
    // (spec P0.5: advisory defense-in-depth against tunnel
    // misconfiguration; a Cloudflare tunnel accidentally routing
    // internal paths to the LAN should not succeed).
    if (req.path.startsWith('/internal/')) {
      const remote = req.socket.remoteAddress;
      if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
        res.status(403).json({ error: 'Internal routes are localhost-only' });
        return;
      }
      if (req.headers['x-forwarded-for']) {
        res.status(403).json({ error: 'Internal routes reject X-Forwarded-For requests' });
        return;
      }
      // Fall through to the standard bearer check below.
    }

    // Secret drop routes — the token in the URL IS the auth.
    // GET serves the form, POST receives the submission. Both are user-facing.
    if (req.path.startsWith('/secrets/drop/')) {
      next();
      return;
    }

    // View routes support signed URLs for browser access (see ?sig= below)
    if (req.path.startsWith('/view/') && req.method === 'GET') {
      const sig = typeof req.query.sig === 'string' ? req.query.sig : null;
      if (sig && verifyViewSignature(req.path, sig, resolvedToken)) {
        next();
        return;
      }
    }

    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing or invalid Authorization header' });
      return;
    }

    // Agent-id binding (spec § Layer 1b). The header is checked BEFORE the
    // token comparison so a token sent to the wrong agent's server is
    // structurally inert — we never even get to the timing-safe-equals
    // step. The value is a stable, low-cardinality identifier
    // (projectName); we compare as strings rather than constant-time
    // because the agent-id space is operator-public (it appears in tmux
    // session names, log lines, file paths) — there is no secret here to
    // protect from a timing oracle.
    const providedAgentIdHeader = req.headers['x-instar-agentid'];
    const providedAgentId = Array.isArray(providedAgentIdHeader)
      ? providedAgentIdHeader[0]
      : providedAgentIdHeader;
    if (agentId) {
      if (providedAgentId === undefined) {
        // Backward-compat: old clients without the header are accepted
        // during the deprecation window. Log at most once per hour per
        // source (token-hash + remote) so rolling upgrades don't flood.
        const tokenForKey = header.slice(7);
        const tokenKey = createHash('sha256').update(tokenForKey).digest('hex').slice(0, 16);
        const remote = req.socket.remoteAddress ?? 'unknown';
        const sourceKey = `${tokenKey}:${remote}`;
        if (shouldLogDeprecation(sourceKey)) {
          console.warn(
            `[auth] deprecation: bearer-only request to ${req.path} ` +
            `from ${remote} — clients must send X-Instar-AgentId header. ` +
            `(deduped 1/hour per source)`
          );
        }
        // Fall through to token validation below.
      } else if (providedAgentId !== agentId) {
        // Cross-tenant misroute or forged header. Return a structured
        // sub-code so the client (sentinel) can categorize precisely.
        // Do NOT echo any token bytes — the response only carries the
        // expected agent-id, which is operator-public information.
        res.status(403).json({ error: 'agent_id_mismatch', expected: agentId });
        return;
      }
      // Match → fall through to token validation.
    }

    const token = header.slice(7);
    // Hash both sides so lengths are always equal — prevents timing leak of token length
    const ha = createHash('sha256').update(token).digest();
    const hb = createHash('sha256').update(resolvedToken).digest();
    if (!timingSafeEqual(ha, hb)) {
      res.status(403).json({ error: 'Invalid auth token' });
      return;
    }

    next();
  };
}

/**
 * Simple in-memory rate limiter using a sliding window.
 * No external dependencies. Suitable for a local management API.
 */
export function rateLimiter(windowMs: number = 60_000, maxRequests: number = 10) {
  const requests = new Map<string, number[]>();

  // Periodic cleanup to prevent unbounded memory growth from unique IPs
  const gcInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of requests.entries()) {
      if (bucket.length === 0 || bucket[bucket.length - 1] <= now - windowMs) {
        requests.delete(key);
      }
    }
  }, windowMs * 2);
  gcInterval.unref();

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();

    let bucket = requests.get(key);
    if (!bucket) {
      bucket = [];
      requests.set(key, bucket);
    }

    // Remove expired entries
    while (bucket.length > 0 && bucket[0] <= now - windowMs) {
      bucket.shift();
    }

    if (bucket.length >= maxRequests) {
      res.status(429).json({
        error: `Rate limit exceeded. Max ${maxRequests} requests per ${windowMs / 1000}s.`,
        retryAfterMs: bucket[0] + windowMs - now,
      });
      return;
    }

    bucket.push(now);
    next();
  };
}

/**
 * Request timeout middleware — prevents slow requests from hanging.
 * Returns 408 if the request takes longer than the timeout.
 *
 * `perPathOverrides` lets specific path prefixes use a longer (or shorter)
 * budget. This exists because some routes are intentionally LLM-backed and
 * need headroom the default 30s doesn't provide — the outbound messaging
 * routes (tone gate review + Telegram Bot API roundtrip) commonly take
 * 30–60s under normal load, and a 408 while the actual send is in flight
 * triggers duplicate-send cascades on the client side.
 *
 * Override matching is by longest-prefix, so a more specific prefix beats a
 * shorter parent if both are registered.
 */
/**
 * Extended request-timeout budget (ms) for outbound-messaging routes. They are
 * LLM-backed (tone-gate review) and hit third-party APIs (Telegram/Slack/WhatsApp)
 * whose latency we don't control; the 30s default 408s mid-send and triggers
 * duplicate-send cascades on the client. 120s covers this path's realistic p99.
 */
export const OUTBOUND_MESSAGING_TIMEOUT_MS = 120_000;

/**
 * Hard budget (ms) the outbound tone/relevance gate is allowed to spend BEFORE
 * the route fails it open and delivers the message un-reviewed.
 *
 * This MUST stay comfortably below OUTBOUND_MESSAGING_TIMEOUT_MS. The reason is
 * a real production failure (2026-06-08): the tone gate is FAIL-OPEN by design,
 * but `MessagingToneGate.review` will wait up to RATE_LIMIT_WAIT_MS (120s) for a
 * rate-limit window PLUS the call itself — and that whole wait sat inside an
 * un-raced `await` in `checkOutboundMessage`. Under rate-limit pressure the gate
 * routinely finished at 121s–185s (observed in the tone-gate decision log, all
 * failedOpen), blowing past the 120s route budget. The route then 408s, which is
 * the WORST outcome: the message both bypasses the gate AND, because the send
 * "failed", the calling session dumps the note into whatever topic it is active
 * in (the "patch notes landing in the Invoices topic" bug). Capping the gate at
 * this budget — and failing OPEN past it (same contract as the ArcCheck 200ms
 * race) — guarantees the route always returns a verdict in budget. The invariant
 * `OUTBOUND_GATE_REVIEW_BUDGET_MS < OUTBOUND_MESSAGING_TIMEOUT_MS` is asserted in
 * the wiring test so the two budgets can never drift into conflict again.
 */
export const OUTBOUND_GATE_REVIEW_BUDGET_MS = 20_000;

/**
 * Extended budget for the standards-conformance gate route (`/spec/conformance-check`).
 * It makes a single heavy top-tier review call over a full spec; the 30s default
 * 408s on any real spec. Set ABOVE the reviewer's inner CONFORMANCE_REVIEW_TIMEOUT_MS
 * (150s) so the provider's own clean kill fires first — a genuinely-too-slow spec
 * degrades fail-open (advisory empty report) instead of erroring at the client.
 */
export const SPEC_REVIEW_TIMEOUT_MS = 180_000;

/**
 * Extended budget for the cutover-readiness parity-pass trigger
 * (`/cutover-readiness/parity-pass`). One pass fetches the FULL live Portal
 * cluster set (paginated) and compares server-side — measured at ~3.5 minutes
 * against the real endpoint under load (2026-06-05). Under the 30s default the
 * client always got a 408 while the handler kept running, and a late failure's
 * 409 then crashed into ERR_HTTP_HEADERS_SENT with no trace of the outcome.
 */
export const PARITY_PASS_TIMEOUT_MS = 360_000;

/**
 * Extended budget for the deterministic topic transfer (`/pool/transfer`,
 * WS1.2). When the topic's current owner can drain, the handler awaits the
 * owner-side SessionDrainRunner SYNCHRONOUSLY: it waits up to `drainBoundMs`
 * (30s default) for the in-flight turn to reach a boundary, then closes the
 * session and lands the claim — so a CLEAN drain routinely lands at or past
 * 30s, and the remote `_sendDrain` mesh call is itself capped at 50s. Under
 * the 30s default the client would get a 408 mid-drain while the handler kept
 * running to completion (landing the claim + setting the pin) — the exact
 * "408 while the handler keeps running" failure class the outbound-messaging
 * and parity-pass overrides already exist to prevent (2026-06-12 second-pass
 * review concern #1). 75s clears the 50s remote cap + slack with margin.
 */
export const POOL_TRANSFER_TIMEOUT_MS = 75_000;

/**
 * Slack added on top of a configured parity-source TOTAL fetch budget when
 * deriving the parity-pass/import-dryrun route budgets: the route does the full
 * live fetch PLUS server-side compare/import work after it.
 */
export const PARITY_ROUTE_SLACK_MS = 60_000;

/**
 * The production per-path request-timeout overrides. Exported as the single
 * source of truth so wiring-integrity tests assert against the SAME map the
 * server actually wires — never a hand-rolled copy that could pass while the
 * server is misconfigured (the PR-#334 dead-code lesson).
 *
 * `paritySourceTotalTimeoutMs` (config `feedbackMigration.paritySource.totalTimeoutMs`):
 * when an operator widens the live-source fetch budget for a degraded source, the
 * parity-pass/import-dryrun ROUTE budgets must widen with it — otherwise every
 * trigger 408s at the constant while the handler keeps running, and a caller that
 * retries on the 408 piles a concurrent fetch onto the degraded source (observed
 * live 2026-06-05: 600s/page configured, 360s route → four concurrent passes).
 * The constant stays the floor; the derived budget never shrinks below it.
 */
export function buildRequestTimeoutOverrides(opts?: { paritySourceTotalTimeoutMs?: number }): Record<string, number> {
  const configuredTotal = opts?.paritySourceTotalTimeoutMs;
  const parityBudgetMs = typeof configuredTotal === 'number' && Number.isFinite(configuredTotal) && configuredTotal > 0
    ? Math.max(PARITY_PASS_TIMEOUT_MS, configuredTotal + PARITY_ROUTE_SLACK_MS)
    : PARITY_PASS_TIMEOUT_MS;
  return {
    '/telegram/reply': OUTBOUND_MESSAGING_TIMEOUT_MS,
    '/telegram/post-update': OUTBOUND_MESSAGING_TIMEOUT_MS,
    '/slack/reply': OUTBOUND_MESSAGING_TIMEOUT_MS,
    '/whatsapp/send': OUTBOUND_MESSAGING_TIMEOUT_MS,
    '/imessage/reply': OUTBOUND_MESSAGING_TIMEOUT_MS,
    '/imessage/validate-send': OUTBOUND_MESSAGING_TIMEOUT_MS,
    '/spec/conformance-check': SPEC_REVIEW_TIMEOUT_MS,
    '/cutover-readiness/parity-pass': parityBudgetMs,
    // The import dry-run does the same full live source fetch as a parity pass
    // (plus an in-memory import + gate, which is fast) — same budget.
    '/cutover-readiness/import-dryrun': parityBudgetMs,
    // The REAL integrity pass spawns a child that does the same full-corpus fetch +
    // a persisted import + gate; the route awaits the child — same extended budget.
    '/cutover-readiness/integrity-pass': parityBudgetMs,
    // WS1.2: the deterministic transfer awaits the owner-side drain (≤ drain
    // bound + the 50s remote-call cap) synchronously — see POOL_TRANSFER_TIMEOUT_MS.
    '/pool/transfer': POOL_TRANSFER_TIMEOUT_MS,
  };
}

/**
 * Resolve the timeout budget for a path against the overrides, by longest-prefix
 * match. Exported and used by BOTH the middleware and its tests so the matching
 * logic can never drift between what is tested and what runs. Match is exact
 * prefix OR prefix followed by '/' so '/foo' never spuriously matches '/foo-bar'
 * — and a sibling like '/spec/conformance-metrics' is NOT matched by the
 * '/spec/conformance-check' prefix. req.path never carries the query string.
 */
export function resolveRequestTimeout(
  reqPath: string,
  defaultMs: number,
  perPathOverrides: Record<string, number>,
): number {
  const sortedOverrides = Object.entries(perPathOverrides)
    .sort((a, b) => b[0].length - a[0].length);
  for (const [prefix, ms] of sortedOverrides) {
    if (reqPath === prefix || reqPath.startsWith(prefix + '/')) return ms;
  }
  return defaultMs;
}

export function requestTimeout(
  defaultMs: number = 30_000,
  perPathOverrides: Record<string, number> = {},
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const timeoutMs = resolveRequestTimeout(req.path, defaultMs, perPathOverrides);

    let done = false;
    const timer = setTimeout(() => {
      if (!done && !res.headersSent) {
        res.status(408).json({
          error: 'Request timeout',
          timeoutMs,
        });
      }
    }, timeoutMs);

    // Clear timeout when response finishes
    res.on('finish', () => { done = true; clearTimeout(timer); });
    res.on('close', () => { done = true; clearTimeout(timer); });
    next();
  };
}

/**
 * HMAC-sign a view path so the URL can be opened in a browser without exposing the auth token.
 * The signature is path-specific — sharing a signed URL only grants access to that one view.
 */
export function signViewPath(viewPath: string, authToken: string): string {
  return createHmac('sha256', authToken).update(viewPath).digest('hex');
}

/**
 * Verify a signed view URL. Returns true if the sig matches the path.
 */
function verifyViewSignature(viewPath: string, sig: string, authToken: string): boolean {
  const expected = createHmac('sha256', authToken).update(viewPath).digest();
  const provided = Buffer.from(sig, 'hex');
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

/**
 * Security headers for dashboard paths — prevents clickjacking, MIME-sniffing,
 * and restricts resource loading to trusted sources.
 */
export function dashboardSecurityHeaders(req: Request, res: Response, next: NextFunction): void {
  if (req.path === '/dashboard' || req.path.startsWith('/dashboard/')) {
    res.header('X-Frame-Options', 'DENY');
    res.header('X-Content-Type-Options', 'nosniff');
    res.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline' cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' cdn.jsdelivr.net; connect-src 'self'",
    );
    res.header('Referrer-Policy', 'no-referrer');
  }
  next();
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  if (responseAlreadyCommitted(res)) {
    console.warn(
      `[server] Error after response was already sent for ${req.method} ${req.originalUrl || req.url}: ${message}`
      + (stack ? `\n${stack}` : ''),
    );
    return;
  }
  console.error(`[server] Error: ${message}` + (stack ? `\n${stack}` : ''));
  // Never leak internal error details to clients
  res.status(500).json({
    error: 'Internal server error',
    timestamp: new Date().toISOString(),
  });
}
