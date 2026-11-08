/**
 * Console sign-in from an owner's paired phone (docs/specs/mobile-console-device-signin.md).
 *
 * The phone proves two things the server can check: it holds the paired device key (the device
 * authenticator), and its owner has just authenticated on it (a second Secure Enclave key, the
 * "presence key", that cannot sign without Face ID / Touch ID / the passcode). It then receives a
 * one-minute, single-use ticket, which the console page redeems for exactly what the dashboard
 * PIN unlock returns as its console credential: the API token. Never the operator session.
 *
 * Challenges and tickets live only in this process's memory, bound to the device and the Host
 * the request was signed for (machine-local by design: spec, Multi-machine posture).
 */
import { storageErrorResponse } from '../core/storageMachineName.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Application, Request, Response, Router } from 'express';
import { deviceKeyHashOf } from '../core/AppRecordSignatures.js';
import { arrivedOverLocalTls } from '../core/desktopTransport.js';
import { normalizeRequestHost } from '../core/MobileOwnNames.js';
import { isStrictLowSDer, parseDevicePublicKey } from '../core/MobileDeviceKeys.js';
import type { InstarConfig } from '../core/types.js';
import { resolveDevAgentGate } from '../core/devAgentGate.js';
import { maybeRotateJsonl } from '../utils/jsonl-rotation.js';
import type { MobilePairingService } from './mobilePairingRoutes.js';

export const CONSOLE_TICKET_TTL_MS = 60_000;
export const CONSOLE_TICKET_PER_DEVICE = 4;
export const CONSOLE_TICKET_TOTAL = 64;
export const CONSOLE_REDEEM_PATH = '/dashboard/console-ticket';
export const CONSOLE_TICKET_PATH = '/mobile/console-ticket';
export const CONSOLE_CHALLENGE_PATH = '/mobile/console-ticket/challenge';
export const PRESENCE_KEY_PATH = '/mobile/device/presence-key';
export const PRESENCE_MESSAGE_VERSION = 'instar-console-ticket-v1';
export const PRESENCE_ENROLL_VERSION = 'instar-presence-enroll-v1';
const REDEEM_PER_ADDRESS_PER_MIN = 10;
const REDEEM_TOTAL_PER_MIN = 120;
const AUDIT_MAX_BYTES = 1024 * 1024;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** `mobilePairing.consoleTicket.enabled`: omitted ⇒ on wherever mobile pairing is on. Read live. */
export function isConsoleTicketEnabled(config: InstarConfig): boolean {
  const mp = config.mobilePairing as { consoleTicket?: { enabled?: boolean } } | undefined;
  return mp?.consoleTicket?.enabled !== false;
}

/** Whether Remote Desktop with Face ID is on (mirrors isOwnerPresenceEnabled without an import cycle). */
function isOwnerPresenceOn(config: InstarConfig): boolean {
  const mp = config.mobilePairing as { ownerPresence?: { enabled?: boolean } } | undefined;
  return resolveDevAgentGate(mp?.ownerPresence?.enabled, config);
}

const sha256 = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');

/** The exact bytes the presence key signs. */
export function presenceMessage(deviceId: string, host: string, challenge: string): string {
  return `${PRESENCE_MESSAGE_VERSION}\n${deviceId}\n${host.toLowerCase()}\n${challenge}`;
}

/** The bytes the presence key signs to prove possession at enrollment. */
export function presenceEnrollMessage(deviceId: string, host: string, publicKey: string): string {
  return `${PRESENCE_ENROLL_VERSION}\n${deviceId}\n${host.toLowerCase()}\n${publicKey}`;
}

/** The decoded bytes of a base64url public key, for comparing keys as keys rather than as text. */
export function samePublicKey(a: string, b: string): boolean {
  const x = Buffer.from(a, 'base64url'), y = Buffer.from(b, 'base64url');
  return x.length === 65 && y.length === 65 && crypto.timingSafeEqual(x, y);
}

/** True when `sigB64` is a strict low-S DER ECDSA-P256-SHA256 signature by `publicKeyB64` over `message`. */
export function verifyPresenceSignature(publicKeyB64: string, message: string, sigB64: unknown): boolean {
  if (typeof sigB64 !== 'string' || sigB64.length > 128 || !/^[A-Za-z0-9_-]+$/.test(sigB64)) return false;
  const key = parseDevicePublicKey(publicKeyB64);
  if (!key) return false;
  const sig = Buffer.from(sigB64, 'base64url');
  if (!isStrictLowSDer(sig)) return false;
  try {
    return crypto.verify('sha256', Buffer.from(message), { key, dsaEncoding: 'der' }, sig);
  } catch {
    // @silent-fallback-ok — a malformed signature is simply invalid
    return false;
  }
}

