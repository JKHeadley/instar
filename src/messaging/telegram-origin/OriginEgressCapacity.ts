import { randomUUID } from 'node:crypto';

// A grant may be used late, so retain its debit for a full window AFTER its
// expiry. This bounds actual starts, not merely reservation timestamps.
export const ORIGIN_CAPACITY_TTL_MS = 250;
export const ORIGIN_CAPACITY_WINDOW_MS = 1000 + ORIGIN_CAPACITY_TTL_MS;
export interface OriginCapacityGrant { ownerBootId: string; accountId: string; nonce: string; expiresAt: number; }
export interface OriginCapacityAuthority {
  reserve(accountId: string): Promise<OriginCapacityGrant | null>;
  consume(grant: OriginCapacityGrant): Promise<boolean>;
}
export class OriginCapacityUnavailable extends Error {
  constructor() { super('credential-capacity-unavailable'); this.name = 'OriginCapacityUnavailable'; }
}
/** One memory authority per credential owner. It survives recording-worker
 * failure. Missing lease, expired credits and owner replacement fail closed. */
export class OriginEgressCapacity implements OriginCapacityAuthority {
  readonly #debits = new Map<string, Array<{ at: number; grant: OriginCapacityGrant; consumed: boolean }>>();
  readonly #readyAt: number;
  #closed = false;
  constructor(readonly options: { ownerBootId: string; accountIds: () => string[];
    ownsLease: () => boolean; now?: () => number }) {
    this.#readyAt = this.#now() + ORIGIN_CAPACITY_WINDOW_MS;
  }
  #now(): number { return this.options.now?.() ?? Date.now(); }
  #live(accountId: string): boolean {
    try { return !this.#closed && this.#now() >= this.#readyAt && this.options.ownsLease() && this.options.accountIds().includes(accountId); }
    catch { return false; }
  }
  async reserve(accountId: string): Promise<OriginCapacityGrant | null> {
    if (!this.#live(accountId)) return null;
    const now = this.#now();
    const entries = (this.#debits.get(accountId) ?? []).filter(entry => now - entry.at < ORIGIN_CAPACITY_WINDOW_MS);
    this.#debits.set(accountId, entries);
    if (entries.length >= 10) return null;
    const grant = { ownerBootId: this.options.ownerBootId, accountId, nonce: randomUUID(), expiresAt: now + ORIGIN_CAPACITY_TTL_MS };
    entries.push({ at: now, grant, consumed: false }); return { ...grant };
  }
  async consume(grant: OriginCapacityGrant): Promise<boolean> {
    if (!this.#live(grant.accountId) || grant.ownerBootId !== this.options.ownerBootId || grant.expiresAt <= this.#now()) return false;
    const entry = this.#debits.get(grant.accountId)?.find(entry => entry.grant.nonce === grant.nonce);
    if (!entry || entry.consumed || entry.grant.expiresAt !== grant.expiresAt) return false;
    entry.consumed = true; return true;
  }
  close(): void { this.#closed = true; this.#debits.clear(); }
}
