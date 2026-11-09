/**
 * The buttons under an offer list, as durable single-use nonces on the machine that sent the list
 * (docs/specs/recommended-services.md, Offers; telegram-button-approval.md §1: an S-class tap must be
 * rate-bounded, and a P-class tap needs a durable, atomically consumed token store on the machine that
 * holds the poll). A tap is spent before it acts, so a second tap answers "already answered".
 *
 * `rs:n:` is a no: less action, undoable through the confirm page, so no owner check and a bound per hour.
 * `rs:y:` is a yes for an address service only: owner-only, checked by the adapter and again here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { recommendedServicesDir } from './RecommendedServicesLedger.js';
import type { OfferTap } from './offerList.js';

/** No taps accepted per hour across every service. A forged-tap flood can refuse at most this much. */
export const OFFER_NO_TAPS_PER_HOUR = 10;

export function offerTapsFile(stateDir: string): string {
  return path.join(recommendedServicesDir(stateDir), 'offer-taps.json');
}

interface Stored {
  taps: OfferTap[];
  /** When each accepted no happened, for the hourly bound. */
  noAt: number[];
}

export class OfferTapStore {
  private readonly file: string;

  constructor(private readonly opts: { stateDir: string; now?: () => number }) {
    this.file = offerTapsFile(opts.stateDir);
  }

  /** Adds a list's taps. Expired ones fall off, so a list a month can't grow the file. */
  add(taps: readonly OfferTap[]): void {
    const current = this.read();
    this.write({ ...current, taps: [...current.taps, ...taps] });
  }

  /** The tap a nonce names, unspent and unexpired, or null. */
  peek(nonce: string): OfferTap | null {
    return this.read().taps.find((t) => t.nonce === nonce) ?? null;
  }

  /** Spends a tap: removed before it is returned, so a repeat gets null even if the first act then fails. */
  consume(nonce: string): OfferTap | null {
    const current = this.read();
    const found = current.taps.find((t) => t.nonce === nonce) ?? null;
    if (!found) return null;
    this.write({ ...current, taps: current.taps.filter((t) => t !== found) });
    return found;
  }

  /** Every tap for a service, spent at once: a choice made elsewhere makes the buttons stale. */
  invalidateService(service: string): void {
    const current = this.read();
    const kept = current.taps.filter((t) => t.service !== service);
    if (kept.length !== current.taps.length) this.write({ ...current, taps: kept });
  }

  /** True when another no may be taken this hour; records it when so. */
  admitNo(): boolean {
    const current = this.read();
    const since = this.now() - 60 * 60_000;
    const recent = current.noAt.filter((at) => at > since);
    if (recent.length >= OFFER_NO_TAPS_PER_HOUR) {
      this.write({ ...current, noAt: recent });
      return false;
    }
    this.write({ ...current, noAt: [...recent, this.now()] });
    return true;
  }

  private read(): Stored {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return { taps: [], noAt: [] }; // @silent-fallback-ok — no file or a torn one means no live tap, which refuses
    }
    const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Stored>;
    const now = this.now();
    const taps = Array.isArray(r.taps) ? r.taps.filter((t): t is OfferTap => !!t && typeof t.nonce === 'string' && typeof t.service === 'string' && (t.action === 'no' || t.action === 'yes') && typeof t.listId === 'string' && typeof t.expiresAt === 'number' && t.expiresAt > now) : [];
    const noAt = Array.isArray(r.noAt) ? r.noAt.filter((n): n is number => typeof n === 'number') : [];
    return { taps, noAt };
  }

  private write(stored: Stored): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(stored), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }
}
