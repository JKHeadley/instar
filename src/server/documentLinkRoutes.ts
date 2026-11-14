/**
 * Instar Documents — linking a member's computer from their phone (spec §3.6a).
 *
 *   POST /docs/_link/nonce         (public, page)  a single-use 10-minute nonce bound to the browser's key
 *   POST /docs/_link/status        (public, page)  waiting | linked | expired, for the nonce in the body
 *   POST /mobile/browsers/link/lookup (member or guest phone) who asked for this code: browser, address, age
 *   POST /mobile/browsers/link     (member or guest phone, device-signed) link that browser to the person
 *   GET  /mobile/browsers          (phone)  the person's linked computers
 *   POST /mobile/browsers/:id/forget (phone)  forget one
 *
 * A linked computer is a browser device for that person, scoped to documents (`documents-read` for a
 * guest), approved by the person's own phone (`approvedVia: 'person-phone'`), for at most 30 days.
 * Its binding (`browser-bind` in the team log) carries the phone's whole signed request, so every
 * machine re-checks phone → browser itself. Each person may hold 3 linked computers, 4 links an hour.
 *
 * Anyone who can reach the tunnel can ask for a code for their own key and send the QR to a member
 * (§3.6a item 6). So each code records who asked (the caller's address, a short browser description
 * from its User-Agent, and when), and the phone is shown that before Face ID. Purely informational:
 * none of it decides anything. Outstanding codes are capped per caller address so one caller can't
 * use up the shared pool.
 */
import crypto from 'node:crypto';
import net from 'node:net';
import { Router, type Request, type Response } from 'express';
import { deviceKeyHashOf } from '../core/AppRecordSignatures.js';
import { canonicalString, deviceKeyOf, isStrictLowSDer, parseDevicePublicKey, type DeviceRecord } from '../core/MobileDeviceKeys.js';
import type { MachineEvent } from '../core/TeamAccessEvents.js';
import type { MobilePairingService } from './mobilePairingRoutes.js';
import { isDocumentsEnabled } from './documentRoutes.js';
import { isLoopbackPeer } from '../core/desktopTransport.js';
import { hasForwardingHeaders, isLoopbackHost } from './mobileBrowserDevices.js';

export const LINK_NONCE_TTL_MS = 10 * 60_000;
export const LINK_MAX_DAYS = 30;
export const LINK_MAX_PER_PERSON = 3;
export const LINK_MAX_PER_HOUR = 4;
/** Outstanding (waiting) link codes one caller address may hold at once. */
export const LINK_MAX_CODES_PER_CALLER = 3;
/** Outstanding link codes across everyone. */
export const LINK_MAX_CODES = 500;

export interface DocumentLinkDeps {
  config: () => unknown;
  pairing: () => MobilePairingService | null;
  machineId: () => string | null;
  isOwnHost: (host: string) => boolean;
  now?: () => number;
}

interface Nonce {
  key: string; host: string; expiresAt: number; state: 'waiting' | 'linked'; deviceId?: string;
  /** Who asked for this code (informational, shown on the phone before Face ID). */
  client: string; browser: string; issuedAt: number;
}

/** What the phone is told about who asked for a code (§3.6a item 6). Informational only. */
export interface LinkRequester { address: string; browser: string; at: string; agoSeconds: number }

/**
 * A short, fixed-vocabulary description of a browser from its User-Agent ("Chrome on macOS"). Never
 * echoes the header itself, so nothing the caller wrote reaches the phone's screen.
 */
