/**
 * SEC-103 — how much of a request body the server will read is decided BEFORE it reads any.
 *
 * The general JSON parser (12 MB) and two larger per-path parsers used to run before the auth
 * gate, so anyone who knew the tunnel address could make the server buffer and parse large
 * bodies that would then be refused. This module replaces those parsers and picks a budget
 * from what can be checked without the body:
 *
 *  - FULL budget (the route's own limit): the agent token (constant-time compare), a valid
 *    `dst_` dashboard session, a known `mps_` memory session; or a narrowed admission for a
 *    signed peer: an active paired device presenting its signature headers with a fresh time,
 *    or an active paired machine (never this machine's own id) presenting the full machine
 *    signature header set with a fresh timestamp, on a machine route. Ids are not secrets, so
 *    these two are only narrowings; the real signature check still runs later, on the body.
 *  - PEER budget (2 MB): POST/PUT to the exact public routes that check a peer's own
 *    credential inside their handler (mesh RPC, a2a, relay, Threadline peer routes,
 *    project-app api, WhatsApp webhook). Threadline's own inbound cap is 64 KB.
 *  - SMALL budget (64 KB): everyone else. A declared Content-Length over the budget is refused
 *    413 before a byte is read; a body with no declared length is read only up to the budget,
 *    then answered 413. Both close the connection, so the rest is never consumed.
 */
import crypto from 'node:crypto';
import express from 'express';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { isThreadlinePublicRoute } from './middleware.js';
import { isProjectAppPublicRoute } from './ProjectAppSandbox.js';

export const FULL_BODY_LIMIT_BYTES = 12 * 1024 * 1024;
export const PEER_BODY_LIMIT_BYTES = 2 * 1024 * 1024;
export const UNPROVEN_BODY_LIMIT_BYTES = 64 * 1024;
/** Freshness windows for the narrowed admissions (the real checks use 60 s and 30 s). */
const DEVICE_TIME_SLACK_MS = 2 * 60_000;
const MACHINE_TIME_SLACK_MS = 2 * 60_000;

/** Exact public routes that check a peer's credential in the handler. */
const PEER_BODY_PATHS = new Set([
  '/messages/relay-agent',
  '/messages/relay-machine',
  '/a2a/inbox',
  '/a2a/apprenticeship/cycles',
  '/mesh/rpc',
  '/webhooks/whatsapp',
]);

/** POST/PUT to a public peer route: may carry a peer-sized body, never the full 12 MB. */
export function isPeerBodyRoute(method: string, reqPath: string): boolean {
  const m = method.toUpperCase();
  if (m !== 'POST' && m !== 'PUT') return false;
  return PEER_BODY_PATHS.has(reqPath)
    || isThreadlinePublicRoute(m, reqPath)
    || isProjectAppPublicRoute(m, reqPath);
}

export interface BodyBudgetDeps {
  /** The agent token, read per request (rotation takes effect at once). */
  authToken: () => string | undefined;
  /** A `dst_` dashboard session token is valid right now. */
  dashboardSessionValid?: (token: string) => boolean;
  /** An `mps_` memory-privacy session token is known. */
  memorySessionValid?: (token: string) => boolean;
  /** The id names an active paired device. */
  activeDevice?: (deviceId: string) => boolean;
  /** The id names an active paired machine. */
  activeMachine?: (machineId: string) => boolean;
  /** This machine's own id: never admitted by id (it is handed out in refusals). */
  selfMachineId?: () => string | null | undefined;
  /** Keeps the raw bytes for signature checks (req.rawBody). */
  verify?: (req: unknown, res: unknown, buf: Buffer) => void;
  now?: () => number;
}

