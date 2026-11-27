/**
 * Add a new agent from a phone you already use (docs/specs/mobile-pairing-introducer.md).
 *
 * Two halves, both mounted on the mobile-pairing router:
 *
 * - The INTRODUCER (an agent the phone is already an owner phone of): after a fresh Face ID
 *   presence signature from that owner phone, it signs with its own agent identity key a short
 *   note naming ONE waiting phone (device id + key fingerprint) on ONE other agent (its Host).
 *   The bearer token never reaches these routes.
 * - The NEW agent: the waiting phone itself hands that note in, signed with its own pending key.
 *   The new agent trusts only the introducer keys its creator wrote into its own config
 *   (`mobilePairing.ownerIntroducers`); there is deliberately no route that adds one.
 *
 * Everything here is machine-local and in memory except the introducer's audit file.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Request, Response, Router } from 'express';
import { arrivedOverLocalTls } from '../core/desktopTransport.js';
import type { InstarConfig } from '../core/types.js';
import { featureEvidence } from '../monitoring/FeatureEvidenceLog.js';
import { sign, verify } from '../threadline/ThreadlineCrypto.js';
import { publicKeyFromSeed } from '@sagemindai/threadline-core';
import { BoundSecretStore, activeOwnerPhone, signedHost, verifyPresenceSignature } from './mobileConsoleTicket.js';
import { approveAnswer, isPairingApproveEnabled, type MobilePairingService } from './mobilePairingRoutes.js';

export const INTRODUCTION_VERSION = 'instar-owner-introduction-v1';
/** How long a signed introduction lives. */
export const INTRODUCTION_TTL_MS = 120_000;
/** The longest window the new agent accepts, whoever signed it. */
export const INTRODUCTION_MAX_WINDOW_MS = 300_000;
/** Clock skew tolerated on `iat`. */
export const INTRODUCTION_SKEW_MS = 30_000;
export const MAX_INTRODUCERS = 8;
const MAX_INTRO_CHARS = 2048;
const MAX_SIG_CHARS = 128;
const NONCE_CAP = 256;
const HOST_RE = /^[a-z0-9.-]{1,253}(:\d{1,5})?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FP_RE = /^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

export interface Introducer { name: string; publicKey: Buffer; keyB64: string; keyId: string }
export interface IntroductionPayload {
  v: 1; introducerKey: string; introducerName: string; aud: string; deviceId: string; fingerprint: string; iat: number; exp: number; nonce: string;
}

/** `XXXX-XXXX-XXXX-XXXX` from the first 16 hex of SHA-256 of the raw Ed25519 key. */
export function introducerKeyId(raw: Buffer): string {
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16).toUpperCase().match(/.{4}/g)!.join('-');
}

function rawKey(b64: unknown): Buffer | null {
  if (typeof b64 !== 'string' || b64.length > 64 || !B64URL_RE.test(b64.replace(/=+$/, ''))) return null;
  const b = Buffer.from(b64.replace(/=+$/, ''), 'base64url');
  return b.length === 32 ? b : null;
}

const reportedBadEntries = new WeakSet<object>();
/** The configured introducers (at most 8). A malformed entry is skipped and reported once per config object. */
export function ownerIntroducers(config: InstarConfig, report?: (err: Error) => void): Introducer[] {
  const list = (config.mobilePairing as { ownerIntroducers?: unknown } | undefined)?.ownerIntroducers;
  if (!Array.isArray(list)) return [];
  const out: Introducer[] = [];
  let bad = 0;
  for (const e of list.slice(0, MAX_INTRODUCERS)) {
    const o = (e ?? {}) as Record<string, unknown>;
    const key = rawKey(o.publicKey);
    const name = typeof o.name === 'string' ? o.name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 40) : '';
    if (!key || !name) { bad++; continue; }
    if (out.some((x) => x.publicKey.equals(key))) continue;
    out.push({ name, publicKey: key, keyB64: key.toString('base64url'), keyId: introducerKeyId(key) });
  }
  if ((bad > 0 || list.length > MAX_INTRODUCERS) && report && !reportedBadEntries.has(list)) {
    reportedBadEntries.add(list);
    report(new Error(`${bad} ownerIntroducers entr${bad === 1 ? 'y' : 'ies'} ignored (a name and a 32-byte base64url Ed25519 key are required; at most ${MAX_INTRODUCERS})`));
  }
  return out;
}

