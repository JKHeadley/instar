/**
 * Mobile device keys (docs/specs/mobile-device-keys.md).
 *
 * Each paired phone holds a non-exportable P-256 key in its Secure Enclave. The agent stores
 * only the public key. A device becomes usable only after the phone sends back the 6-digit
 * code that went only to the owner's private Telegram chat; from then on it authenticates
 * allowlisted requests with a low-S ECDSA signature over a canonical string bound to its id
 * and the host it paired with. Revoked is a terminal tombstone that wins every merge.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PAIRING_WORDS, PAIRING_WORD_SET } from './pairingWords.js';

export const DEVICE_SIG_VERSION = 'instar-device-v1';
export const DEVICE_TIME_WINDOW_MS = 60_000;
export const REPLAY_TTL_MS = 3 * 60_000;
export const MAX_REPLAY_PER_DEVICE = 2_000;
/** Entries only a send route may use (media spec §4.10). */
export const REPLAY_SEND_RESERVE = 100;

export type DeviceStatus = 'pending' | 'active' | 'declined' | 'expired' | 'revoked';

/** Revoked wins every merge; otherwise the later-moving state wins. */
export const STATUS_RANK: Record<DeviceStatus, number> = { pending: 0, expired: 1, declined: 2, active: 3, revoked: 4 };

export function mergeStatus(a: DeviceStatus, b: DeviceStatus): DeviceStatus {
  if (a === 'revoked' || b === 'revoked') return 'revoked';
  return STATUS_RANK[a] >= STATUS_RANK[b] ? a : b;
}

/** Decode a base64url string (no padding) to bytes, or null. */
function b64url(s: unknown): Buffer | null {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]+$/.test(s) || s.length > 512) return null;
  return Buffer.from(s, 'base64url');
}

/**
 * Validate a 65-byte uncompressed X9.63 P-256 public key and return it as a KeyObject.
 * Null when it is not a point on the curve.
 */
export function parseDevicePublicKey(raw: unknown): crypto.KeyObject | null {
  const bytes = b64url(raw);
  if (!bytes || bytes.length !== 65 || bytes[0] !== 0x04) return null;
  try {
    return crypto.createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: bytes.subarray(1, 33).toString('base64url'), y: bytes.subarray(33).toString('base64url') },
      format: 'jwk',
    });
  } catch {
    // @silent-fallback-ok — an invalid point is reported to the caller as "not a valid key" (null)
    return null;
  }
}

/** First 16 hex of SHA-256 over the raw public key, shown in groups of four. */
export function deviceFingerprint(publicKeyB64: string): string {
  const h = crypto.createHash('sha256').update(Buffer.from(publicKeyB64, 'base64url')).digest('hex').slice(0, 16).toUpperCase();
  return h.match(/.{4}/g)!.join('-');
}

export function canonicalString(deviceId: string, host: string, method: string, pathWithQuery: string, timeMs: string, rawBody: Buffer | undefined): string {
  const bodyHash = crypto.createHash('sha256').update(rawBody ?? Buffer.alloc(0)).digest('hex');
  return `${DEVICE_SIG_VERSION}\n${deviceId}\n${host.toLowerCase()}\n${method.toUpperCase()}\n${pathWithQuery}\n${timeMs}\n${bodyHash}`;
}

/** P-256 group order n and n/2, for the low-S rule. */
const P256_N = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
const P256_HALF_N = P256_N >> 1n;

/**
 * Strict DER ECDSA signature with low S: SEQUENCE { INTEGER r, INTEGER s }, minimal encodings,
 * no trailing bytes, 0 < r,s < n, s <= n/2. Re-encoded or high-S (malleated) signatures fail.
 */
export function isStrictLowSDer(sig: Buffer): boolean {
  if (sig.length < 8 || sig.length > 72 || sig[0] !== 0x30 || sig[1] !== sig.length - 2) return false;
  let i = 2;
  const readInt = (): bigint | null => {
    if (sig[i] !== 0x02) return null;
    const len = sig[i + 1];
    if (len === undefined || len === 0 || len > 33 || i + 2 + len > sig.length) return null;
    const bytes = sig.subarray(i + 2, i + 2 + len);
    if (bytes[0]! & 0x80) return null;                                  // negative
    if (len > 1 && bytes[0] === 0x00 && !(bytes[1]! & 0x80)) return null; // non-minimal
    i += 2 + len;
    return BigInt('0x' + bytes.toString('hex'));
  };
  const r = readInt(); const sv = readInt();
  if (r === null || sv === null || i !== sig.length) return false;
  if (r <= 0n || r >= P256_N || sv <= 0n || sv > P256_HALF_N) return false;
  return true;
}

export interface SignedRequestParts {
  deviceId: unknown;
  time: unknown;
  sig: unknown;
  method: string;
  pathWithQuery: string;
  rawBody: Buffer | undefined;
  /**
   * Multi-route (docs/specs/mobile-multi-route.md §4.2): the request's own Host, already checked
   * by the caller to be one of this machine's own names reached through its local TLS front.
   * Absent ⇒ the device's stored paired host, exactly as before.
   */
  host?: string;
}

export type VerifyResult =
  | { ok: true; deviceId: string }
  | { ok: false; reason: 'malformed' | 'unknown-device' | 'not-allowed-status' | 'stale' | 'bad-signature' | 'replay' | 'rate-limited' };