/**
 * Single-use secrets bound to a device and a Host: used for both challenges and tickets. Only
 * the SHA-256 of each secret is kept. Consuming deletes the entry before it is judged.
 */
export class BoundSecretStore {
  private readonly entries = new Map<string, { deviceId: string; host: string; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now, private readonly ttlMs = CONSOLE_TICKET_TTL_MS,
    private readonly perDevice = CONSOLE_TICKET_PER_DEVICE, private readonly total = CONSOLE_TICKET_TOTAL) {}

  issue(deviceId: string, host: string): { secret: string; expiresAt: number; ref: string } {
    this.prune();
    const mine = [...this.entries.entries()].filter(([, e]) => e.deviceId === deviceId);
    for (let i = 0; i <= mine.length - this.perDevice; i++) this.entries.delete(mine[i]![0]);
    while (this.entries.size >= this.total) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    const secret = crypto.randomBytes(32).toString('base64url');
    const expiresAt = this.now() + this.ttlMs;
    const digest = sha256(secret);
    this.entries.set(digest, { deviceId, host: host.toLowerCase(), expiresAt });
    return { secret, expiresAt, ref: digest.slice(0, 12) };
  }

  /** Deletes the secret first; returns its binding only when it was live. */
  consume(secret: unknown): { deviceId: string; host: string; ref: string } | null {
    if (typeof secret !== 'string' || !SECRET_PATTERN.test(secret)) return null;
    const digest = sha256(secret);
    const e = this.entries.get(digest);
    if (!e) return null;
    this.entries.delete(digest);
    if (e.expiresAt <= this.now()) return null;
    return { deviceId: e.deviceId, host: e.host, ref: digest.slice(0, 12) };
  }

  size(): number { this.prune(); return this.entries.size; }

  private prune(): void {
    const t = this.now();
    for (const [k, e] of this.entries) if (e.expiresAt <= t) this.entries.delete(k);
  }
}

/** Fixed-window throughput limit for the public redeem: a limit on calls, never a lockout on a ticket. */
export class RedeemLimiter {
  private windowStart = 0;
  private total = 0;
  private perAddress = new Map<string, number>();
  constructor(private readonly now: () => number = Date.now, private readonly perAddressMax = REDEEM_PER_ADDRESS_PER_MIN, private readonly totalMax = REDEEM_TOTAL_PER_MIN) {}
  admit(address: string): boolean {
    const t = this.now();
    if (t - this.windowStart >= 60_000) { this.windowStart = t; this.total = 0; this.perAddress.clear(); }
    const n = this.perAddress.get(address) ?? 0;
    if (n >= this.perAddressMax || this.total >= this.totalMax) return false;
    this.perAddress.set(address, n + 1);
    this.total++;
    return true;
  }
}

export type ConsoleAuditEvent = 'minted' | 'redeemed' | 'presence-key-set' | 'refused' | 'refused-unknown';
export interface ConsoleAuditRow { at: string; event: ConsoleAuditEvent; deviceId?: string; reason?: string; ticketRef?: string; count?: number }

/**
 * The audit trail: metadata only, never a secret. Rows involving a real ticket, challenge or
 * device are written before the answer; refusals of unknown tickets and throttled calls from
 * anonymous callers are counted and written as one `refused-unknown` row at most once a minute.
 * A failed write is reported and never fails the request (a record, not a gate).
 */
export class ConsoleTicketAudit {
  readonly file: string;
  private pendingUnknown = 0;
  private lastFlush = 0;
  constructor(stateDir: string, private readonly now: () => number = Date.now,
    private readonly report: (err: unknown) => void = () => {}, fileName = 'mobile-console-tickets.jsonl') {
    this.file = path.join(stateDir, 'state', fileName);
  }

  record(row: Omit<ConsoleAuditRow, 'at'>): void {
    this.flushUnknown(false);
    this.append({ at: new Date(this.now()).toISOString(), ...row });
  }

  unknownRefusal(): void {
    this.pendingUnknown++;
    this.flushUnknown(false);
  }

  /** Writes the aggregated unknown-refusal count when a minute has passed (or when forced). */
  flushUnknown(force: boolean): void {
    if (this.pendingUnknown === 0) return;
    const t = this.now();
    if (!force && t - this.lastFlush < 60_000) return;
    const count = this.pendingUnknown;
    this.pendingUnknown = 0;
    this.lastFlush = t;
    this.append({ at: new Date(t).toISOString(), event: 'refused-unknown', count });
  }

  private append(row: ConsoleAuditRow): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      maybeRotateJsonl(this.file, { maxBytes: AUDIT_MAX_BYTES, keepRatio: 0.5 });
      fs.appendFileSync(this.file, JSON.stringify(row) + '\n', { mode: 0o600 });
    } catch (err) {
      // @silent-fallback-ok — reported through the injected DegradationReporter hook; the audit never gates
      this.report(err);
    }
  }
}

