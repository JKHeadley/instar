/**
 * Project apps part 2, the sealed frame and the narrow per-app key
 * (docs/specs/project-apps-sandbox.md §3.6, §3.7).
 *
 * This module holds ONLY the serving side: the single-use frame ticket, the frame's exact response
 * headers, the origin allow-list, and the HMAC key that is the sole gate on the app's api paths.
 * Which version is served, the app's data and summary, the epoch and approvals are NOT decided here:
 * they come from an injected `CustomAppSource` (storage §3.2 and approvals §3.3-3.4 own them).
 *
 * The HMAC secret is an injected dependency (`hmacSecret()`): the spec has the lease holder create it
 * after asking its peers and share it through cross-machine secret sync, which is the storage owner's
 * wiring. No secret ⇒ keys can be neither minted nor verified (fail closed, 503).
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { resolveDevAgentGate } from '../core/devAgentGate.js';

/** `projectApps.custom.enabled` (dev-gated, dark on the fleet; §9). Part 1's switch is checked beside it. */
export function customProjectAppsEnabled(config: { developmentAgent?: boolean; projectApps?: { custom?: { enabled?: boolean } } } | undefined): boolean {
  return resolveDevAgentGate(config?.projectApps?.custom?.enabled, config ?? {});
}

// ── the injected interface ──────────────────────────────────────────────────

export type ServedVersion =
  | { state: 'served'; contentSha: string; html: string }
  | { state: 'none' | 'copying' | 'disabled' };

export interface CustomAppMeta {
  /** The app's title, 1-60 characters (§3.1). */
  title: string;
  /** The project's display title. */
  project: string;
  /** Where the bar's Conversation button goes: always the app's own project conversation. */
  conversationHref: string;
}

export type SourceWriteResult =
  | { ok: true; revision?: string; [k: string]: unknown }
  | { ok: false; status: number; error: string; detail?: string; [k: string]: unknown };

/**
 * What the sandbox needs from storage and approvals. Every method is synchronous over state the
 * owner already folded (the served version is derived, never written; §3.3).
 */
export interface CustomAppSource {
  /** The app's display facts, or null when no such app exists (or it was deleted). */
  meta(appId: string): CustomAppMeta | null;
  /** The newest complete, approved, not-rejected source, or why there is none. */
  servedVersion(appId: string): ServedVersion;
  /** The app's key epoch. A disable or a new served version bumps it, revoking older keys (§3.7). */
  epoch(appId: string): number;
  readData(appId: string): { body: unknown; revision: string | null };
  writeData(appId: string, body: unknown, base: string | null): SourceWriteResult;
  readSummary(appId: string): unknown;
  writeSummary(appId: string, body: unknown): SourceWriteResult;
}

// ── constants ───────────────────────────────────────────────────────────────

export const APP_ID_RE = /^pa_[0-9a-f]{16}$/;
export const KEY_HEADER = 'x-project-app-key';
export const KEY_PREFIX = 'pak_';
export const KEY_TTL_MS = 15 * 60_000;
export const TICKET_TTL_MS = 60_000;
export const KEY_RIGHTS = ['data:read', 'data:write', 'summary:write'] as const;
export type KeyRight = (typeof KEY_RIGHTS)[number];
const TICKET_CAP = 2000;
const MAC_LABEL = 'instar/project-app-key/v1\n';

/**
 * The exact shapes the auth middleware lets through without a Bearer (§3.6). Never a prefix.
 * Case-insensitive because Express routing is; the handlers re-check the app id exactly.
 */
export const PROJECT_APP_FRAME_PATH = /^\/project-apps\/pa_[0-9a-f]{16}\/frame$/i;
export const PROJECT_APP_API_PATH = /^\/project-apps\/pa_[0-9a-f]{16}\/api\/(data|summary)$/i;

export function isProjectAppPublicRoute(method: string, reqPath: string): boolean {
  const m = method.toUpperCase();
  if (m === 'GET' && PROJECT_APP_FRAME_PATH.test(reqPath)) return true;
  if ((m === 'GET' || m === 'PUT') && PROJECT_APP_API_PATH.test(reqPath)) return true;
  return false;
}

// ── the narrow key ──────────────────────────────────────────────────────────

export interface KeyClaims {
  v: 1;
  appId: string;
  contentSha: string;
  rights: KeyRight[];
  exp: number;
  epoch: number;
  nonce: string;
}

const b64u = (b: Buffer | string): string => Buffer.from(b).toString('base64url');

function mac(secret: Buffer, payloadB64: string): Buffer {
  return createHmac('sha256', secret).update(MAC_LABEL).update(payloadB64).digest();
}

