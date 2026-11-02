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

export const DEVICE_SIG_VERSION = 'instar-device-v1';
export const DEVICE_TIME_WINDOW_MS = 60_000;
export const REPLAY_TTL_MS = 3 * 60_000;
export const MAX_REPLAY_PER_DEVICE = 2_000;

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

  admit(deviceId: string, canonical: string): 'ok' | 'replay' | 'full' {
    const t = this.now();
    let m = this.seen.get(deviceId);
    if (!m) { m = new Map(); this.seen.set(deviceId, m); }
    for (const [k, at] of m) { if (t - at > REPLAY_TTL_MS) m.delete(k); else break; }
    const key = crypto.createHash('sha256').update(canonical).digest('hex');
    if (m.has(key)) return 'replay';
    if (m.size >= MAX_REPLAY_PER_DEVICE) return 'full';
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
  const r = replay.admit(deviceId, message);
  if (r === 'replay') return { ok: false, reason: 'replay' };
  if (r === 'full') return { ok: false, reason: 'rate-limited' };
  return { ok: true, deviceId };
}

// ── Device registry (.instar/state/mobile-devices.json) ─────────────────────────────

export const PENDING_TTL_MS = 15 * 60_000;
export const MAX_PENDING = 10;
export const MAX_WRONG_PER_DEVICE = 3;
export const WRONG_BUDGET = 10;
export const WRONG_BUDGET_WINDOW_MS = 24 * 60 * 60_000;
const TERMINAL_KEEP_MS = 24 * 60 * 60_000;
const MAX_TOMBSTONES = 200;

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
  declinedAt?: string;
  revokedAt?: string;
  /** HMACs of distinct wrong codes already tried (per-process key; cleared on activation). */
  wrongCodes?: string[];
}

