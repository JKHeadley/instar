import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Live sessions kept per phone (spec §2.1). */
const PER_PHONE = 2;
/**
 * How long one "is this still an active owner phone" answer is reused. The check reads the device registry
 * from disk, and the desktop re-checks its session on every frame; a revocation still lands within this.
 */
export const OWNER_RECHECK_MS = 1_000;

/**
 * Remote Desktop sessions minted for the owner's phone after a Face ID presence proof
 * (docs/specs/mobile-owner-presence-pin.md §2.1). They are accepted ONLY where the desktop routes
 * accept the dashboard operator session, never by the other routes that session also unlocks.
 * Each is bound to the phone that minted it and is re-checked against that phone on every use,
 * so unpairing or revoking the phone ends it at once. Memory only; a restart ends them all.
 */
export class PhoneDesktopSessionStore {
  private readonly sessions = new Map<string, { deviceId: string; expiresAtMs: number; checkedAtMs: number }>();

  constructor(private readonly now: () => number = Date.now, private readonly ttlMs = 15 * 60_000, private readonly max = 32) {}

  issue(deviceId: string): { token: string; expiresAtMs: number } {
    this.prune();
    // At most two live sessions per phone: a re-unlock before opening another desktop must not end the
    // session a running desktop rests on, which simply expires; a third drops the oldest.
    const mine = [...this.sessions.entries()].filter(([, s]) => s.deviceId === deviceId);
    for (let i = 0; i <= mine.length - PER_PHONE; i++) this.sessions.delete(mine[i]![0]);
    while (this.sessions.size >= this.max) {
      const oldest = this.sessions.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
    const token = randomBytes(32).toString('base64url');
    const expiresAtMs = this.now() + this.ttlMs;
    this.sessions.set(this.digest(token), { deviceId, expiresAtMs, checkedAtMs: -Infinity });
    return { token, expiresAtMs };
  }

  /**
   * The phone this session belongs to, when the session is live AND that phone is still an active
   * owner phone right now; otherwise null (and a session whose phone stopped qualifying is dropped).
   */
  verify(token: unknown, stillOwnerPhone: (deviceId: string) => boolean): string | null {
    if (typeof token !== 'string' || token.length === 0 || token.length > 256) return null;
    const key = this.digest(token);
    const row = this.sessions.get(key);
    if (!row) return null;
    const t = this.now();
    if (row.expiresAtMs <= t) { this.sessions.delete(key); return null; }
    if (t - row.checkedAtMs >= OWNER_RECHECK_MS) {
      if (!stillOwnerPhone(row.deviceId)) { this.sessions.delete(key); return null; }
      row.checkedAtMs = t;
    }
    return row.deviceId;
  }

  /** The phone a session was minted for, without re-checking it (for the caller-binding check). */
  deviceOf(token: unknown): string | null {
    if (typeof token !== 'string' || token.length === 0 || token.length > 256) return null;
    return this.sessions.get(this.digest(token))?.deviceId ?? null;
  }

  /** True when `token` is this phone's live session (constant-time on the device id). */
  belongsTo(token: unknown, deviceId: string, stillOwnerPhone: (deviceId: string) => boolean): boolean {
    const owner = this.verify(token, stillOwnerPhone);
    if (!owner) return false;
    const a = Buffer.from(owner), b = Buffer.from(deviceId);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Ends every session: the PIN changed, so every "a human is here" proof ends with it. */
  clear(): void { this.sessions.clear(); }

  size(): number { this.prune(); return this.sessions.size; }

  private prune(): void {
    const t = this.now();
    for (const [k, s] of this.sessions) if (s.expiresAtMs <= t) this.sessions.delete(k);
  }

  private digest(token: string): string { return createHash('sha256').update(token).digest('hex'); }
}
