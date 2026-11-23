/**
 * IdentityCheckLog — a small durable record of which login each config home (slot) was
 * confirmed to hold, and when (docs/specs/quota-pacing-spend-by-account.md §1, path 2).
 *
 * One JSONL file per slot under `<stateDir>/state/identity-checks/`. Each line is an
 * interval `{ from, lastConfirmedAt, result, identity }`. A new line starts when the result
 * or the identity changes. The open interval's `lastConfirmedAt` moves forward in memory on
 * every confirmed check and is flushed by rewriting the last line, at most every 15 minutes
 * and on shutdown. An unavailable check closes the open interval (no new line, no extension).
 *
 * It answers one question for the usage ledger: what was confirmed for this slot at time t?
 * It is a measurement record only; nothing reads it to decide anything.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export type IdentityCheckResult = 'confirmed' | 'drifted';

export interface IdentityInterval {
  from: number;
  lastConfirmedAt: number;
  result: IdentityCheckResult;
  /** step 1's identity key (`identityKey(provider, email)`), or null when unknown. */
  identity: string | null;
  /** True once an unavailable check (or a different result) has closed it. */
  closed?: boolean;
}

export interface IdentityCheckLogOptions {
  stateDir: string;
  now?: () => number;
  /** How often the open interval's lastConfirmedAt is flushed (default 15 minutes). */
  flushEveryMs?: number;
}

const FLUSH_EVERY_MS = 15 * 60_000;
const MAX_INTERVALS_PER_SLOT = 2_000;

/** A stable, path-safe file id for a slot (its absolute config-home path). */
export function slotFileId(slot: string): string {
  return crypto.createHash('sha256').update(path.resolve(slot)).digest('hex').slice(0, 24);
}

export class IdentityCheckLog {
  private readonly dir: string;
  private readonly now: () => number;
  private readonly flushEveryMs: number;
  private readonly bySlot = new Map<string, IdentityInterval[]>();
  private readonly lastFlush = new Map<string, number>();
  private readonly dirty = new Set<string>();

  constructor(opts: IdentityCheckLogOptions) {
    this.dir = path.join(opts.stateDir, 'state', 'identity-checks');
    this.now = opts.now ?? Date.now;
    this.flushEveryMs = opts.flushEveryMs ?? FLUSH_EVERY_MS;
  }

  private file(slot: string): string { return path.join(this.dir, `${slotFileId(slot)}.jsonl`); }

  /** Intervals for a slot, loaded once from disk. */
  intervals(slot: string): IdentityInterval[] {
    const key = path.resolve(slot);
    let list = this.bySlot.get(key);
    if (list) return list;
    list = [];
    try {
      for (const line of fs.readFileSync(this.file(key), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const v = JSON.parse(line) as IdentityInterval;
          if (Number.isFinite(v.from) && Number.isFinite(v.lastConfirmedAt) && (v.result === 'confirmed' || v.result === 'drifted')) {
            list.push({ from: v.from, lastConfirmedAt: v.lastConfirmedAt, result: v.result, identity: typeof v.identity === 'string' ? v.identity : null, ...(v.closed ? { closed: true } : {}) });
          }
        } catch { /* @silent-fallback-ok: a corrupt line is skipped; the slot's rows read identity-unconfirmed for that span */ }
      }
    } catch { /* @silent-fallback-ok: no file yet means no checks recorded; rows read identity-unconfirmed */ }
    this.bySlot.set(key, list);
    return list;
  }

  /** Record one identity check for a slot. `unavailable` closes the open interval. */
  record(slot: string, check: { result: IdentityCheckResult | 'unavailable'; identity: string | null }): void {
    const key = path.resolve(slot);
    const list = this.intervals(key);
    const now = this.now();
    const open = list.length > 0 && !list[list.length - 1].closed ? list[list.length - 1] : null;
    if (check.result === 'unavailable') {
      if (open) { open.closed = true; this.persist(key, true); }
      return;
    }
    if (open && open.result === check.result && open.identity === check.identity) {
      open.lastConfirmedAt = now;
      this.dirty.add(key);
      if (now - (this.lastFlush.get(key) ?? 0) >= this.flushEveryMs) this.persist(key, false);
      return;
    }
    if (open) open.closed = true;
    list.push({ from: now, lastConfirmedAt: now, result: check.result, identity: check.identity });
    if (list.length > MAX_INTERVALS_PER_SLOT) list.splice(0, list.length - MAX_INTERVALS_PER_SLOT);
    this.persist(key, true);
  }

  /**
   * What was confirmed for `slot` at time `t`: the interval covering t, or the last interval
   * ending before t when t is within `graceMs` of its lastConfirmedAt and no later interval
   * began in between. null when nothing covers t.
   */
  at(slot: string, t: number, graceMs: number): IdentityInterval | null {
    const list = this.intervals(slot);
    for (let i = list.length - 1; i >= 0; i--) {
      const iv = list[i];
      if (iv.from > t) continue;
      if (t <= iv.lastConfirmedAt) return iv;
      const next = list[i + 1];
      if (next && next.from <= t) return null;
      return t - iv.lastConfirmedAt < graceMs ? iv : null;
    }
    return null;
  }

  /** Flush every dirty slot (shutdown and the periodic tick). */
  flushAll(): void { for (const key of [...this.dirty]) this.persist(key, true); }

  private persist(key: string, full: boolean): void {
    const list = this.bySlot.get(key) ?? [];
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const file = this.file(key);
      const tmp = `${file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, list.map((iv) => JSON.stringify(iv)).join('\n') + (list.length ? '\n' : ''));
      fs.renameSync(tmp, file);
      this.lastFlush.set(key, this.now());
      this.dirty.delete(key);
    } catch (err) { /* @silent-fallback-ok: the in-memory intervals still answer; the next flush retries */
      if (full) console.warn('[identity-checks] write failed (non-fatal):', err instanceof Error ? err.message : err);
    }
  }
}