/**
 * Replay set keyed on the SHA-256 of the canonical string (not the signature bytes, which
 * ECDSA malleability could vary), per device, in process memory. At the per-device cap new
 * requests are refused until entries age out; nothing is evicted early.
 */
export class ReplayGuard {
  private seen = new Map<string, Map<string, number>>();
  constructor(private readonly now: () => number = Date.now) {}

  /**
   * `sendRoute`: the last entries are kept for send routes (media spec §4.10), so an emergency
   * stop is never refused because a large upload filled the guard. The bound stays 2,000.
   */
  admit(deviceId: string, canonical: string, sendRoute = false): 'ok' | 'replay' | 'full' {
    const t = this.now();
    let m = this.seen.get(deviceId);
    if (!m) { m = new Map(); this.seen.set(deviceId, m); }
    for (const [k, at] of m) { if (t - at > REPLAY_TTL_MS) m.delete(k); else break; }
    const key = crypto.createHash('sha256').update(canonical).digest('hex');
    if (m.has(key)) return 'replay';
    if (m.size >= (sendRoute ? MAX_REPLAY_PER_DEVICE : MAX_REPLAY_PER_DEVICE - REPLAY_SEND_RESERVE)) return 'full';
    m.set(key, t);
    return 'ok';
  }
}

/**
 * Verify a device-signed request. `lookup` returns the device's public key, its paired host and
 * its status; `allowStatuses` says which statuses this route accepts (active only, except the
 * device's own status route and self-revoke).
 */
export function verifyDeviceRequest(
  parts: SignedRequestParts,
  lookup: (deviceId: string) => { publicKey: string; host: string; status: DeviceStatus } | null,
  allowStatuses: ReadonlySet<DeviceStatus>,
  replay: ReplayGuard,
  now: number = Date.now(),
  sendRoute = false,
): VerifyResult {
  const { deviceId, time, sig } = parts;
  if (typeof deviceId !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(deviceId) || typeof time !== 'string' || !/^\d{10,16}$/.test(time) || typeof sig !== 'string') {
    return { ok: false, reason: 'malformed' };
  }
  const sigBytes = b64url(sig);
  if (!sigBytes) return { ok: false, reason: 'malformed' };
  const dev = lookup(deviceId);
  if (!dev) return { ok: false, reason: 'unknown-device' };
  if (!allowStatuses.has(dev.status)) return { ok: false, reason: 'not-allowed-status' };
  if (Math.abs(now - Number(time)) > DEVICE_TIME_WINDOW_MS) return { ok: false, reason: 'stale' };
  const key = parseDevicePublicKey(dev.publicKey);
  if (!key) return { ok: false, reason: 'bad-signature' };
  if (!isStrictLowSDer(sigBytes)) return { ok: false, reason: 'bad-signature' };
  const message = canonicalString(deviceId, parts.host ?? dev.host, parts.method, parts.pathWithQuery, time, parts.rawBody);
  let valid = false;
  try { valid = crypto.verify('sha256', Buffer.from(message), { key, dsaEncoding: 'der' }, sigBytes); } catch { valid = false; } // @silent-fallback-ok — a malformed DER signature is simply invalid
  if (!valid) return { ok: false, reason: 'bad-signature' };
  const r = replay.admit(deviceId, message, sendRoute);
  if (r === 'replay') return { ok: false, reason: 'replay' };
  if (r === 'full') return { ok: false, reason: 'rate-limited' };
  return { ok: true, deviceId };
}

// ── Device registry (.instar/state/mobile-devices.json) ─────────────────────────────

export const PENDING_TTL_MS = 30 * 60_000; // was 15 min (mobile-pairing-tailscale-origin §3.4)
export const MAX_PENDING = 10;
export const MAX_WRONG_PER_DEVICE = 3;
export const WRONG_BUDGET = 10;
export const WRONG_BUDGET_WINDOW_MS = 24 * 60 * 60_000;
const TERMINAL_KEEP_MS = 24 * 60 * 60_000;
const MAX_TOMBSTONES = 200;

/** Which proof approved a phone: the owner's private chat, a dashboard PIN session, or an owner phone's Face ID. */
export type ApprovedVia = 'telegram-dm' | 'dashboard-pin' | 'owner-phone' | 'owner-agent';