function sameSecret(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function header(req: Request, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** A one-second memo so a stream of spoofed ids costs at most one registry read per id per second. */
function memo(fn: ((id: string) => boolean) | undefined, now: () => number): ((id: string) => boolean) | undefined {
  if (!fn) return undefined;
  const cache = new Map<string, { at: number; ok: boolean }>();
  return (id: string) => {
    const t = now();
    const hit = cache.get(id);
    if (hit && t - hit.at < 1000) return hit.ok;
    let ok = false;
    try { ok = fn(id) === true; } catch { ok = false; } // @silent-fallback-ok — a failing lookup admits nothing; the small budget applies
    if (cache.size >= 256) cache.clear();
    cache.set(id, { at: t, ok });
    return ok;
  };
}

/**
 * True when the caller shows a credential (or a narrowed signed-peer admission) that can be
 * checked before the body is read. `deps` lookups should already be memoized.
 */
export function presentsCredential(req: Request, deps: BodyBudgetDeps): boolean {
  const now = (deps.now ?? Date.now)();
  const token = deps.authToken();
  const auth = header(req, 'authorization');
  if (auth && auth.startsWith('Bearer ')) {
    const presented = auth.slice(7);
    if (token && sameSecret(presented, token)) return true;
    if (presented.startsWith('dst_') && deps.dashboardSessionValid?.(presented) === true) return true;
    if (presented.startsWith('mps_') && deps.memorySessionValid?.(presented) === true) return true;
  }
  // A paired device: its id, its signature header and a fresh signing time (verified later on the body).
  const device = header(req, 'x-instar-device');
  const deviceTime = header(req, 'x-instar-device-time');
  if (device && deviceTime && header(req, 'x-instar-device-sig') && !req.path.startsWith('/internal/')
    && /^\d{10,16}$/.test(deviceTime) && Math.abs(now - Number(deviceTime)) <= DEVICE_TIME_SLACK_MS
    && deps.activeDevice?.(device) === true) return true;
  // A paired machine on a machine route: the full signature header set, a fresh timestamp, never our own id.
  const machine = header(req, 'x-machine-id');
  const machineTs = header(req, 'x-timestamp');
  if (machine && machineTs && req.path.startsWith('/api/')
    && header(req, 'x-nonce') && header(req, 'x-sequence') && header(req, 'x-signature')
    && /^\d{9,11}$/.test(machineTs) && Math.abs(now - Number(machineTs) * 1000) <= MACHINE_TIME_SLACK_MS
    && machine !== deps.selfMachineId?.()
    && deps.activeMachine?.(machine) === true) return true;
  return false;
}

function hasBody(req: Request): boolean {
  if (req.headers['transfer-encoding'] !== undefined) return true;
  const len = req.headers['content-length'];
  return len !== undefined && len !== '0';
}

function refuseUnread(res: Response, status: number, error: string): void {
  res.setHeader('Connection', 'close');
  res.status(status).json({ error });
}

/**
 * A JSON parser with a credential-dependent budget: `fullLimitBytes` for a proven caller,
 * 2 MB on a public peer route, 64 KB for anyone else. Mounted as the general parser and in
 * front of the larger per-path ones.
 */
export function credentialAwareJsonParser(deps: BodyBudgetDeps, fullLimitBytes: number = FULL_BODY_LIMIT_BYTES): RequestHandler {
  const now = deps.now ?? Date.now;
  const checks: BodyBudgetDeps = { ...deps, activeDevice: memo(deps.activeDevice, now), activeMachine: memo(deps.activeMachine, now) };
  const full = express.json({ limit: fullLimitBytes, verify: deps.verify });
  const peerLimit = Math.min(PEER_BODY_LIMIT_BYTES, fullLimitBytes);
  const peer = express.json({ limit: peerLimit, verify: deps.verify });
  const smallLimit = Math.min(UNPROVEN_BODY_LIMIT_BYTES, fullLimitBytes);
  const small = express.json({ limit: smallLimit, verify: deps.verify });
  return (req: Request, res: Response, next: NextFunction): void => {
    // A route-specific parser earlier in the chain already read it, or there is nothing to read.
    if ((req as { _body?: boolean })._body || !hasBody(req)) { next(); return; }
    // No token configured: the auth gate lets everything through, so there is nothing to protect here.
    if (!deps.authToken()) { full(req, res, next); return; }
    let proven = false;
    try { proven = presentsCredential(req, checks); } catch { proven = false; } // @silent-fallback-ok — a failing check admits nothing
    if (proven) { full(req, res, next); return; }
    const isPeer = isPeerBodyRoute(req.method, req.path);
    const limit = isPeer ? peerLimit : smallLimit;
    const declared = req.headers['content-length'];
    if (declared !== undefined) {
      const n = Number(declared);
      if (!Number.isFinite(n) || n > limit) { refuseUnread(res, 413, 'body-too-large'); return; }
    }
    // No declared length: the parser stops buffering at the budget; answer at once and close,
    // so the remaining stream is not drained.
    (isPeer ? peer : small)(req, res, (err?: unknown) => {
      if ((err as { type?: unknown } | undefined)?.type === 'entity.too.large') {
        if (!res.headersSent) refuseUnread(res, 413, 'body-too-large');
        return;
      }
      next(err as Error | undefined);
    });
  };
}

const lastLogged = new Map<string, number>();

/**
 * Body-parser failures are the caller's mistake, not a server fault: a plain 400 (bad JSON),
 * 413 (too large) or 415 with a short code, and at most one log line per code per minute that
 * names only the first path segment (some paths carry a token). Returns true when it answered.
 */
export function answerBodyParseError(err: unknown, req: Request, res: Response): boolean {
  const e = err as { type?: unknown } | null;
  if (!e || typeof e.type !== 'string') return false;
  let status: number;
  let code: string;
  switch (e.type) {
    case 'entity.parse.failed': status = 400; code = 'invalid-json'; break;
    case 'entity.too.large': status = 413; code = 'body-too-large'; break;
    case 'request.size.invalid': status = 400; code = 'body-length-mismatch'; break;
    case 'request.aborted': status = 400; code = 'request-aborted'; break;
    case 'charset.unsupported': status = 415; code = 'unsupported-charset'; break;
    case 'encoding.unsupported': status = 415; code = 'unsupported-encoding'; break;
    default: return false;
  }
  const t = Date.now();
  if (t - (lastLogged.get(code) ?? 0) >= 60_000) {
    lastLogged.set(code, t);
    const first = String(req.originalUrl ?? req.url ?? '').split('?')[0]!.split('/')[1] ?? '';
    console.warn(`[server] ${req.method} /${first.slice(0, 40)}…: ${code} (${status}); repeats within a minute are not logged`);
  }
  if (res.headersSent) return true;
  res.status(status).json({ error: code });
  return true;
}