interface ConsoleState { challenges: BoundSecretStore; tickets: BoundSecretStore; audit: ConsoleTicketAudit; limiter: RedeemLimiter }
const states = new WeakMap<MobilePairingService, ConsoleState>();

/** The per-process console-ticket state of one pairing service. */
export function consoleState(svc: MobilePairingService, now: () => number = Date.now): ConsoleState {
  let s = states.get(svc);
  if (!s) {
    s = {
      challenges: new BoundSecretStore(now),
      tickets: new BoundSecretStore(now),
      audit: new ConsoleTicketAudit(svc.deps.stateDir, now, (err) => svc.deps.reportDegradation?.('MobileConsoleTicket.audit', err)),
      limiter: new RedeemLimiter(now),
    };
    states.set(svc, s);
  }
  return s;
}

/**
 * Whether the device is, right now, an active owner phone: registry status, the device-key
 * ledger, and the resolved person. Read from the same sources the device authenticator trusts.
 */
export function activeOwnerPhone(svc: MobilePairingService, deviceId: string): boolean {
  if (!svc.enabled()) return false;
  const d = svc.devices.get(deviceId);
  if (!d || d.status !== 'active' || !d.publicKey) return false;
  if (svc.keyLedger && svc.keyLedger.isRevoked(deviceKeyHashOf(d.publicKey), d.id)) return false;
  const p = svc.personOfDevice(d);
  return p.ok && p.role === 'owner';
}

type DevicePrincipal = { kind: 'device'; deviceId: string };
function devicePrincipal(req: Request): DevicePrincipal | null {
  const p = (req as unknown as { instarPrincipal?: { kind: string; deviceId?: string } }).instarPrincipal;
  return p && p.kind === 'device' && typeof p.deviceId === 'string' ? { kind: 'device', deviceId: p.deviceId } : null;
}
/** One normalization for every Host this feature compares: the device authenticator's, else lowercase. */
export function normalHost(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return normalizeRequestHost(raw) ?? raw.trim().toLowerCase();
}
export function signedHost(req: Request, svc: MobilePairingService, deviceId: string): string {
  const h = (req as unknown as { instarDeviceHost?: unknown }).instarDeviceHost;
  return normalHost(typeof h === 'string' && h.length > 0 ? h : svc.devices.get(deviceId)?.host ?? '');
}

/**
 * The three device-signed routes. Each: feature on, local TLS or loopback, a device principal
 * whose person is the owner. Mounted on the authed mobile-pairing router.
 */