export function mintKey(secret: Buffer, c: Omit<KeyClaims, 'v' | 'nonce' | 'rights'> & { rights?: KeyRight[]; nonce?: string }): string {
  const claims: KeyClaims = {
    v: 1, appId: c.appId, contentSha: c.contentSha, rights: c.rights ?? [...KEY_RIGHTS],
    exp: c.exp, epoch: c.epoch, nonce: c.nonce ?? randomBytes(12).toString('hex'),
  };
  const payload = b64u(JSON.stringify(claims));
  return `${KEY_PREFIX}${payload}.${b64u(mac(secret, payload))}`;
}

export type KeyVerdict =
  | { ok: true; claims: KeyClaims }
  | { ok: false; reason: 'malformed' | 'bad-signature' | 'wrong-app' | 'expired' | 'revoked' | 'version-not-served' | 'no-right' };

/**
 * Verify a key for a request to `appId`'s api. Every check must pass: signature, shape, the path's
 * app, unexpired, the app's current epoch, and the key's version still the served one.
 */
export function verifyKey(
  secret: Buffer,
  raw: string,
  want: { appId: string; right: KeyRight; now: number; epoch: number; servedSha: string | null },
): KeyVerdict {
  if (typeof raw !== 'string' || !raw.startsWith(KEY_PREFIX) || raw.length > 2048) return { ok: false, reason: 'malformed' };
  const body = raw.slice(KEY_PREFIX.length);
  const dot = body.indexOf('.');
  if (dot <= 0 || dot !== body.lastIndexOf('.')) return { ok: false, reason: 'malformed' };
  const payload = body.slice(0, dot);
  const sig = body.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]{43}$/.test(sig)) return { ok: false, reason: 'malformed' };
  const expected = mac(secret, payload);
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'bad-signature' };
  let c: KeyClaims;
  try { c = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as KeyClaims; } catch { return { ok: false, reason: 'malformed' }; } // @silent-fallback-ok — a signed but unparseable key is refused
  if (!c || c.v !== 1 || typeof c.appId !== 'string' || typeof c.contentSha !== 'string' || !Array.isArray(c.rights)
    || !Number.isFinite(c.exp) || !Number.isInteger(c.epoch)) return { ok: false, reason: 'malformed' };
  if (c.appId !== want.appId) return { ok: false, reason: 'wrong-app' };
  if (want.now >= c.exp) return { ok: false, reason: 'expired' };
  if (c.epoch !== want.epoch) return { ok: false, reason: 'revoked' };
  if (!want.servedSha || c.contentSha !== want.servedSha) return { ok: false, reason: 'version-not-served' };
  if (!c.rights.includes(want.right)) return { ok: false, reason: 'no-right' };
  return { ok: true, claims: c };
}

// ── the frame ticket (machine-local, in memory; §5 physical-credential-locality) ──

interface Ticket { appId: string; contentSha: string; exp: number }

export class TicketStore {
  private readonly tickets = new Map<string, Ticket>();
  constructor(private readonly now: () => number = Date.now) {}

  issue(appId: string, contentSha: string): { ticket: string; expiresAt: number } {
    this.sweep();
    if (this.tickets.size >= TICKET_CAP) {
      const oldest = this.tickets.keys().next().value;
      if (oldest !== undefined) this.tickets.delete(oldest);
    }
    const ticket = randomBytes(24).toString('base64url');
    const exp = this.now() + TICKET_TTL_MS;
    this.tickets.set(ticket, { appId, contentSha, exp });
    return { ticket, expiresAt: exp };
  }

  /** Single use: the ticket is gone after this call whatever the outcome. */
  consume(ticket: unknown, appId: string, servedSha: string | null): { ok: true } | { ok: false; reason: 'missing' | 'unknown' | 'expired' | 'wrong-app' | 'version-changed' } {
    if (typeof ticket !== 'string' || ticket.length === 0 || ticket.length > 128) return { ok: false, reason: 'missing' };
    const t = this.tickets.get(ticket);
    if (!t) return { ok: false, reason: 'unknown' };
    this.tickets.delete(ticket);
    if (this.now() >= t.exp) return { ok: false, reason: 'expired' };
    if (t.appId !== appId) return { ok: false, reason: 'wrong-app' };
    if (!servedSha || t.contentSha !== servedSha) return { ok: false, reason: 'version-changed' };
    return { ok: true };
  }

  size(): number { return this.tickets.size; }

  private sweep(): void {
    const now = this.now();
    for (const [k, t] of this.tickets) if (now >= t.exp) this.tickets.delete(k);
  }
}

// ── the origin allow-list ───────────────────────────────────────────────────

export interface OriginDeps {
  /** Hosts (no scheme, lowercase, port only when not 443) the agent is known to answer on over
   *  HTTPS: the running tunnel URL's host, the named tunnel hostname, own Tailscale/Cloudflare names. */
  knownHttpsHosts: () => Array<string | null | undefined>;
  /** Optional extra own-name check (MobileOwnNames.accepts). */
  acceptsOwnName?: (host: string) => boolean;
}

const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\])(?::(\d{1,5}))?$/;

