import fs from 'node:fs';
import path from 'node:path';
import { DESKTOP_OPERATOR_CLOCK_SKEW_MS, DESKTOP_OPERATOR_MAX_TTL_MS } from './DesktopOperatorAssertion.js';

/** Durable one-use ledger for desktop operator assertions. A read or write
 * failure denies admission; losing replay state must never enable control. */
export class DesktopAssertionReplayStore {
  private readonly consumed = new Map<string, number>();
  private loaded = false;

  constructor(private readonly filePath: string, private readonly now: () => number = Date.now) {}

  seen(jti: string): boolean {
    this.load();
    return this.consumed.has(jti);
  }

  record(jti: string, expiresAtMs: number): void {
    this.load();
    const now = this.now();
    if (!/^[A-Za-z0-9_-]{32}$/.test(jti) || !Number.isSafeInteger(expiresAtMs)
      || expiresAtMs <= now
      || expiresAtMs > now + DESKTOP_OPERATOR_MAX_TTL_MS + DESKTOP_OPERATOR_CLOCK_SKEW_MS) {
      throw new Error('desktop-replay-invalid');
    }
    if (this.consumed.has(jti)) throw new Error('desktop-operator-replayed');
    const next = new Map([...this.consumed].filter(([, expiry]) => expiry > this.now() - 60_000));
    if (next.size >= 1_000) throw new Error('desktop-replay-capacity');
    next.set(jti, expiresAtMs);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temp = `${this.filePath}.tmp-${process.pid}`;
    fs.writeFileSync(temp, JSON.stringify({ version: 1, consumed: Object.fromEntries(next) }), { mode: 0o600 });
    fs.renameSync(temp, this.filePath);
    this.consumed.clear();
    for (const [key, value] of next) this.consumed.set(key, value);
  }

  private load(): void {
    if (this.loaded) return;
    if (fs.existsSync(this.filePath)) {
      if (fs.statSync(this.filePath).size > 100_000) throw new Error('desktop-replay-ledger-over-capacity');
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as { version?: unknown; consumed?: unknown };
      if (parsed.version !== 1 || !parsed.consumed || typeof parsed.consumed !== 'object'
        || Array.isArray(parsed.consumed)) throw new Error('desktop-replay-ledger-unreadable');
      for (const [jti, expiry] of Object.entries(parsed.consumed)) {
        if (!/^[A-Za-z0-9_-]{32}$/.test(jti) || !Number.isSafeInteger(expiry)) {
          throw new Error('desktop-replay-ledger-unreadable');
        }
        this.consumed.set(jti, expiry as number);
      }
      if (this.consumed.size > 1_000) throw new Error('desktop-replay-ledger-over-capacity');
    }
    this.loaded = true;
  }
}