export function describeBrowser(ua: unknown): string {
  const u = typeof ua === 'string' ? ua.slice(0, 512) : '';
  const browser = /\bEdg(?:e|A|iOS)?\//.test(u) ? 'Edge'
    : /\b(?:OPR|Opera)\//.test(u) ? 'Opera'
    : /\b(?:Firefox|FxiOS)\//.test(u) ? 'Firefox'
    : /\b(?:Chrome|CriOS|Chromium)\//.test(u) ? 'Chrome'
    : /\bVersion\/[\d.]+.*\bSafari\//.test(u) ? 'Safari'
    : null;
  const os = /\b(?:iPhone|iPod)\b/.test(u) ? 'iPhone'
    : /\biPad\b/.test(u) ? 'iPad'
    : /\bAndroid\b/.test(u) ? 'Android'
    : /\bCrOS\b/.test(u) ? 'ChromeOS'
    : /\bMac OS X\b|\bMacintosh\b/.test(u) ? 'macOS'
    : /\bWindows\b/.test(u) ? 'Windows'
    : /\bLinux\b/.test(u) ? 'Linux'
    : null;
  if (browser && os) return `${browser} on ${os}`;
  if (browser) return browser;
  if (os) return `a browser on ${os}`;
  return 'an unknown browser';
}

/** An address without the IPv4-mapped prefix. */
function plainAddress(a: string | undefined): string | null {
  if (!a) return null;
  return a.startsWith('::ffff:') && net.isIPv4(a.slice(7)) ? a.slice(7) : a;
}

/**
 * The caller's address. `cf-connecting-ip` is trusted only when the request really came through
 * this agent's tunnel: cloudflared runs on this machine, so the connection is loopback and the Host
 * is one of this agent's own names. Any other request is its socket's own address (a header sent
 * straight to the port is the sender's word, never trusted).
 */
export function callerAddress(req: Request, viaOwnName: boolean): string {
  const remote = plainAddress(req.socket.remoteAddress);
  if (viaOwnName && isLoopbackPeer(req.socket.remoteAddress)) {
    const cf = String(req.headers['cf-connecting-ip'] ?? '').trim();
    if (net.isIP(cf)) return plainAddress(cf)!;
  }
  return (remote ?? 'unknown').slice(0, 64);
}

/**
 * The agent's own machine counts as an own host only for exactly `localhost:<port>` or
 * `127.0.0.1:<port>` of this server, from a loopback peer with no forwarding header, as loopback
 * browsers are bound (mobileBrowserDevices `boundSetupHost`).
 */
export function ownLoopbackHost(req: Request, host: string, port: unknown): boolean {
  if (!isLoopbackHost(host) || typeof port !== 'number') return false;
  if (host !== `localhost:${port}` && host !== `127.0.0.1:${port}`) return false;
  return isLoopbackPeer(req.socket.remoteAddress) && !hasForwardingHeaders(req.headers as Record<string, unknown>);
}

/** A person's links from the replicated team log: all of them (for the hourly count), and the live ones. */
function linksOf(svc: MobilePairingService, personKey: string, now: number) {
  const all = [...(svc.teamLog()?.state().browserLinks.values() ?? [])].filter((l) => l.boundTo === personKey);
  const live = all.filter((l) => !l.unbound && Date.parse(l.expiresAt) > now && !svc.keyLedger?.keyRevoked(l.keyHash));
  return { all, live };
}

/** A link's signed request body, parsed once (null when unreadable). */
function linkBodyOf(l: { signed: { bodyB64: string } }): { browserPublicKey?: unknown; host?: unknown } | null {
  try { const v = JSON.parse(Buffer.from(l.signed.bodyB64, 'base64url').toString('utf8')) as unknown; return v && typeof v === 'object' ? v as { browserPublicKey?: unknown; host?: unknown } : null; } catch { return null; } // @silent-fallback-ok — unreadable names nothing
}

/** The browser key a link's signed request names. */
function linkedKeyOf(l: { signed: { bodyB64: string } }): string | null {
  const k = linkBodyOf(l)?.browserPublicKey;
  return typeof k === 'string' ? k : null;
}

/** The fingerprint people compare (the page shows the same): first 16 hex of the key hash, grouped. */
export function linkFingerprint(publicKey: string): string {
  return deviceKeyHashOf(publicKey).slice(0, 16).toUpperCase().match(/.{4}/g)!.join('-');
}