interface RegistryFile { devices: DeviceRecord[]; wrongCodeTimes?: number[] }

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
      return { devices, wrongCodeTimes: Array.isArray(raw.wrongCodeTimes) ? raw.wrongCodeTimes.filter((n) => typeof n === 'number') : [] };
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
      if (d.status === 'pending' && d.expiresAt && Date.parse(d.expiresAt) <= t) d.status = 'expired';
    }
    f.devices = f.devices.filter((d) => {
      if (d.status === 'expired' || d.status === 'declined') {
        const at = Date.parse(d.declinedAt ?? d.expiresAt ?? d.pairedAt);
        return t - at < TERMINAL_KEEP_MS;
      }
      return true;
    });
    const revoked = f.devices.filter((d) => d.status === 'revoked');
    if (revoked.length > MAX_TOMBSTONES) {
      const drop = new Set(revoked.sort((a, b) => String(a.revokedAt).localeCompare(String(b.revokedAt))).slice(0, revoked.length - MAX_TOMBSTONES).map((d) => d.id));
      f.devices = f.devices.filter((d) => !drop.has(d.id));
    }
    f.wrongCodeTimes = (f.wrongCodeTimes ?? []).filter((w) => t - w < WRONG_BUDGET_WINDOW_MS);
    return f;
  }

  list(): DeviceRecord[] { return this.normalize(this.read()).devices; }
  get(id: string): DeviceRecord | null { return this.list().find((d) => d.id === id) ?? null; }

  pairingPaused(): boolean { return (this.normalize(this.read()).wrongCodeTimes ?? []).length >= WRONG_BUDGET; }

  /** Adds a pending device. Refuses a duplicate key, too many pending, or a paused budget. */
  createPending(row: { deviceName: string | null; label: string | null; publicKey: string; host: string }):
    { ok: true; device: DeviceRecord } | { ok: false; reason: 'duplicate-key' | 'too-many-pending' | 'pairing-paused' } {
    const f = this.normalize(this.read());
    if ((f.wrongCodeTimes ?? []).length >= WRONG_BUDGET) return { ok: false, reason: 'pairing-paused' };
    if (f.devices.some((d) => d.publicKey === row.publicKey)) return { ok: false, reason: 'duplicate-key' };
    if (f.devices.filter((d) => d.status === 'pending').length >= MAX_PENDING) return { ok: false, reason: 'too-many-pending' };
    const t = this.now();
    const device: DeviceRecord = {
      id: crypto.randomUUID(), deviceName: row.deviceName, label: row.label, pairedAt: new Date(t).toISOString(),
      status: 'pending', publicKey: row.publicKey, fingerprint: deviceFingerprint(row.publicKey), host: row.host,
      expiresAt: new Date(t + PENDING_TTL_MS).toISOString(), wrongCodes: [],
    };
    f.devices.unshift(device);
    this.write(f);
    return { ok: true, device };
  }

  remove(id: string): void {
    const f = this.read();
    f.devices = f.devices.filter((d) => d.id !== id);
    this.write(this.normalize(f));
  }

  /** Records the outcome of a confirmation attempt. `wrongHmac` is set for a wrong code. */
  applyConfirm(id: string, outcome: { ok: true } | { ok: false; wrongHmac: string }): DeviceRecord | null {
    const f = this.normalize(this.read());
    const d = f.devices.find((x) => x.id === id);
    if (!d || d.status !== 'pending') return d ?? null;
    if (outcome.ok) {
      d.status = 'active'; d.approvedAt = new Date(this.now()).toISOString(); delete d.wrongCodes; delete d.expiresAt;
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

  /** Boot and lease loss: no pending device can be confirmed any more. */
  expireAllPending(): void {
    const f = this.normalize(this.read());
    let changed = false;
    for (const d of f.devices) if (d.status === 'pending') { d.status = 'expired'; d.expiresAt = new Date(this.now()).toISOString(); changed = true; }
    if (changed) this.write(f);
  }

  decline(id: string): void {
    const f = this.normalize(this.read());
    const d = f.devices.find((x) => x.id === id);
    if (d && d.status === 'pending') { d.status = 'declined'; d.declinedAt = new Date(this.now()).toISOString(); this.write(f); }
  }

  /** Terminal; always allowed. Returns false when this machine holds no such device. */
  revoke(id: string): boolean {
    const f = this.normalize(this.read());
    const d = f.devices.find((x) => x.id === id);
    if (!d) return false;
    if (d.status !== 'revoked') { d.status = 'revoked'; d.revokedAt = new Date(this.now()).toISOString(); this.write(f); }
    return true;
  }
}

// ── Confirmation codes (process memory only) ────────────────────────────────────────

const CODE_KEY = crypto.randomBytes(32);
export function codeHmac(code: string): string {
  return crypto.createHmac('sha256', CODE_KEY).update(code).digest('hex');
}

/** Live codes per pending device, in memory: a restart voids them all. */
export class ConfirmationCodes {
  private codes = new Map<string, { hmac: string; expiresAt: number }>();
  constructor(private readonly now: () => number = Date.now) {}

  issue(deviceId: string, expiresAt: number): string {
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    this.codes.set(deviceId, { hmac: codeHmac(code), expiresAt });
    return code;
  }

  /** 'ok' | 'wrong' (with its hmac) | 'none' (no live code for this device). */
  check(deviceId: string, code: unknown): { result: 'ok' } | { result: 'wrong'; hmac: string } | { result: 'none' } {
    const e = this.codes.get(deviceId);
    if (!e || e.expiresAt <= this.now()) return { result: 'none' };
    const normalized = typeof code === 'string' ? code.replace(/\D/g, '') : '';
    const h = codeHmac(normalized);
    // Compare only: the caller consumes the code (drop) after the activation is written.
    if (normalized.length === 6 && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(e.hmac))) return { result: 'ok' };
    return { result: 'wrong', hmac: h };
  }

  drop(deviceId: string): void { this.codes.delete(deviceId); }

  /** Lease loss: no code issued before it may confirm anything. */
  clearAll(): void { this.codes.clear(); }

  /** Forget codes past their expiry (bounded memory). */
  prune(): void { const t = this.now(); for (const [id, e] of this.codes) if (e.expiresAt <= t) this.codes.delete(id); }

  /** Device ids whose live code appears in `text` (6 digits, spaced or not). */
  leakedIn(text: string): string[] {
    if (!this.codes.size) return [];
    const t = this.now();
    const candidates = new Set<string>();
    for (const m of text.matchAll(/(?<!\d)(\d{3})[\s-]?(\d{3})(?!\d)/g)) candidates.add(m[1]! + m[2]!);
    const hits: string[] = [];
    for (const c of candidates) {
      const h = codeHmac(c);
      for (const [id, e] of this.codes) if (e.expiresAt > t && e.hmac === h) hits.push(id);
    }
    return hits;
  }
}