export interface DeviceRecord {
  id: string;
  deviceName: string | null;
  label: string | null;
  pairedAt: string;
  status: DeviceStatus | 'legacy-token';
  publicKey?: string;
  fingerprint?: string;
  host?: string;
  expiresAt?: string;
  approvedAt?: string;
  /** How the owner approved this key (mobile-native-conversations §4.4, mobile-pairing-approve §3.1); absent ⇒ telegram-dm. */
  approvedVia?: ApprovedVia;
  /** The owner phone whose Face ID approved this key (mobile-pairing-approve §3.1). */
  approvedBy?: string;
  declinedAt?: string;
  revokedAt?: string;
  /** HMACs of distinct wrong codes already tried (per-process key; cleared on activation). */
  wrongCodes?: string[];
  /** Mobile push (docs/specs/mobile-push.md): APNs or FCM token, its provider (absent ⇒ `apns`,
   *  mobile-android-app §2.3), the APNs environment (APNs only), the notification read token's
   *  SHA-256, the highest registration revision applied, and the stored version. */
  pushToken?: string;
  pushProvider?: 'apns' | 'fcm';
  pushEnvironment?: 'sandbox' | 'production';
  notifyTokenHash?: string;
  pushRevision?: number;
  pushVersion?: number;
  pushUpdatedAt?: string;
  /**
   * The person this phone belongs to (docs/specs/mobile-app-people-and-roles.md): a `UserProfile.id`
   * from the agent's user registry, and this phone's role with the agent. Absent ⇒ the owner's phone
   * (every phone paired before people and roles was approved by the owner alone as the owner's).
   */
  userId?: string;
  role?: 'owner' | 'msp' | 'team';
  /**
   * The phone's presence key (docs/specs/mobile-console-device-signin.md §3.1): a second Secure
   * Enclave P-256 public key that signs only after the device owner authenticates. Set once.
   */
  presenceKey?: string;
  /**
   * Browser devices (docs/specs/dashboard-conversations-browser-device.md §4.1). `client: 'browser'`
   * marks a browser; absent means a phone. A browser's key is `browserPublicKey` and `publicKey` is
   * never set on it, so an older version (which reads only `publicKey`) cannot authenticate it.
   */
  client?: 'browser';
  browserPublicKey?: string;
  enrollmentId?: string;
  /** `notifying` while the approval message is being sent, then `awaiting` (§4.2 step 9). */
  setupState?: 'notifying' | 'awaiting';
  notifyingSince?: string;
  /** The activation intent (§4.2 step 10.1), present from approval until the record is active. */
  activating?: BrowserActivationIntent;
  /** The record this browser retires once active. */
  replaces?: { deviceId: string; keyHash: string };
  /** Activation effects still to complete; never dropped (§4.2 step 10). */
  effects?: BrowserEffect[];
  /** Last accepted signed request on this machine, written at most once a minute. */
  lastSeenAt?: string;
}

export type BrowserEffectKind = 'revokeReplaced' | 'notice';
export interface BrowserEffect {
  kind: BrowserEffectKind;
  attempts: number;
  nextAt: string;
  /** Set when the 24-attempt report was made. */
  reportedAt?: string;
  /** Set when the notice's one-time local-attention + push fallback was raised. */
  fallbackRaisedAt?: string;
}
export interface BrowserActivationIntent {
  approvedVia: ApprovedVia;
  at: string;
  approvedBy?: string;
  effects: BrowserEffectKind[];
}

/** The key a device signs with: a phone's `publicKey`, or a browser's `browserPublicKey`. */
export function deviceKeyOf(d: Pick<DeviceRecord, 'client' | 'publicKey' | 'browserPublicKey'> | null | undefined): string | undefined {
  if (!d) return undefined;
  return d.client === 'browser' ? d.browserPublicKey : d.publicKey;
}

/** sha256 hex over the raw key bytes — the same as `deviceKeyHashOf` in AppRecordSignatures. */
export function keyHashOf(publicKeyB64url: string): string {
  return crypto.createHash('sha256').update(Buffer.from(publicKeyB64url, 'base64url')).digest('hex');
}

export function isBrowserDevice(d: Pick<DeviceRecord, 'client'> | null | undefined): boolean {
  return !!d && d.client === 'browser';
}

/** Every key field a record holds, for duplicate-key checks across phones and browsers. */
function keysOf(d: DeviceRecord): string[] {
  return [d.publicKey, d.browserPublicKey, d.presenceKey].filter((k): k is string => typeof k === 'string' && k.length > 0);
}

export const BROWSER_NOTIFYING_STUCK_MS = 30_000;
export const BROWSER_SETUP_WINDOW_MS = 60 * 60_000;
const BROWSER_SETUP_KEEP_MS = 24 * 60 * 60_000;

/** One browser setup that reached record creation (§4.2 step 6): the hourly count and the one-record-per-session rule. */
export interface BrowserSetupEntry { deviceId: string; at: number; session: string; returned?: boolean }

export type CreatePendingBrowserResult =
  | { ok: true; device: DeviceRecord }
  | { ok: false; reason: 'pairing-paused' | 'duplicate-key' | 'session-used' }
  | { ok: false; reason: 'too-many-browsers'; browsers: DeviceRecord[] }
  | { ok: false; reason: 'too-many-setups'; nextAt: number };

export interface PushRegistration {
  token: string | null;
  /** Absent ⇒ `apns` (mobile-android-app §2.3). */
  provider?: 'apns' | 'fcm';
  environment?: 'sandbox' | 'production';
  notifyTokenHash?: string;
  revision: number;
}

export type PushRegisterResult =
  | { ok: true; revision: number; version: number }
  | { ok: false; reason: 'not-active' | 'stale-revision' | 'revision-conflict' };

function samePush(d: DeviceRecord, r: PushRegistration): boolean {
  if (r.token === null) return !d.pushToken;
  // A provider change, even with the same token string, is a change (mobile-android-app §2.3).
  return d.pushToken === r.token && (d.pushProvider ?? 'apns') === (r.provider ?? 'apns')
    && d.pushEnvironment === r.environment && d.notifyTokenHash === r.notifyTokenHash;
}

interface RegistryFile { devices: DeviceRecord[]; wrongCodeTimes?: number[]; browserSetups?: BrowserSetupEntry[] }

export class DeviceRegistry {
  readonly file: string;
  constructor(stateDir: string, private readonly now: () => number = Date.now) {
    this.file = path.join(stateDir, 'state', 'mobile-devices.json');
  }