/**
 * A linked computer as another machine sees it: its binding carries the phone's whole signed link
 * request. Valid only when the phone key the binding names (`linkedByKeyHash`, from the replicated
 * ledger) signed it, that key is bound to the same person and not revoked, the request names this key
 * and expiry, and it has not expired.
 */
export function verifyBrowserLink(
  link: Extract<MachineEvent, { type: 'browser-bind' }>,
  phone: { keyHash: string; publicKey: string } | null,
  phoneBoundTo: string | null,
  phoneRevoked: boolean,
  now: number,
): boolean {
  if ((link as { unbound?: true }).unbound || !phone || phoneRevoked || phoneBoundTo !== link.boundTo || Date.parse(link.expiresAt) <= now) return false;
  // Exactly the phone key that signed the link: never a newer (or other) key of that phone.
  if (phone.keyHash !== link.linkedByKeyHash || deviceKeyHashOf(phone.publicKey) !== link.linkedByKeyHash) return false;
  const raw = Buffer.from(link.signed.bodyB64, 'base64url');
  let body: { browserPublicKey?: unknown; expiresAt?: unknown };
  try { body = JSON.parse(raw.toString('utf8')); } catch { return false; } // @silent-fallback-ok — an unreadable request links nothing
  if (typeof body.browserPublicKey !== 'string' || deviceKeyHashOf(body.browserPublicKey) !== link.keyHash || body.expiresAt !== link.expiresAt) return false;
  const key = parseDevicePublicKey(phone.publicKey);
  if (!key) return false;
  let sig: Buffer;
  try { sig = Buffer.from(link.signed.sig, 'base64url'); } catch { return false; } // @silent-fallback-ok — malformed is invalid
  if (!isStrictLowSDer(sig)) return false;
  const message = canonicalString(link.linkedByDeviceId, link.signed.host, 'POST', '/mobile/browsers/link', link.signed.timeMs, raw);
  try { return crypto.verify('sha256', Buffer.from(message), { key, dsaEncoding: 'der' }, sig); } catch { return false; } // @silent-fallback-ok — malformed is invalid
}

/**
 * A documents-scoped computer's one send: exactly the Send template, naming one document, sent to
 * the chat route of a conversation. Returns the document id and the route's conversation, or null.
 */
export function scopedSendTarget(text: unknown, routePath: string): { docId: string; conversation: string } | null {
  if (typeof text !== 'string') return null;
  const m = /^I left (\d{1,4}) comments? on "([^\n]{0,200})" \(version (\d{1,6})\): https:\/\/[A-Za-z0-9.-]+(?::\d+)?\/docs\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(text);
  if (!m) return null;
  const tg = /^\/mobile\/chat\/(\d{1,16})$/.exec(routePath);
  const app = /^\/mobile\/chat\/app\/([0-9a-f-]{36})$/.exec(routePath);
  const conversation = tg ? `telegram:${tg[1]}` : app ? `app:${app[1]}` : null;
  return conversation ? { docId: m[4], conversation } : null;
}

/** Is this linked computer still in force? Expiry, and the linking phone still active and unrevoked. */
export function linkStillValid(d: DeviceRecord, svc: MobilePairingService, now: number): boolean {
  if (d.status !== 'active' || !d.linkExpiresAt || Date.parse(d.linkExpiresAt) <= now) return false;
  const phone = d.linkedByDeviceId ? svc.devices.get(d.linkedByDeviceId) : null;
  if (!phone || phone.status !== 'active' || !phone.publicKey) return false;
  // The key that signed the link (a later rotation of the phone's key does not end it), and the phone's current one.
  if (svc.keyLedger?.isRevoked(d.linkedByKeyHash ?? deviceKeyHashOf(phone.publicKey), phone.id)) return false;
  if (svc.keyLedger?.isRevoked(deviceKeyHashOf(phone.publicKey), phone.id)) return false;
  return phone.userId === d.userId;
}