/** The exact bytes an introduction signature covers. */
export function introductionSignedBytes(payloadBytes: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${INTRODUCTION_VERSION}\n`), payloadBytes]);
}

/** The line a presence signature names (one waiting phone on one agent). */
export function introduceLine(audienceHost: string, deviceId: string, fingerprint: string): string {
  return `introduce ${audienceHost} ${deviceId} ${fingerprint}`;
}

/** The exact bytes the owner phone's presence key signs for one introduction. */
export function introducePresenceMessage(approverDeviceId: string, host: string, challenge: string, line: string): string {
  return `${INTRODUCTION_VERSION}\n${approverDeviceId}\n${host.toLowerCase()}\n${challenge}\n${line}`;
}

export function signIntroduction(p: Omit<IntroductionPayload, 'v'>, privateKey: Buffer): { introduction: string; signature: string } {
  const bytes = Buffer.from(JSON.stringify({ v: 1, ...p }), 'utf8');
  return { introduction: bytes.toString('base64url'), signature: sign(privateKey, introductionSignedBytes(bytes)).toString('base64url') };
}

export type IntroductionRefusal = 'bad-introduction' | 'introducer-unknown' | 'introduction-invalid' | 'introduction-expired';

/** Signature, configured key and time window. Audience, device and nonce are the caller's checks. */
export function verifyIntroduction(introduction: unknown, signature: unknown, introducers: Introducer[], now: number):
  { ok: true; payload: IntroductionPayload; introducer: Introducer } | { ok: false; error: IntroductionRefusal } {
  if (typeof introduction !== 'string' || typeof signature !== 'string' || introduction.length > MAX_INTRO_CHARS || signature.length > MAX_SIG_CHARS
    || !B64URL_RE.test(introduction) || !B64URL_RE.test(signature)) return { ok: false, error: 'bad-introduction' };
  const bytes = Buffer.from(introduction, 'base64url');
  let p: Record<string, unknown>;
  try { p = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>; } catch { return { ok: false, error: 'bad-introduction' }; } // @silent-fallback-ok — malformed input is refused 400
  if (!p || typeof p !== 'object' || Array.isArray(p)) return { ok: false, error: 'bad-introduction' };
  const shapeOk = p.v === 1 && typeof p.introducerKey === 'string' && typeof p.aud === 'string' && HOST_RE.test(p.aud)
    && typeof p.deviceId === 'string' && UUID_RE.test(p.deviceId) && typeof p.fingerprint === 'string' && FP_RE.test(p.fingerprint)
    && Number.isSafeInteger(p.iat) && Number.isSafeInteger(p.exp) && typeof p.nonce === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(p.nonce)
    && typeof p.introducerName === 'string';
  if (!shapeOk) return { ok: false, error: 'bad-introduction' };
  const claimed = rawKey(p.introducerKey);
  // The payload's key only picks WHICH configured key to try; a key not configured is never used.
  const introducer = claimed ? introducers.find((i) => i.publicKey.equals(claimed)) : undefined;
  if (!introducer) return { ok: false, error: 'introducer-unknown' };
  let good = false;
  try { good = verify(introducer.publicKey, introductionSignedBytes(bytes), Buffer.from(signature, 'base64url')); } catch { good = false; } // @silent-fallback-ok — an unverifiable signature is invalid
  if (!good) return { ok: false, error: 'introduction-invalid' };
  const iat = p.iat as number; const exp = p.exp as number;
  if (exp <= iat || exp - iat > INTRODUCTION_MAX_WINDOW_MS || now < iat - INTRODUCTION_SKEW_MS || now > exp) return { ok: false, error: 'introduction-expired' };
  return { ok: true, payload: p as unknown as IntroductionPayload, introducer };
}

/** Used nonces until their introduction could no longer verify (plus a minute). */
export class IntroductionNonces {
  private readonly seen = new Map<string, number>();
  constructor(private readonly now: () => number = Date.now) {}
  /** True the first time; false for a replay, or when full of live entries (fail closed). */
  take(nonce: string, exp: number): boolean {
    const t = this.now();
    for (const [n, until] of this.seen) if (until <= t) this.seen.delete(n);
    if (this.seen.has(nonce) || this.seen.size >= NONCE_CAP) return false;
    this.seen.set(nonce, exp + 60_000);
    return true;
  }
}

export interface IntroducerIdentity { publicKey: Buffer; privateKey: Buffer }

/**
 * The introducer key: an Ed25519 key DERIVED from the agent identity seed (HKDF-SHA256, its own
 * info string), never the identity key itself. The identity key also signs bytes other parties
 * choose (the relay's auth nonce is signed as-is), so a signature by it proves nothing about an
 * owner's approval. The derived key signs only introductions, and every machine of the agent
 * derives the same key from the adopted identity (spec §3.1).
 */
export const INTRODUCER_KEY_INFO = 'instar-owner-introducer-key-v1';
export function deriveIntroducerKey(identity: IntroducerIdentity): IntroducerIdentity {
  const seed = Buffer.from(crypto.hkdfSync('sha256', identity.privateKey.subarray(0, 32), Buffer.alloc(0), INTRODUCER_KEY_INFO, 32));
  return { publicKey: publicKeyFromSeed(seed), privateKey: seed };
}

export interface IntroducerRouteDeps {
  /** This agent's own identity (fresh read per call), or null when it has none. */
  readIdentity: () => IntroducerIdentity | null;
  now?: () => number;
}

type AnyPrincipal = { kind: string; deviceId?: string };
const principal = (req: Request): AnyPrincipal => (req as unknown as { instarPrincipal?: AnyPrincipal }).instarPrincipal ?? { kind: 'token' };

/**
 * The introducer's routes: the public entry for a creator to copy, and the two owner-phone routes
 * that sign one introduction after Face ID.
 */
export function mountIntroducerRoutes(router: Router, svc: MobilePairingService, deps: IntroducerRouteDeps): void {
  const now = deps.now ?? Date.now;
  const challenges = new BoundSecretStore(now);
  const auditPath = path.join(svc.deps.stateDir, 'state', 'mobile-introductions.jsonl');
  const audit = (row: Record<string, unknown>): void => {
    try {
      fs.mkdirSync(path.dirname(auditPath), { recursive: true });
      fs.appendFileSync(auditPath, JSON.stringify({ at: new Date(now()).toISOString(), ...row }) + '\n', { mode: 0o600 });
    } catch (err) { svc.deps.reportDegradation?.('MobileIntroducer.audit', err); } // @silent-fallback-ok — reported; the signature was still made for a verified owner phone
  };
  const off = (res: Response): boolean => {
    res.setHeader('Cache-Control', 'no-store');
    if (svc.enabled() && isPairingApproveEnabled(svc.deps.config)) return false;
    res.status(503).json({ error: 'introductions-off', detail: 'Adding phones from the app is turned off on this agent.' });
    return true;
  };
  const identity = (): IntroducerIdentity | null => {
    try { const id = deps.readIdentity(); return id && id.publicKey.length === 32 && id.privateKey.length >= 32 ? deriveIntroducerKey(id) : null; } catch { /* @silent-fallback-ok — no identity answers 404 no-identity */ return null; }
  };

  /** Bearer (the agent creating another agent) or an owner phone of this agent. */
  router.get('/mobile/introducer', (req: Request, res: Response) => {
    if (off(res)) return;
    const p = principal(req);
    if (p.kind === 'device-notify' || (p.kind === 'device' && !activeOwnerPhone(svc, p.deviceId ?? ''))) { res.status(403).json({ error: 'owner-phone-required' }); return; }
    const id = identity();
    if (!id) { res.status(404).json({ error: 'no-identity', detail: 'This agent has no identity key yet, so it cannot vouch for phones.' }); return; }
    const name = svc.deps.config.projectName ?? 'agent';
    const keyB64 = id.publicKey.toString('base64url');
    res.json({ name, publicKey: keyB64, keyId: introducerKeyId(id.publicKey), configEntry: { name, publicKey: keyB64 } });
  });

  /** Owner phone, local TLS: returns the approver id, or answers and returns null. */
  const gate = (req: Request, res: Response): string | null => {
    if (off(res)) return null;
    const p = principal(req);
    if (p.kind !== 'device' || typeof p.deviceId !== 'string') { res.status(403).json({ error: 'device-signature-required', detail: 'Only the owner\'s paired phone can do this.' }); return null; }
    const approver = p.deviceId;
    const refuse = (status: number, error: string): null => {
      featureEvidence.record('mobilePairing', { kind: 'held', reason: `introduction refused: ${error}`, context: { approver } });
      res.status(status).json({ error });
      return null;
    };
    if (!arrivedOverLocalTls(req.secure, req.socket.remoteAddress, req.headers['x-forwarded-proto'])) return refuse(403, 'secure-transport-required');
    if (!activeOwnerPhone(svc, approver)) return refuse(403, 'owner-phone-required');
    return approver;
  };
  const target = (body: unknown): { aud: string; deviceId: string; fingerprint: string } | null => {
    const b = (body ?? {}) as Record<string, unknown>;
    const aud = typeof b.audienceHost === 'string' ? b.audienceHost.trim().toLowerCase() : '';
    const deviceId = typeof b.deviceId === 'string' ? b.deviceId : '';
    const fingerprint = typeof b.fingerprint === 'string' ? b.fingerprint : '';
    return HOST_RE.test(aud) && UUID_RE.test(deviceId) && FP_RE.test(fingerprint) ? { aud, deviceId, fingerprint } : null;
  };

  router.post('/mobile/introductions/challenge', (req: Request, res: Response) => {
    const approver = gate(req, res);
    if (!approver) return;
    if (!svc.devices.get(approver)?.presenceKey) { res.status(409).json({ error: 'presence-key-missing' }); return; }
    const t = target(req.body);
    if (!t) { res.status(400).json({ error: 'bad-target', detail: 'audienceHost, deviceId and fingerprint are required.' }); return; }
    if (!identity()) { res.status(404).json({ error: 'no-identity', detail: 'This agent has no identity key yet, so it cannot vouch for phones.' }); return; }
    const c = challenges.issue(`${approver}\n${introduceLine(t.aud, t.deviceId, t.fingerprint)}`, signedHost(req, svc, approver));
    res.json({ challenge: c.secret, expiresAt: new Date(c.expiresAt).toISOString() });
  });

  router.post('/mobile/introductions', (req: Request, res: Response) => {
    const approver = gate(req, res);
    if (!approver) return;
    const key = svc.devices.get(approver)?.presenceKey;
    if (!key) { res.status(409).json({ error: 'presence-key-missing' }); return; }
    const t = target(req.body);
    if (!t) { res.status(400).json({ error: 'bad-target', detail: 'audienceHost, deviceId and fingerprint are required.' }); return; }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const line = introduceLine(t.aud, t.deviceId, t.fingerprint);
    const host = signedHost(req, svc, approver);
    const c = challenges.consume(b.challenge);
    if (!c || c.deviceId !== `${approver}\n${line}` || c.host !== host) {
      featureEvidence.record('mobilePairing', { kind: 'held', reason: 'introduction refused: challenge-invalid', context: { approver } });
      res.status(401).json({ error: 'challenge-invalid' });
      return;
    }
    if (!verifyPresenceSignature(key, introducePresenceMessage(approver, host, b.challenge as string, line), b.presenceSig)) {
      featureEvidence.record('mobilePairing', { kind: 'held', reason: 'introduction refused: presence-invalid', context: { approver } });
      res.status(401).json({ error: 'presence-invalid' });
      return;
    }
    const id = identity();
    if (!id) { res.status(404).json({ error: 'no-identity', detail: 'This agent has no identity key yet, so it cannot vouch for phones.' }); return; }
    const iat = now();
    const nonce = crypto.randomBytes(16).toString('base64url');
    const out = signIntroduction({
      introducerKey: id.publicKey.toString('base64url'), introducerName: svc.deps.config.projectName ?? 'agent',
      aud: t.aud, deviceId: t.deviceId, fingerprint: t.fingerprint, iat, exp: iat + INTRODUCTION_TTL_MS, nonce,
    }, id.privateKey);
    audit({ approver, audienceHost: t.aud, deviceId: t.deviceId, fingerprint: t.fingerprint, nonceHash: crypto.createHash('sha256').update(nonce).digest('hex').slice(0, 16) });
    featureEvidence.record('mobilePairing', { kind: 'fired', reason: 'introduction signed for an owner phone', context: { approver, audienceHost: t.aud } });
    res.json(out);
  });
}

/** The new agent's side: the waiting phone hands in an introduction for itself. */
export function mountIntroductionRedeemRoute(router: Router, svc: MobilePairingService, now: () => number = Date.now): void {
  const nonces = new IntroductionNonces(now);
  router.post('/mobile/device/introduction', (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const introducers = svc.introducers();
    if (!svc.enabled() || !isPairingApproveEnabled(svc.deps.config) || introducers.length === 0) {
      res.status(503).json({ error: 'introductions-off', detail: 'This agent does not take approvals from your other agents. Use the code.' });
      return;
    }
    const p = principal(req);
    if (p.kind !== 'device' || typeof p.deviceId !== 'string') { res.status(403).json({ error: 'device-signature-required' }); return; }
    const deviceId = p.deviceId;
    const refuse = (status: number, error: string, detail: string): void => {
      featureEvidence.record('mobilePairing', { kind: 'held', reason: `introduction redeem refused: ${error}`, context: { deviceId } });
      res.status(status).json({ error, detail });
    };
    const b = (req.body ?? {}) as Record<string, unknown>;
    const v = verifyIntroduction(b.introduction, b.signature, introducers, now());
    if (!v.ok) {
      const map: Record<IntroductionRefusal, [number, string]> = {
        'bad-introduction': [400, 'That approval could not be read. Try again, or use the code.'],
        'introducer-unknown': [403, 'This agent does not trust the agent that approved this phone. Use the code.'],
        'introduction-invalid': [403, 'That approval did not check out. Try again, or use the code.'],
        'introduction-expired': [401, 'That approval took too long and expired. Try again.'],
      };
      const [s, d] = map[v.error];
      refuse(s, v.error, d);
      return;
    }
    if (v.payload.aud !== signedHost(req, svc, deviceId)) { refuse(403, 'introduction-wrong-agent', 'That approval was for a different agent. Try again.'); return; }
    const row = svc.devices.get(deviceId);
    if (v.payload.deviceId !== deviceId || !row || row.status !== 'pending' || row.fingerprint !== v.payload.fingerprint) {
      if (row?.status === 'active') { res.json({ status: 'active', deviceId }); return; }
      refuse(403, 'introduction-wrong-phone', 'That approval was for a different phone, or this phone is no longer waiting.');
      return;
    }
    if (!nonces.take(v.payload.nonce, v.payload.exp)) { refuse(409, 'introduction-replayed', 'That approval was already used. Try again.'); return; }
    const outcome = svc.approvePending(deviceId, 'owner-agent', { approvedBy: `introducer:${v.introducer.keyId}` });
    if (outcome === 'approved') svc.tellOwnerIntroduced(v.introducer.name, row);
    approveAnswer(res, outcome, deviceId);
  });
}
