/**
 * PinAttemptStore — durable write-through behind the PIN routes' per-IP
 * brute-force lockout (docs/specs/routing-control-room-spend-alerts.md,
 * Surface 2, S2-1 hardening).
 *
 * `checkMandatePin`'s attempt counter was an in-memory Map, so a server restart
 * reset the lockout. This store persists the counters to
 * `<stateDir>/state/pin-attempts.json` (atomic tmp+rename) and is shared by the
 * PIN routes. Semantics unchanged: N attempts per window per IP; the window
 * expiry clears the entry. Express `trust proxy` is off fleet-wide, so req.ip
 * already ignores X-Forwarded-For.
 */

import fs from 'node:fs';
import path from 'node:path';

interface AttemptEntry {
  count: number;
  resetAt: number;
}

export class PinAttemptStore {
  private readonly filePath: string;
  private entries = new Map<string, AttemptEntry>();
  private readonly maxAttempts: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(opts: { stateDir: string; maxAttempts?: number; windowMs?: number; now?: () => number }) {
    const stateSub = path.join(opts.stateDir, 'state');
    fs.mkdirSync(stateSub, { recursive: true });
    this.filePath = path.join(stateSub, 'pin-attempts.json');
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.windowMs = opts.windowMs ?? 5 * 60 * 1000;
    this.now = opts.now ?? (() => Date.now());
    this.load();
  }

  /** True when the IP is currently locked out. */
  blocked(ip: string): boolean {
    const e = this.current(ip);
    return e !== undefined && e.count >= this.maxAttempts;
  }

  /** Record a FAILED attempt; returns attempts remaining (≥ 0). */
  recordFailure(ip: string): number {
    let e = this.current(ip);
    if (!e) {
      e = { count: 0, resetAt: this.now() + this.windowMs };
      this.entries.set(ip, e);
    }
    e.count++;
    this.persist();
    return Math.max(0, this.maxAttempts - e.count);
  }

  /** Clear an IP's counter on a successful PIN entry. */
  recordSuccess(ip: string): void {
    if (this.entries.delete(ip)) this.persist();
  }

  private current(ip: string): AttemptEntry | undefined {
    const e = this.entries.get(ip);
    if (e && this.now() > e.resetAt) {
      this.entries.delete(ip);
      this.persist();
      return undefined;
    }
    return e;
  }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as Record<string, AttemptEntry>;
      for (const [ip, e] of Object.entries(raw)) {
        if (e && Number.isInteger(e.count) && Number.isFinite(e.resetAt)) this.entries.set(ip, e);
      }
    } catch {
      // @silent-fallback-ok: absent/corrupt attempt file — start empty. The lockout
      // is defence-in-depth; an unreadable file must not brick PIN auth entirely.
    }
  }

  private persist(): void {
    try {
      const tmp = this.filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.entries)), { mode: 0o600 });
      fs.renameSync(tmp, this.filePath);
    } catch {
      // @silent-fallback-ok: a failed persist degrades to in-memory-only counters
      // (today's behavior) — never blocks the auth decision itself.
    }
  }
}