/** Revoke one linked computer everywhere: the ledger row first (replicated), the registry, the team binding. */
export function forgetLinkedBrowser(svc: MobilePairingService, d: Pick<DeviceRecord, 'id' | 'browserPublicKey'>, at: string): void {
  const key = d.browserPublicKey;
  // Every step runs even when an earlier one throws (a failed ledger write never keeps the computer
  // active here); the first failure is rethrown for the caller to report.
  let first: unknown = null;
  const step = (fn: () => void): void => { try { fn(); } catch (err) { first ??= err; } };
  if (key) step(() => { svc.keyLedger?.recordRevocation({ id: d.id, client: 'browser', browserPublicKey: key }, at); });
  step(() => { if (svc.devices.get(d.id)) svc.devices.revoke(d.id, at); });
  if (key) step(() => { svc.teamLog()?.appendMachineEvents([{ type: 'browser-unbind', keyHash: deviceKeyHashOf(key), deviceId: d.id }]); });
  if (first) throw first;
}

/**
 * The sweep (every minute): expired links, links whose phone was revoked or left, and people the
 * log says were removed. Never on an unreadable or still-loading log: a missing row is not a removal.
 */
export function sweepLinkedBrowsers(svc: MobilePairingService, now: number): number {
  const log = svc.teamLog();
  if (!log || log.healthState() !== 'ok') return 0;
  let n = 0;
  for (const d of svc.devices.list()) {
    if (!d.scope || d.status !== 'active') continue;
    const removed = !!d.userId && log.wasRemoved(d.userId) && !svc.teamStanding(d.userId);
    if (linkStillValid(d, svc, now) && !removed) continue;
    try { forgetLinkedBrowser(svc, d, new Date(now).toISOString()); } catch (err) { svc.reportTeamFault('Documents.linkSweep', err); } // @silent-fallback-ok — reported; the registry revoke still ran, and the next sweep retries the rest
    n++;
  }
  return n;
}