function normHost(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let h = raw.trim().toLowerCase();
  if (h.endsWith(':443')) h = h.slice(0, -4);
  if (h.endsWith('.')) h = h.slice(0, -1);
  return /^[a-z0-9.[\]:-]{1,253}$/.test(h) ? h : null;
}

/**
 * The request's own origin, only when it is one of the agent's known addresses; else null (→ 400).
 * Local names count only on the port this very request arrived on (the server's own port).
 */
export function resolveKnownOrigin(req: Pick<Request, 'headers' | 'secure'> & { socket?: { localPort?: number } }, deps: OriginDeps): string | null {
  const host = normHost(req.headers.host);
  if (!host) return null;
  const local = LOCAL_HOST_RE.exec(host);
  if (local) {
    const port = local[2] ? Number(local[2]) : (req.secure ? 443 : 80);
    if (!req.socket?.localPort || port !== req.socket.localPort) return null;
    return `${req.secure ? 'https' : 'http'}://${host}`;
  }
  const known = new Set(deps.knownHttpsHosts().map(normHost).filter((h): h is string => !!h));
  if (known.has(host) || deps.acceptsOwnName?.(host) === true) return `https://${host}`;
  return null;
}

export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try { return new URL(url).host.toLowerCase(); } catch { return null; } // @silent-fallback-ok — an unparseable URL is no known host
}

// ── the exact headers ───────────────────────────────────────────────────────

export function frameCsp(origin: string, appId: string): string {
  return [
    'sandbox allow-scripts allow-forms',
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'font-src data:',
    `connect-src ${origin}/project-apps/${appId}/api/`,
    "form-action 'none'",
    "base-uri 'none'",
    `frame-ancestors ${origin}`,
  ].join('; ');
}

export function frameHeaders(origin: string, appId: string, contentSha: string): Record<string, string> {
  return {
    'Content-Security-Policy': frameCsp(origin, appId),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'ETag': `"${contentSha}"`,
    'Cache-Control': 'no-cache',
    'Content-Type': 'text/html; charset=utf-8',
  };
}

/** The wrapper page's own policy: Instar code only, and the one frame path it may show. */
export function wrapperCsp(origin: string, appId: string): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "connect-src 'self'",
    "img-src 'self'",
    `frame-src ${origin}/project-apps/${appId}/frame`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** The wrapper's HTML paths (the JS and CSS beside it keep the dashboard's ordinary policy). */
export function isWrapperPagePath(lowerPath: string): boolean {
  return lowerPath === '/dashboard/project-app/' || lowerPath === '/dashboard/project-app/index.html';
}

// ── the sandbox runtime ─────────────────────────────────────────────────────

export interface ProjectAppSandboxDeps {
  source: CustomAppSource;
  /** The shared HMAC secret (≥ 32 bytes), or null while it is not yet available. */
  hmacSecret: () => Buffer | null;
  now?: () => number;
}

export class ProjectAppSandbox {
  readonly tickets: TicketStore;
  readonly now: () => number;
  constructor(readonly deps: ProjectAppSandboxDeps) {
    this.now = deps.now ?? Date.now;
    this.tickets = new TicketStore(this.now);
  }

  get source(): CustomAppSource { return this.deps.source; }

  secret(): Buffer | null {
    const s = this.deps.hmacSecret();
    return s && s.length >= 32 ? s : null;
  }

  servedSha(appId: string): string | null {
    const v = this.deps.source.servedVersion(appId);
    return v.state === 'served' ? v.contentSha : null;
  }

  /** Mint a key for the version the wrapper loaded. Refused when that is no longer the served one. */
  mint(appId: string, loadedSha: string | null):
    | { ok: true; key: string; exp: number; contentSha: string }
    | { ok: false; status: number; error: string; state?: string; contentSha?: string } {
    const secret = this.secret();
    if (!secret) return { ok: false, status: 503, error: 'key-secret-unavailable' };
    const v = this.deps.source.servedVersion(appId);
    if (v.state !== 'served') return { ok: false, status: 409, error: 'not-served', state: v.state };
    if (loadedSha !== null && loadedSha !== v.contentSha) return { ok: false, status: 409, error: 'version-changed', contentSha: v.contentSha };
    const exp = this.now() + KEY_TTL_MS;
    const key = mintKey(secret, { appId, contentSha: v.contentSha, exp, epoch: this.deps.source.epoch(appId) });
    return { ok: true, key, exp, contentSha: v.contentSha };
  }

  verify(appId: string, raw: unknown, right: KeyRight): KeyVerdict | { ok: false; reason: 'no-key' | 'key-secret-unavailable' } {
    if (typeof raw !== 'string' || raw.length === 0) return { ok: false, reason: 'no-key' };
    const secret = this.secret();
    if (!secret) return { ok: false, reason: 'key-secret-unavailable' };
    return verifyKey(secret, raw, { appId, right, now: this.now(), epoch: this.deps.source.epoch(appId), servedSha: this.servedSha(appId) });
  }
}