  private read(): RegistryFile {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as Partial<RegistryFile>;
      const devices = Array.isArray(raw.devices) ? raw.devices.filter((d): d is DeviceRecord => !!d && typeof d === 'object' && typeof (d as DeviceRecord).id === 'string') : [];
      // Rows written by the token-era pairing log carry no key: they are legacy token pairings.
      for (const d of devices) if (!d.status) d.status = 'legacy-token';
      const browserSetups = Array.isArray(raw.browserSetups)
        ? raw.browserSetups.filter((e): e is BrowserSetupEntry => !!e && typeof e === 'object' && typeof (e as BrowserSetupEntry).deviceId === 'string' && typeof (e as BrowserSetupEntry).at === 'number' && typeof (e as BrowserSetupEntry).session === 'string')
        : [];
      return { devices, wrongCodeTimes: Array.isArray(raw.wrongCodeTimes) ? raw.wrongCodeTimes.filter((n) => typeof n === 'number') : [], ...(browserSetups.length ? { browserSetups } : {}) };
    } catch {
      // @silent-fallback-ok — a missing registry is an empty one; a corrupt one is reported by the caller's write
      return { devices: [], wrongCodeTimes: [] };
    }
  }

  private write(f: RegistryFile): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(f, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  /** Expire stale pending rows and prune old terminal rows; never removes an active device. */
  private normalize(f: RegistryFile): RegistryFile {
    const t = this.now();
    for (const d of f.devices) {
      // A browser record carrying an activation intent is never expired (§4.1): recovery decides it.
      if (d.status === 'pending' && !d.activating && d.expiresAt && Date.parse(d.expiresAt) <= t) d.status = 'expired';
    }
    f.devices = f.devices.filter((d) => {
      if ((d.status === 'expired' || d.status === 'declined') && !d.activating && !(d.effects && d.effects.length)) {
        const at = Date.parse(d.declinedAt ?? d.expiresAt ?? d.pairedAt);
        return t - at < TERMINAL_KEEP_MS;
      }
      return true;
    });
    // Revoked records with unfinished effects are never pruned (§4.1).
    const revoked = f.devices.filter((d) => d.status === 'revoked' && !(d.effects && d.effects.length));
    if (revoked.length > MAX_TOMBSTONES) {
      const drop = new Set(revoked.sort((a, b) => String(a.revokedAt).localeCompare(String(b.revokedAt))).slice(0, revoked.length - MAX_TOMBSTONES).map((d) => d.id));
      f.devices = f.devices.filter((d) => !drop.has(d.id));
    }
    f.wrongCodeTimes = (f.wrongCodeTimes ?? []).filter((w) => t - w < WRONG_BUDGET_WINDOW_MS);
    if (f.browserSetups) {
      f.browserSetups = f.browserSetups.filter((e) => t - e.at < BROWSER_SETUP_KEEP_MS);
      if (!f.browserSetups.length) delete f.browserSetups;
    }
    return f;
  }

  list(): DeviceRecord[] { return this.normalize(this.read()).devices; }
  get(id: string): DeviceRecord | null { return this.list().find((d) => d.id === id) ?? null; }

  pairingPaused(): boolean { return (this.normalize(this.read()).wrongCodeTimes ?? []).length >= WRONG_BUDGET; }

  /** Adds a pending device. Refuses a duplicate key, too many pending, or a paused budget. */
  createPending(row: { deviceName: string | null; label: string | null; publicKey: string; host: string; userId?: string | null; role?: 'owner' | 'msp' | 'team' }):
    { ok: true; device: DeviceRecord } | { ok: false; reason: 'duplicate-key' | 'too-many-pending' | 'pairing-paused' } {
    const f = this.normalize(this.read());
    if ((f.wrongCodeTimes ?? []).length >= WRONG_BUDGET) return { ok: false, reason: 'pairing-paused' };
    if (f.devices.some((d) => keysOf(d).includes(row.publicKey))) return { ok: false, reason: 'duplicate-key' };
    // Pending browsers do not count toward the phones' MAX_PENDING (§4.2 step 6).
    if (f.devices.filter((d) => d.status === 'pending' && !isBrowserDevice(d)).length >= MAX_PENDING) return { ok: false, reason: 'too-many-pending' };
    const t = this.now();
    const device: DeviceRecord = {
      id: crypto.randomUUID(), deviceName: row.deviceName, label: row.label, pairedAt: new Date(t).toISOString(),
      status: 'pending', publicKey: row.publicKey, fingerprint: deviceFingerprint(row.publicKey), host: row.host,
      expiresAt: new Date(t + PENDING_TTL_MS).toISOString(), wrongCodes: [],
      ...(row.userId ? { userId: row.userId } : {}),
      // Only a non-owner role is written: absent already means owner, so an owner phone's record
      // stays byte-identical to the shape older builds read.
      ...(row.role && row.role !== 'owner' ? { role: row.role } : {}),
    };
    f.devices.unshift(device);
    this.write(f);
    return { ok: true, device };
  }

  /**
   * Assign a phone to a person (people and roles §3.2). Owner with no userId clears both fields
   * (the absent-means-owner shape). Returns null when this machine holds no such device; a revoked
   * device is never reassigned.
   */
  setPerson(id: string, person: { userId: string | null; role: 'owner' | 'msp' | 'team' }): DeviceRecord | null {
    const f = this.normalize(this.read());
    const d = f.devices.find((x) => x.id === id);
    if (!d || d.status === 'revoked') return null;
    if (person.userId) d.userId = person.userId; else delete d.userId;
    if (person.role === 'owner') delete d.role; else d.role = person.role;
    this.write(f);
    return d;
  }

  /**
   * Record the phone's presence key once (mobile-console-device-signin §3.1). The same key again is
   * a no-op ('same'); a different key is refused ('conflict'); only an active device may set it.
   */
  setPresenceKey(id: string, publicKey: string): 'set' | 'same' | 'conflict' | 'not-active' {
    const f = this.normalize(this.read());
    const d = f.devices.find((x) => x.id === id);
    if (!d || d.status !== 'active') return 'not-active';
    if (d.presenceKey === publicKey) return 'same';
    if (d.presenceKey) return 'conflict';
    d.presenceKey = publicKey;
    this.write(f);
    return 'set';
  }

  remove(id: string): void {
    const f = this.read();
    f.devices = f.devices.filter((d) => d.id !== id);
    this.write(this.normalize(f));
  }

  /** Records the outcome of a confirmation attempt. `wrongHmac` is set for a wrong code. */
  applyConfirm(id: string, outcome: { ok: true; approvedVia?: ApprovedVia; approvedAt?: string; approvedBy?: string } | { ok: false; wrongHmac: string }): DeviceRecord | null {
    const f = this.normalize(this.read());
    const d = f.devices.find((x) => x.id === id);
    if (!d || d.status !== 'pending') return d ?? null;
    // A browser record that already carries an activation intent was approved: a wrong code is
    // refused without declining it, and activation goes through activateBrowser (§4.1, §4.2 step 10).
    if (d.activating) return d;
    if (outcome.ok && isBrowserDevice(d)) return d;
    if (outcome.ok) {
      d.status = 'active'; d.approvedAt = outcome.approvedAt ?? new Date(this.now()).toISOString(); d.approvedVia = outcome.approvedVia ?? 'telegram-dm';
      if (outcome.approvedBy) d.approvedBy = outcome.approvedBy;
      delete d.wrongCodes; delete d.expiresAt;
    } else {
      d.wrongCodes = d.wrongCodes ?? [];
      if (!d.wrongCodes.includes(outcome.wrongHmac)) {
        d.wrongCodes.push(outcome.wrongHmac);
        (f.wrongCodeTimes = f.wrongCodeTimes ?? []).push(this.now());
      }
      if (d.wrongCodes.length >= MAX_WRONG_PER_DEVICE) { d.status = 'declined'; d.declinedAt = new Date(this.now()).toISOString(); }
    }
    this.write(f);
    return d;
  }

  /**
   * Boot and lease loss: no pending device can be confirmed any more. `except` keeps the named
   * devices pending (a lease move does not expire a dashboard-path device, mobile-native-conversations §4.4).
   */
  expireAllPending(except?: ReadonlySet<string>): void {
    const f = this.normalize(this.read());
    let changed = false;
    for (const d of f.devices) if (d.status === 'pending' && !d.activating && !except?.has(d.id)) { d.status = 'expired'; d.expiresAt = new Date(this.now()).toISOString(); changed = true; }
    if (changed) this.write(f);
  }

  /**
   * Decline a pending device. A record that already carries an activation intent has been approved,
   * so it is left alone and answered 'already-approved' (§4.1: decline never races an approval).
   */
  decline(id: string): 'declined' | 'already-approved' | 'not-pending' {
    const f = this.normalize(this.read());
    const d = f.devices.find((x) => x.id === id);
    if (!d) return 'not-pending';
    if (d.activating || (d.status === 'active')) return 'already-approved';
    if (d.status !== 'pending') return 'not-pending';
    d.status = 'declined'; d.declinedAt = new Date(this.now()).toISOString(); this.write(f);
    return 'declined';
  }

  // ── Browser devices (docs/specs/dashboard-conversations-browser-device.md §4.1, §4.2) ──────

  /** A browser record on this host with this key, for the retry check of §4.2 step 4. */
  findBrowserByKey(publicKey: string): DeviceRecord | null {
    return this.list().find((d) => isBrowserDevice(d) && d.browserPublicKey === publicKey) ?? null;
  }

  /** Whether any record on this machine holds this key in any key field. */
  holdsKey(publicKey: string): boolean {
    return this.list().some((d) => keysOf(d).includes(publicKey));
  }

  /** Setups counted in the last hour, and the time the next one is allowed. */
  browserSetupWindow(): { count: number; nextAt: number | null } {
    const f = this.normalize(this.read());
    const t = this.now();
    const live = (f.browserSetups ?? []).filter((e) => !e.returned && t - e.at < BROWSER_SETUP_WINDOW_MS).sort((a, b) => a.at - b.at);
    return { count: live.length, nextAt: live.length ? live[0]!.at + BROWSER_SETUP_WINDOW_MS : null };
  }

  /**
   * Create a pending browser record (§4.2 steps 5, 6 and 8 in one synchronous read-modify-write):
   * the operator session must not have created a record already, this machine's browsers must be
   * below `maxBrowsers` (not counting the record `replaces` names), and fewer than
   * `maxSetupsPerHour` setups were created in the last hour. The setup entry is written with the
   * record, so concurrent setups cannot share the last slot or one session.
   */
  createPendingBrowser(row: {
    browserPublicKey: string; host: string; deviceName: string; enrollmentId: string;
    replaces?: { deviceId: string; keyHash: string } | null; session: string;
    maxBrowsers: number; maxSetupsPerHour: number; ledgerRevokedKeyHashes?: ReadonlySet<string>;
  }): CreatePendingBrowserResult {
    const f = this.normalize(this.read());
    const t = this.now();
    if ((f.wrongCodeTimes ?? []).length >= WRONG_BUDGET) return { ok: false, reason: 'pairing-paused' };
    if (f.devices.some((d) => keysOf(d).includes(row.browserPublicKey))) return { ok: false, reason: 'duplicate-key' };
    const setups = f.browserSetups ?? [];
    if (setups.some((e) => e.session === row.session)) return { ok: false, reason: 'session-used' };
    const counted = f.devices.filter((d) => isBrowserDevice(d) && (d.status === 'pending' || d.status === 'active')
      && d.id !== row.replaces?.deviceId
      && !(row.ledgerRevokedKeyHashes && d.browserPublicKey && row.ledgerRevokedKeyHashes.has(keyHashOf(d.browserPublicKey))));
    if (counted.length >= row.maxBrowsers) return { ok: false, reason: 'too-many-browsers', browsers: counted };
    const live = setups.filter((e) => !e.returned && t - e.at < BROWSER_SETUP_WINDOW_MS).sort((a, b) => a.at - b.at);
    if (live.length >= row.maxSetupsPerHour) return { ok: false, reason: 'too-many-setups', nextAt: live[live.length - row.maxSetupsPerHour]!.at + BROWSER_SETUP_WINDOW_MS };
    const id = crypto.randomUUID();
    const device: DeviceRecord = {
      id, deviceName: row.deviceName, label: null, pairedAt: new Date(t).toISOString(),
      status: 'pending', client: 'browser', browserPublicKey: row.browserPublicKey,
      fingerprint: deviceFingerprint(row.browserPublicKey), host: row.host, enrollmentId: row.enrollmentId,
      setupState: 'notifying', notifyingSince: new Date(t).toISOString(),
      expiresAt: new Date(t + PENDING_TTL_MS).toISOString(), wrongCodes: [],
      ...(row.replaces ? { replaces: { deviceId: row.replaces.deviceId, keyHash: row.replaces.keyHash } } : {}),
    };
    f.devices.unshift(device);
    f.browserSetups = [...setups, { deviceId: id, at: t, session: row.session }];
    this.write(f);
    return { ok: true, device };
  }

  /** Move a browser's setup state; `onlyIf` is the state it must be in now. */
  setSetupState(id: string, state: 'notifying' | 'awaiting', onlyIf: 'notifying' | 'awaiting'): boolean {
    const f = this.normalize(this.read());
    const d = f.devices.find((x) => x.id === id);
    if (!d || !isBrowserDevice(d) || d.status !== 'pending' || d.setupState !== onlyIf || d.activating) return false;
    d.setupState = state;
    if (state === 'awaiting') delete d.notifyingSince; else d.notifyingSince = new Date(this.now()).toISOString();
    this.write(f);
    return true;
  }

  /**
   * Record the activation intent (§4.2 step 10.1). Writes only to a browser record that is still
   * pending, not declined, carries no intent yet, and is `awaiting` — or, on the dashboard path,
   * is the record this same request created (`ownRequest`). Returns false and writes nothing otherwise.
   */
  setActivating(id: string, intent: BrowserActivationIntent, opts: { ownRequest?: boolean } = {}): boolean {
    const f = this.normalize(this.read());
    const d = f.devices.find((x) => x.id === id);
    if (!d || !isBrowserDevice(d) || d.status !== 'pending' || d.activating || d.declinedAt) return false;
    if (d.setupState !== 'awaiting' && !opts.ownRequest) return false;
    d.activating = { approvedVia: intent.approvedVia, at: intent.at, effects: [...intent.effects], ...(intent.approvedBy ? { approvedBy: intent.approvedBy } : {}) };
    this.write(f);
    return true;
  }

  /**
   * Make a browser active (§4.2 step 10.3) from a record carrying an intent — pending, or expired
   * (only when an older version expired it in between) — never declined. Clears the intent and the
   * setup state and writes the effects, in one write.
   */
  activateBrowser(id: string): DeviceRecord | null {
    const f = this.normalize(this.read());
    const d = f.devices.find((x) => x.id === id);
    if (!d || !isBrowserDevice(d) || !d.activating) return null;
    if (d.status !== 'pending' && d.status !== 'expired') return null;
    const intent = d.activating;
    const t = this.now();
    d.status = 'active'; d.approvedAt = intent.at; d.approvedVia = intent.approvedVia;
    if (intent.approvedBy) d.approvedBy = intent.approvedBy;
    const effects: BrowserEffect[] = intent.effects.map((kind) => ({ kind, attempts: 0, nextAt: new Date(t).toISOString() }));
    if (effects.length) d.effects = effects; else delete d.effects;
    delete d.activating; delete d.setupState; delete d.notifyingSince; delete d.wrongCodes; delete d.expiresAt;
    this.write(f);
    return d;
  }

  /** An intent whose ledger row was never written: the approval did not complete (§4.2 step 10 recovery). */
  abandonActivation(id: string): boolean {
    const f = this.normalize(this.read());
    const d = f.devices.find((x) => x.id === id);
    if (!d || !d.activating || d.status === 'active' || d.status === 'revoked') return false;
    delete d.activating; delete d.setupState; delete d.notifyingSince;
    d.status = 'expired'; d.expiresAt = new Date(this.now()).toISOString();
    this.write(f);
    return true;
  }

  /** Replace a record's effects (an empty list removes the field). */
  setEffects(id: string, effects: BrowserEffect[]): boolean {
    const f = this.normalize(this.read());
    const d = f.devices.find((x) => x.id === id);
    if (!d) return false;
    if (effects.length) d.effects = effects; else delete d.effects;
    this.write(f);
    return true;
  }

  /** Write `lastSeenAt` at most once a minute; decided from the value just read. */
  touch(id: string, at: number = this.now()): boolean {
    const f = this.read();
    const d = f.devices.find((x) => x.id === id);
    if (!d || d.status !== 'active') return false;
    if (d.lastSeenAt && at - Date.parse(d.lastSeenAt) < 60_000) return false;
    d.lastSeenAt = new Date(at).toISOString();
    this.write(f);
    return true;
  }

  /**
   * Remove a browser setup that never reached approval: only a record still pending, still
   * `notifying` and with no intent. Its setup entry is marked returned in the same write, so the
   * hourly slot comes back; the session stays used.
   */
  removeIfStillSettingUp(id: string): boolean {
    const f = this.normalize(this.read());
    const d = f.devices.find((x) => x.id === id);
    if (!d || !isBrowserDevice(d) || d.status !== 'pending' || d.setupState !== 'notifying' || d.activating) return false;
    f.devices = f.devices.filter((x) => x.id !== id);
    for (const e of f.browserSetups ?? []) if (e.deviceId === id) e.returned = true;
    this.write(f);
    return true;
  }

  /** Browser records stuck in `notifying` longer than `olderThanMs` (all of them at start-up, with 0). */
  stuckNotifying(olderThanMs: number = BROWSER_NOTIFYING_STUCK_MS): DeviceRecord[] {
    const t = this.now();
    return this.list().filter((d) => isBrowserDevice(d) && d.status === 'pending' && d.setupState === 'notifying' && !d.activating
      && t - Date.parse(d.notifyingSince ?? d.pairedAt) >= olderThanMs);
  }

  /** Browser records with work left: an intent or unfinished effects (§4.2 step 10 recovery). */
  browserWork(): DeviceRecord[] {
    return this.list().filter((d) => isBrowserDevice(d) && (!!d.activating || !!(d.effects && d.effects.length)));
  }

  /**
   * Terminal; always allowed. Returns false when this machine holds no such device. `at` is the
   * revocation time already recorded in the device-key ledger (written first), when there is one.
   */
  revoke(id: string, at?: string): boolean {
    const f = this.normalize(this.read());
    const d = f.devices.find((x) => x.id === id);
    if (!d) return false;
    // A revoked record can never be activated: its activation intent goes with it (second-pass review).
    if (d.status !== 'revoked') { d.status = 'revoked'; d.revokedAt = at ?? new Date(this.now()).toISOString(); delete d.activating; clearPush(d); this.write(f); }
    return true;
  }

  /**
   * Register or clear this device's push token (mobile-push §2.2). A lower revision is refused;
   * the same revision is accepted only with the same body (a retry). A token is held by at most
   * one record on this machine.
   */
  setPush(id: string, r: PushRegistration): PushRegisterResult {
    const f = this.normalize(this.read());
    const d = f.devices.find((x) => x.id === id);
    if (!d || d.status !== 'active') return { ok: false, reason: 'not-active' };
    const prev = d.pushRevision ?? 0;
    if (r.revision < prev) return { ok: false, reason: 'stale-revision' };
    if (r.revision === prev) {
      return samePush(d, r) ? { ok: true, revision: prev, version: d.pushVersion ?? 0 } : { ok: false, reason: 'revision-conflict' };
    }
    const changed = !samePush(d, r);
    d.pushRevision = r.revision;
    if (changed) {
      if (r.token === null) clearPush(d);
      else {
        for (const other of f.devices) if (other.id !== d.id && other.pushToken === r.token) { clearPush(other); other.pushVersion = (other.pushVersion ?? 0) + 1; }
        d.pushToken = r.token; d.notifyTokenHash = r.notifyTokenHash;
        d.pushProvider = r.provider ?? 'apns';
        // An FCM token carries no environment; one left from an APNs registration goes.
        if (d.pushProvider === 'fcm') delete d.pushEnvironment; else d.pushEnvironment = r.environment;
        d.pushUpdatedAt = new Date(this.now()).toISOString();
      }
      d.pushVersion = (d.pushVersion ?? 0) + 1;
    }
    this.write(f);
    return { ok: true, revision: r.revision, version: d.pushVersion ?? 0 };
  }

  /** An APNs answer that retires a token clears it only if the record still holds that version. */
  clearPushIfVersion(id: string, version: number): boolean {
    const f = this.normalize(this.read());
    const d = f.devices.find((x) => x.id === id);
    if (!d || !d.pushToken || (d.pushVersion ?? 0) !== version) return false;
    clearPush(d);
    d.pushVersion = version + 1;
    this.write(f);
    return true;
  }
}