export function createDocumentLinkRoutes(deps: DocumentLinkDeps): Router {
  const router = Router();
  const now = deps.now ?? Date.now;
  const nonces = new Map<string, Nonce>();
  const mints: Array<{ at: number; client: string }> = [];
  const prune = (): void => { const t = now(); for (const [k, v] of nonces) if (v.expiresAt + 60_000 <= t) nonces.delete(k); };
  const requesterOf = (n: Nonce): LinkRequester => ({ address: n.client, browser: n.browser, at: new Date(n.issuedAt).toISOString(), agoSeconds: Math.max(0, Math.floor((now() - n.issuedAt) / 1000)) });
  const off = (res: Response): boolean => {
    if (isDocumentsEnabled(deps.config())) return false;
    res.status(503).json({ error: 'documents-off' });
    return true;
  };
  const phoneOf = (req: Request): string | null => (req as Request & { instarPrincipal?: { kind: string; deviceId?: string } }).instarPrincipal?.deviceId ?? null;

  // ── The page side (public: the computer has no credential yet) ──────────────────────
  router.post('/docs/_link/nonce', (req, res) => {
    if (off(res)) return;
    res.setHeader('Cache-Control', 'no-store');
    if (req.headers['x-instar-request'] !== '1') { res.status(403).json({ error: 'missing-request-header' }); return; }
    const host = String(req.headers.host ?? '').toLowerCase();
    const machineId = deps.machineId();
    if (!deps.pairing()?.browserOn()) { res.status(503).json({ error: 'browser-devices-off', detail: 'Linking a computer is turned off on this agent.' }); return; }
    const loopbackOk = ownLoopbackHost(req, host, (deps.config() as { port?: unknown }).port);
    if (!machineId || !(deps.isOwnHost(host) || loopbackOk)) { res.status(409).json({ error: 'documents-need-a-named-tunnel' }); return; }
    const key = (req.body ?? {}).browserPublicKey;
    if (typeof key !== 'string' || !parseDevicePublicKey(key)) { res.status(400).json({ error: 'bad-key' }); return; }
    const t = now();
    // Per caller and overall, so one caller can't use up linking for everyone. The caller is the
    // tunnel's client address only when the request really came through the tunnel.
    const client = callerAddress(req, deps.isOwnHost(host));
    while (mints.length && t - mints[0].at > 60_000) mints.shift();
    if (mints.length >= 120 || mints.filter((m) => m.client === client).length >= 6) { res.status(429).json({ error: 'too-many-requests' }); return; }
    mints.push({ at: t, client });
    prune();
    // A new code for the same key replaces that caller's earlier one (a reloaded page never locks itself out).
    for (const [k, v] of nonces) if (v.state === 'waiting' && v.key === key && v.client === client) nonces.delete(k);
    const waiting = [...nonces.values()].filter((v) => v.state === 'waiting' && v.expiresAt > t);
    if (waiting.filter((v) => v.client === client).length >= LINK_MAX_CODES_PER_CALLER) { res.status(429).json({ error: 'too-many-codes', detail: 'Too many link codes are waiting from this network. Wait a few minutes and try again.' }); return; }
    if (nonces.size >= LINK_MAX_CODES) { res.status(429).json({ error: 'too-many-requests' }); return; }
    const nonce = crypto.randomBytes(24).toString('base64url');
    nonces.set(nonce, { key, host, expiresAt: t + LINK_NONCE_TTL_MS, state: 'waiting', client, browser: describeBrowser(req.headers['user-agent']), issuedAt: t });
    res.json({ nonce, machineId, host, expiresAt: new Date(t + LINK_NONCE_TTL_MS).toISOString() });
  });

  // POST with the nonce in the body, so the code never sits in a URL (logs, history, referrers).
  router.post('/docs/_link/status', (req, res) => {
    if (off(res)) return;
    res.setHeader('Cache-Control', 'no-store');
    if (req.headers['x-instar-request'] !== '1') { res.status(403).json({ error: 'missing-request-header' }); return; }
    const raw = (req.body ?? {}).nonce;
    const n = typeof raw === 'string' && raw.length <= 64 ? nonces.get(raw) : undefined;
    if (!n) { res.json({ state: 'expired' }); return; }
    if (n.state === 'linked') { res.json({ state: 'linked', deviceId: n.deviceId }); return; }
    res.json({ state: n.expiresAt > now() ? 'waiting' : 'expired' });
  });

  // ── The phone side (device-signed through DEVICE_ALLOWLIST) ────────────────────────

  // Before Face ID the phone asks who wanted this code (§3.6a item 6): the computer's browser, the
  // address it asked from, and how long ago. Shown to the member; it decides nothing here.
  router.post('/mobile/browsers/link/lookup', (req, res) => {
    if (off(res)) return;
    res.setHeader('Cache-Control', 'no-store');
    const svc = deps.pairing();
    const phoneId = phoneOf(req);
    const phone = svc && phoneId ? svc.devices.get(phoneId) : null;
    if (!svc || !phone) { res.status(503).json({ error: 'pairing-unavailable' }); return; }
    if (!svc.browserOn()) { res.status(503).json({ error: 'browser-devices-off', detail: 'Linking a computer is turned off on this agent.' }); return; }
    const person = svc.personOfDevice(phone);
    if (!person.ok || person.role !== 'team' || !person.userId || !person.tier) { res.status(403).json({ error: 'member-phone-required' }); return; }
    const b = (req.body ?? {}) as { nonce?: unknown; browserPublicKey?: unknown };
    const n = typeof b.nonce === 'string' ? nonces.get(b.nonce) : undefined;
    if (!n || n.state !== 'waiting' || n.expiresAt <= now() || n.key !== b.browserPublicKey) { res.status(410).json({ error: 'link-code-expired', detail: 'This code has expired. Show a new code on the computer.' }); return; }
    res.json({ state: 'waiting', fingerprint: linkFingerprint(n.key), host: n.host, expiresAt: new Date(n.expiresAt).toISOString(), requester: requesterOf(n) });
  });

  router.post('/mobile/browsers/link', (req, res) => {
    if (off(res)) return;
    res.setHeader('Cache-Control', 'no-store');
    const svc = deps.pairing();
    const phoneId = phoneOf(req);
    const phone = svc && phoneId ? svc.devices.get(phoneId) : null;
    const log = svc?.teamLog() ?? null;
    if (!svc || !phone || !log || !svc.keyLedger) { res.status(503).json({ error: 'pairing-unavailable' }); return; }
    if (!svc.browserOn()) { res.status(503).json({ error: 'browser-devices-off', detail: 'Linking a computer is turned off on this agent.' }); return; }
    if (log.healthState() !== 'ok') { res.status(503).json({ error: 'team-log-unavailable', detail: 'Try again in a minute.' }); return; }
    const person = svc.personOfDevice(phone);
    // The owner links computers through the console's own approved-browser flow (§3.6).
    if (!person.ok || person.role !== 'team' || !person.userId || !person.tier) { res.status(403).json({ error: 'member-phone-required' }); return; }
    const standing = svc.teamStanding(person.userId);
    if (!standing) { res.status(403).json({ error: 'person-unknown' }); return; }
    const b = (req.body ?? {}) as { browserPublicKey?: unknown; nonce?: unknown; machineId?: unknown; host?: unknown; expiresAt?: unknown };
    const t = now();
    const n = typeof b.nonce === 'string' ? nonces.get(b.nonce) : undefined;
    if (!n || n.state !== 'waiting' || n.expiresAt <= t || n.key !== b.browserPublicKey) { res.status(410).json({ error: 'link-code-expired', detail: 'This code has expired. Show a new code on the computer.' }); return; }
    // The host the computer is on is exactly the one this machine answered its nonce on.
    if (b.machineId !== deps.machineId() || typeof b.host !== 'string' || n.host !== b.host.toLowerCase()) { res.status(409).json({ error: 'wrong-machine' }); return; }
    const exp = typeof b.expiresAt === 'string' ? Date.parse(b.expiresAt) : NaN;
    if (!Number.isFinite(exp) || exp <= t || exp > t + LINK_MAX_DAYS * 86_400_000 + 60_000) { res.status(400).json({ error: 'bad-expiry' }); return; }
    const key = n.key;
    const keyHash = deviceKeyHashOf(key);
    // A key already bound anywhere (a phone, or a computer linked on another machine) is never re-linked.
    if (log.state().bindings.has(keyHash) || log.state().browserLinks.has(keyHash)) { res.status(409).json({ error: 'already-linked' }); return; }
    // Allowance, counted from the replicated links (forgotten ones still count for the hour).
    const { all, live } = linksOf(svc, person.userId, t);
    if (live.length >= LINK_MAX_PER_PERSON) { res.status(409).json({ error: 'browser-link-limit', detail: 'You already have 3 linked computers. Forget one in the app first.' }); return; }
    if (all.filter((l) => t - Date.parse(l.linkedAt) < 3_600_000).length >= LINK_MAX_PER_HOUR) { res.status(429).json({ error: 'too-many-requests' }); return; }
    const raw = (req as Request & { rawBody?: Buffer }).rawBody;
    const signedHost = String((req as Request & { instarDeviceHost?: string }).instarDeviceHost ?? phone.host ?? '').toLowerCase();
    const timeMs = String(req.headers['x-instar-device-time'] ?? '');
    const sig = String(req.headers['x-instar-device-sig'] ?? '');
    if (!raw || raw.length > 1500 || !sig || !timeMs) { res.status(400).json({ error: 'bad-request' }); return; }
    const at = new Date(t).toISOString();
    const scope = person.tier === 'guest' ? 'documents-read' as const : 'documents' as const;
    const phoneKey = deviceKeyOf(phone);
    if (!phoneKey) { res.status(503).json({ error: 'pairing-unavailable' }); return; }
    const linkedByKeyHash = deviceKeyHashOf(phoneKey);
    const created = svc.devices.createLinkedBrowser({ browserPublicKey: key, host: b.host.toLowerCase(), userId: person.userId, scope, linkedByDeviceId: phone.id, linkedByKeyHash, linkExpiresAt: new Date(exp).toISOString(), approvedAt: at });
    if (!created.ok) { res.status(409).json({ error: 'already-linked' }); return; }
    // The ledger activation (the replicated proof of the key), then the binding with the phone's
    // request. If either write fails, the computer is revoked again: never active without both.
    try {
      if (!svc.keyLedger.recordActivation(created.device, 'person-phone', at)) throw new Error('activation-not-written');
      log.appendMachineEvents([{ type: 'browser-bind', keyHash, deviceId: created.device.id, boundTo: person.userId, linkedByDeviceId: phone.id, linkedByKeyHash, linkedAt: at, expiresAt: new Date(exp).toISOString(), scope, signed: { host: signedHost, timeMs, sig, bodyB64: raw.toString('base64url') } }]);
    } catch (err) {
      svc.reportTeamFault('Documents.linkRecord', err);
      // Undo in its own try: a failure here is reported, never a 500 (the registry revoke runs regardless).
      try { forgetLinkedBrowser(svc, created.device, at); } catch (undoErr) { svc.reportTeamFault('Documents.linkUndo', undoErr); } // @silent-fallback-ok — reported; the sweep retries the unbind
      res.status(503).json({ error: 'link-not-recorded', detail: 'The link could not be saved. Show a new code and try again.' });
      return;
    }
    n.state = 'linked';
    n.deviceId = created.device.id;
    res.status(201).json({ id: created.device.id, host: created.device.host, scope, expiresAt: new Date(exp).toISOString(), requester: requesterOf(n) });
  });

  router.get('/mobile/browsers', (req, res) => {
    if (off(res)) return;
    const svc = deps.pairing();
    const phone = svc && phoneOf(req) ? svc.devices.get(phoneOf(req)!) : null;
    if (!svc || !phone) { res.status(503).json({ error: 'pairing-unavailable' }); return; }
    const person = svc.personOfDevice(phone);
    if (!person.ok || !person.userId) { res.json({ browsers: [] }); return; }
    // From the replicated links, so a computer linked on a machine that is asleep is still listed.
    const { live } = linksOf(svc, person.userId, now());
    res.json({ browsers: live.map((l) => { const body = linkBodyOf(l); const k = typeof body?.browserPublicKey === 'string' ? body.browserPublicKey : null; return { id: l.deviceId, host: typeof body?.host === 'string' ? body.host : null, fingerprint: k ? linkFingerprint(k) : null, linkedAt: l.linkedAt, expiresAt: l.expiresAt }; }) });
  });

  router.post('/mobile/browsers/:id/forget', (req, res) => {
    if (off(res)) return;
    const svc = deps.pairing();
    const phone = svc && phoneOf(req) ? svc.devices.get(phoneOf(req)!) : null;
    if (!svc || !phone) { res.status(503).json({ error: 'pairing-unavailable' }); return; }
    const person = svc.personOfDevice(phone);
    // Only that person's own linked computer, found in the replicated links on any machine; else 404.
    const link = person.ok && person.userId ? linksOf(svc, person.userId, now()).all.find((l) => l.deviceId === req.params.id && !l.unbound) : undefined;
    const key = link ? linkedKeyOf(link) : null;
    if (!link || !key) { res.status(404).json({ error: 'unknown-computer' }); return; }
    forgetLinkedBrowser(svc, { id: link.deviceId, browserPublicKey: key }, new Date(now()).toISOString());
    res.json({ ok: true });
  });

  return router;
}