export function mountConsoleTicketDeviceRoutes(router: Router, svc: MobilePairingService): void {
  /** `enrolment`: the presence-key route also serves Remote Desktop and the PIN page (mobile-owner-presence-pin §2.4 step 6). */
  const gate = (req: Request, res: Response, enrolment = false): string | null => {
    res.setHeader('Cache-Control', 'no-store');
    // Team access's Face ID controls need the key too, on any agent with native conversations.
    const on = isConsoleTicketEnabled(svc.deps.config) || (enrolment && (isOwnerPresenceOn(svc.deps.config) || svc.nativeOn));
    if (!svc.enabled() || !on || !svc.deps.config.authToken) {
      res.status(503).json({ error: 'console-ticket-off', detail: 'Opening the console from the app without the PIN is turned off on this agent.' });
      return null;
    }
    const p = devicePrincipal(req);
    if (!p) { res.status(403).json({ error: 'device-signature-required' }); return null; }
    if (!arrivedOverLocalTls(req.secure, req.socket.remoteAddress, req.headers['x-forwarded-proto'])) {
      res.status(403).json({ error: 'secure-transport-required' });
      return null;
    }
    if (!activeOwnerPhone(svc, p.deviceId)) { res.status(403).json({ error: 'owner-phone-required' }); return null; }
    return p.deviceId;
  };
  const st = () => consoleState(svc);

  router.post(PRESENCE_KEY_PATH, (req: Request, res: Response) => {
    const deviceId = gate(req, res, true);
    if (!deviceId) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const key = body.publicKey;
    if (typeof key !== 'string' || key.length > 128 || !parseDevicePublicKey(key)) { res.status(400).json({ error: 'bad-public-key' }); return; }
    const d = svc.devices.get(deviceId);
    if (!d) { res.status(403).json({ error: 'owner-phone-required' }); return; }
    if (d.publicKey && samePublicKey(key, d.publicKey)) { res.status(400).json({ error: 'bad-public-key', detail: 'The presence key must differ from the device key.' }); return; }
    // Proof of possession: the key signs, so a wrong or broken key is refused now, not stored.
    if (!verifyPresenceSignature(key, presenceEnrollMessage(deviceId, signedHost(req, svc, deviceId), key), body.proof)) {
      st().audit.record({ event: 'refused', deviceId, reason: 'presence-proof-invalid' });
      res.status(400).json({ error: 'presence-proof-invalid' });
      return;
    }
    // Same key again (as decoded bytes) is idempotent: store the stored text form.
    const stored = d.presenceKey && samePublicKey(key, d.presenceKey) ? d.presenceKey : key;
    let r: ReturnType<typeof svc.devices.setPresenceKey>;
    try { r = svc.devices.setPresenceKey(deviceId, stored); } catch (err) {
      svc.deps.reportDegradation?.('MobileConsoleTicket.presenceKey', err);
      res.status(500).json(storageErrorResponse({ error: 'Could not record the key. Try again.' }, svc.deps.stateDir));
      return;
    }
    if (r === 'conflict') { res.status(409).json({ error: 'presence-key-set', detail: 'This phone already has a sign-in key. Remove and pair the phone again to replace it.' }); return; }
    if (r === 'not-active') { res.status(403).json({ error: 'owner-phone-required' }); return; }
    if (r === 'set') st().audit.record({ event: 'presence-key-set', deviceId });
    res.json({ ok: true });
  });

  router.post(CONSOLE_CHALLENGE_PATH, (req: Request, res: Response) => {
    const deviceId = gate(req, res);
    if (!deviceId) return;
    const c = st().challenges.issue(deviceId, signedHost(req, svc, deviceId));
    res.json({ challenge: c.secret, expiresAt: new Date(c.expiresAt).toISOString() });
  });

  router.post(CONSOLE_TICKET_PATH, (req: Request, res: Response) => {
    const deviceId = gate(req, res);
    if (!deviceId) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const d = svc.devices.get(deviceId);
    if (!d?.presenceKey) { res.status(409).json({ error: 'presence-key-missing' }); return; }
    const host = signedHost(req, svc, deviceId);
    const c = st().challenges.consume(body.challenge);
    if (!c || c.deviceId !== deviceId || c.host !== host) {
      st().audit.record({ event: 'refused', deviceId, reason: 'challenge-invalid' });
      res.status(401).json({ error: 'challenge-invalid' });
      return;
    }
    if (!verifyPresenceSignature(d.presenceKey, presenceMessage(deviceId, host, body.challenge as string), body.presenceSig)) {
      st().audit.record({ event: 'refused', deviceId, reason: 'presence-invalid' });
      res.status(401).json({ error: 'presence-invalid' });
      return;
    }
    const t = st().tickets.issue(deviceId, host);
    st().audit.record({ event: 'minted', deviceId, ticketRef: t.ref });
    res.json({ ticket: t.secret, expiresAt: new Date(t.expiresAt).toISOString(), redeemOrigin: `https://${host}` });
  });
}

/**
 * The public redeem, registered before the bearer gate (and exempted in authMiddleware by exact
 * method + path). Answers only `{ token }`.
 */
export function mountConsoleTicketRedeemRoute(app: Application, svc: MobilePairingService, apiToken: () => string | undefined): void {
  app.post(CONSOLE_REDEEM_PATH, (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const st = consoleState(svc);
    if (!arrivedOverLocalTls(req.secure, req.socket.remoteAddress, req.headers['x-forwarded-proto'])) {
      res.status(403).json({ error: 'secure-transport-required' });
      return;
    }
    const token = apiToken();
    if (!svc.enabled() || !isConsoleTicketEnabled(svc.deps.config) || !token) {
      res.status(503).json({ error: 'console-ticket-off' });
      return;
    }
    const raw = (req.body as Record<string, unknown> | undefined)?.ticket;
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 128) { res.status(400).json({ error: 'bad-ticket' }); return; }
    // A known ticket is always judged; only the unknown-ticket path is throttled, so an anonymous
    // caller cannot crowd out the operator's real ticket.
    const t = st.tickets.consume(raw);
    if (!t) {
      st.audit.unknownRefusal();
      const address = req.ip || req.socket.remoteAddress || 'unknown';
      if (!st.limiter.admit(address)) { res.status(429).json({ error: 'too-many-requests' }); return; }
      res.status(401).json({ error: 'ticket-invalid' });
      return;
    }
    const host = normalHost(req.headers.host);
    if (host === '' || host !== normalHost(t.host)) {
      st.audit.record({ event: 'refused', deviceId: t.deviceId, reason: 'host-mismatch', ticketRef: t.ref });
      res.status(401).json({ error: 'ticket-invalid' });
      return;
    }
    if (!activeOwnerPhone(svc, t.deviceId)) {
      st.audit.record({ event: 'refused', deviceId: t.deviceId, reason: 'device-not-active', ticketRef: t.ref });
      res.status(401).json({ error: 'device-not-active' });
      return;
    }
    st.audit.record({ event: 'redeemed', deviceId: t.deviceId, ticketRef: t.ref });
    res.json({ token });
  });
}