function clearPush(d: DeviceRecord): void {
  delete d.pushToken; delete d.pushProvider; delete d.pushEnvironment; delete d.notifyTokenHash;
  d.pushUpdatedAt = new Date().toISOString();
}

// ── Confirmation codes (process memory only) ────────────────────────────────────────

const CODE_KEY = crypto.randomBytes(32);
export function codeHmac(code: string): string {
  return crypto.createHmac('sha256', CODE_KEY).update(code).digest('hex');
}

export type CodeFormat = 'digits' | 'word';

/**
 * mobile-pairing-word-code §3.3 — the one word-code form, shared by check() (anchored) and the
 * leak scan (unanchored): 4–6 ASCII letters, at most 3 separators, 4 ASCII digits. Separators are
 * whitespace, - – — _ : and . (no Unicode letter matching: e.g. the Kelvin sign is not a K).
 */
export const WORD_CODE_SEP = '[\\s\\-\\u2013\\u2014_:.]';
export const WORD_CODE_FRAGMENT = `([A-Za-z]{4,6})${WORD_CODE_SEP}{0,3}([0-9]{4})`;
const WORD_CODE_ANCHORED = new RegExp(`^\\s*${WORD_CODE_FRAGMENT}\\s*$`);
const WORD_CODE_SCAN = new RegExp(`(?<![A-Za-z])${WORD_CODE_FRAGMENT}(?![0-9])`, 'g');

