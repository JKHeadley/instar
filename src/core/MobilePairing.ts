/**
 * Mobile pairing links (docs/specs/mobile-pairing-link.md).
 *
 * A pairing code is a single-use, short-lived stand-in for typing the dashboard PIN,
 * for ONE purpose: the Instar iPhone app obtaining the agent's API token. It never
 * yields an operator-session proof (that proof exists precisely because agents can
 * read the API token, and codes are minted with it).
 *
 * This module is pure state: the code store (process memory, SHA-256 hashes only),
 * the mint/failure limiters, the v1 link builder, and the paired-devices log. The
 * HTTP surface lives in src/server/mobilePairingRoutes.ts.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const PAIR_LINK_BASE = 'https://instar.sh/pair';
export const CODE_PATTERN = /^[A-Za-z0-9_-]{22}$/;
export const MAX_LIVE_CODES = 10;
export const MAX_MINTS_PER_HOUR = 10;
export const MAX_FAILED_REDEEMS = 30;
export const FAILURE_WINDOW_MS = 10 * 60 * 1000;
export const MAX_DEVICE_ROWS = 200;
const HOUR_MS = 60 * 60 * 1000;

export interface MobilePairingConfig {
  enabled?: boolean;
  codeTtlMinutes?: number;
}

/** TTL in ms, default 10 minutes, clamped to 1–60 minutes. */
export function codeTtlMs(cfg: MobilePairingConfig | undefined): number {
  const raw = cfg?.codeTtlMinutes;
  const minutes = typeof raw === 'number' && Number.isFinite(raw) ? Math.min(60, Math.max(1, Math.round(raw))) : 10;
  return minutes * 60 * 1000;
}

/** Printable text only: control characters and newlines removed, trimmed, length-capped. */
export function cleanText(v: unknown, max = 60): string | null {
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  return s.length ? s : null;
}

/** The frozen v1 link: https://instar.sh/pair#v=1&o=<origin>&c=<code>. Everything rides in the fragment. */
export function buildPairLink(origin: string, code: string): string {
  return `${PAIR_LINK_BASE}#v=1&o=${encodeURIComponent(origin)}&c=${code}`;
}

/**
 * The stable https origin a phone may store: the configured named tunnel's hostname,
 * never the live tunnel URL (the tunnel manager can fall back to a quick tunnel or a
 * relay at runtime). Null when there is none.
 */
export function stableOrigin(tunnel: { type?: string; hostname?: string } | undefined): string | null {
  if (tunnel?.type === 'named' && typeof tunnel.hostname === 'string' && /^[A-Za-z0-9.-]+$/.test(tunnel.hostname)) {
    return `https://${tunnel.hostname.toLowerCase()}`;
  }
  return null;
}

/** Random per process; never leaves it. The ping route answers sha256(secret + nonce). */
const PROCESS_SECRET = crypto.randomBytes(32).toString('hex');
export const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
export function pingAnswer(nonce: string): string {
  return crypto.createHash('sha256').update(PROCESS_SECRET + nonce).digest('hex');
}

const sha = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');

interface CodeEntry { expiresAt: number; label: string | null; tokenHash: string }

export type MintResult =
  | { ok: true; code: string; expiresAt: number }
  | { ok: false; reason: 'too-many-live-codes' | 'too-many-mints' };

export type RedeemResult =
  | { ok: true; label: string | null }
  | { ok: false; reason: 'invalid' | 'too-many-attempts' };

/** In-memory pairing codes. Only SHA-256 hashes are kept; a restart drops every code. */
export class PairingCodeStore {
  private codes = new Map<string, CodeEntry>();
  private mintTimes: number[] = [];
  private failureTimes: number[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  private prune(): void {
    const t = this.now();
    for (const [h, e] of this.codes) if (e.expiresAt <= t) this.codes.delete(h);
    this.mintTimes = this.mintTimes.filter((m) => t - m < HOUR_MS);
    this.failureTimes = this.failureTimes.filter((f) => t - f < FAILURE_WINDOW_MS);
  }

  /** `currentToken` binds the code to the API token in force now; a later rotation voids it. */
  mint(ttlMs: number, label: string | null, currentToken: string): MintResult {
    this.prune();
    if (this.codes.size >= MAX_LIVE_CODES) return { ok: false, reason: 'too-many-live-codes' };
    if (this.mintTimes.length >= MAX_MINTS_PER_HOUR) return { ok: false, reason: 'too-many-mints' };
    const code = crypto.randomBytes(16).toString('base64url');
    const expiresAt = this.now() + ttlMs;
    this.codes.set(sha(code), { expiresAt, label, tokenHash: sha(currentToken) });
    this.mintTimes.push(this.now());
    return { ok: true, code, expiresAt };
  }

  /**
   * Take-and-delete in one synchronous step, BEFORE any async work, so two concurrent
   * redeems of one code cannot both succeed. A valid code always redeems; the failure
   * limiter only throttles invalid attempts, so strangers cannot block a real link.
   */
  redeem(code: unknown, currentToken: string): RedeemResult {
    this.prune();
    if (typeof code === 'string' && CODE_PATTERN.test(code)) {
      const h = sha(code);
      const entry = this.codes.get(h);
      if (entry) {
        this.codes.delete(h);
        if (entry.tokenHash === sha(currentToken)) return { ok: true, label: entry.label };
      }
    }
    if (this.failureTimes.length >= MAX_FAILED_REDEEMS) return { ok: false, reason: 'too-many-attempts' };
    this.failureTimes.push(this.now());
    return { ok: false, reason: 'invalid' };
  }

  liveCount(): number { this.prune(); return this.codes.size; }
}

export interface PairedDevice {
  id: string;
  deviceName: string | null;
  pairedAt: string;
  label: string | null;
}

/** The paired-devices log: visibility only, gates nothing. Single server process, synchronous atomic writes. */
export class PairedDeviceLog {
  readonly file: string;

  constructor(stateDir: string) {
    this.file = path.join(stateDir, 'state', 'mobile-devices.json');
  }

  list(): PairedDevice[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as { devices?: unknown };
      if (!Array.isArray(raw.devices)) return [];
      return raw.devices.filter((d): d is PairedDevice => !!d && typeof d === 'object' && typeof (d as PairedDevice).id === 'string');
    } catch {
      // @silent-fallback-ok — a missing or unreadable log reads as empty; it is visibility only and gates nothing
      return [];
    }
  }

  /** Newest first, capped. Throws on a write failure (the caller still returns the token). */
  append(row: { deviceName: string | null; label: string | null }, at: Date = new Date()): PairedDevice {
    const device: PairedDevice = { id: crypto.randomUUID(), deviceName: row.deviceName, pairedAt: at.toISOString(), label: row.label };
    const devices = [device, ...this.list()].slice(0, MAX_DEVICE_ROWS);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ devices }, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    return device;
  }
}

/**
 * One extra sentence for the post-relay credential-rotation notice when phones are paired
 * with the Instar app (docs/specs/mobile-pairing-link.md §2.6): the rotation signs them out.
 */
export function pairedPhonesRotationNote(stateDir: string): string[] {
  const n = new PairedDeviceLog(stateDir).list().length;
  if (n === 0) return [];
  return ['', `Your Instar iPhone app was paired with this agent (${n === 1 ? '1 pairing' : `${n} pairings`} on record), so it is signed out too. Ask me to "add you to my phone" and I'll send a fresh pairing link.`];
}