/** ASCII-only uppercasing (no locale or Unicode case folding). */
function asciiUpper(s: string): string { return s.replace(/[a-z]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 32)); }

/** `KITE4172` for a word-code form, null for anything else (a PIN, digits, spaced letters, non-string). */
export function parseWordCode(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const m = WORD_CODE_ANCHORED.exec(input);
  return m ? asciiUpper(m[1]!) + m[2]! : null;
}

/** Display form: `KITE-4172` for a word code, `NNN NNN` for a digit code. */
export function displayCode(code: string): string {
  const m = /^([A-Z]{4,6})(\d{4})$/.exec(code);
  if (m) return `${m[1]}-${m[2]}`;
  return /^\d{6}$/.test(code) ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

/** Live codes per pending device, in memory: a restart voids them all. */
export class ConfirmationCodes {
  private codes = new Map<string, { hmac: string; expiresAt: number; format: CodeFormat }>();
  constructor(private readonly now: () => number = Date.now) {}

  /** Returns the code in its normalized form (`KITE4172` or `123456`); format it with displayCode(). */
  issue(deviceId: string, expiresAt: number, format: CodeFormat = 'digits'): string {
    const code = format === 'word'
      ? PAIRING_WORDS[crypto.randomInt(0, PAIRING_WORDS.length)]! + String(crypto.randomInt(0, 10_000)).padStart(4, '0')
      : String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    this.codes.set(deviceId, { hmac: codeHmac(code), expiresAt, format });
    return code;
  }

  formatOf(deviceId: string): CodeFormat | null { return this.codes.get(deviceId)?.format ?? null; }

  /**
   * 'ok' | 'wrong' (with its hmac) | 'wrong-format' (a word device given something that is not a
   * word-code form: no HMAC, no strike) | 'none' (no live code for this device).
   */
  check(deviceId: string, code: unknown): { result: 'ok' } | { result: 'wrong'; hmac: string } | { result: 'wrong-format' } | { result: 'none' } {
    const e = this.codes.get(deviceId);
    if (!e || e.expiresAt <= this.now()) return { result: 'none' };
    let normalized: string;
    if (e.format === 'word') {
      const parsed = parseWordCode(code);
      if (parsed === null) return { result: 'wrong-format' };
      normalized = parsed;
    } else {
      // Digits device: today's rule exactly.
      normalized = typeof code === 'string' ? code.replace(/\D/g, '') : '';
    }
    const h = codeHmac(normalized);
    // Compare only: the caller consumes the code (drop) after the activation is written.
    if ((e.format === 'word' || normalized.length === 6) && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(e.hmac))) return { result: 'ok' };
    return { result: 'wrong', hmac: h };
  }

  drop(deviceId: string): void { this.codes.delete(deviceId); }

  /** Lease loss: no code issued before it may confirm anything (`except`: dashboard-path devices keep theirs). */
  clearAll(except?: ReadonlySet<string>): void {
    if (!except?.size) { this.codes.clear(); return; }
    for (const id of [...this.codes.keys()]) if (!except.has(id)) this.codes.delete(id);
  }

  /** Forget codes past their expiry (bounded memory). */
  prune(): void { const t = this.now(); for (const [id, e] of this.codes) if (e.expiresAt <= t) this.codes.delete(id); }

  /** Device ids whose live code appears in `text` (6 digits, spaced or not). */
  leakedIn(text: string): string[] {
    if (!this.codes.size) return [];
    const t = this.now();
    const candidates = new Set<string>();
    for (const m of text.matchAll(/(?<!\d)(\d{3})[\s-]?(\d{3})(?!\d)/g)) candidates.add(m[1]! + m[2]!);
    // Word codes (mobile-pairing-word-code §3.5): the same form check() accepts, only listed words,
    // de-duplicated; no cap, so nothing in a message can push a real code out of the scan.
    for (const m of text.matchAll(WORD_CODE_SCAN)) {
      const word = asciiUpper(m[1]!);
      if (PAIRING_WORD_SET.has(word)) candidates.add(word + m[2]!);
    }
    const hits: string[] = [];
    for (const c of candidates) {
      const h = codeHmac(c);
      for (const [id, e] of this.codes) if (e.expiresAt > t && e.hmac === h) hits.push(id);
    }
    return hits;
  }
}
