/**
 * TelegramCallbackDedupe — one inline-button tap has one effect.
 *
 * Spec: docs/specs/telegram-internal-route-lifeline-secret.md §Idempotency
 *
 * Telegram gives every button tap a unique `callback_query.id`. The lifeline
 * can deliver the same tap twice: it retries once after a refused request, and
 * a lifeline restart re-polls any update whose offset it had not yet
 * acknowledged. A tap can be an approval, so the second delivery must do
 * nothing.
 *
 * The id is claimed BEFORE the handler runs, as `pending`, and the outcome is
 * recorded afterwards (`done` or `failed`). A claim is never released: the
 * guarantee is at-most-once, and a person who wants to try again taps again,
 * which is a new id. A redelivery answers by what is known:
 *   done    → duplicate            (the tap was applied; success-shaped)
 *   failed  → duplicate-of-failed  (the handler threw)
 *   pending → duplicate-of-unknown (the server stopped between claim and
 *                                   outcome, or the first delivery is still
 *                                   running) — never reported as success
 *
 * Claims are persisted so a server restart between two deliveries does not
 * reopen the window. The store is bounded by count and age; a tap older than
 * the bound is no longer recognised, which is the stated limit of the
 * guarantee.
 */

import fs from 'node:fs';
import path from 'node:path';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';

export const CALLBACK_DEDUPE_RELPATH = path.join('state', 'telegram-callback-seen.json');
export const CALLBACK_DEDUPE_MAX = 2000;
export const CALLBACK_DEDUPE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type Outcome = 'pending' | 'done' | 'failed';
export type CallbackClaim = 'first' | 'duplicate' | 'duplicate-of-failed' | 'duplicate-of-unknown';

interface Entry { at: number; outcome: Outcome }

function duplicateOf(outcome: Outcome): Exclude<CallbackClaim, 'first'> {
  if (outcome === 'done') return 'duplicate';
  return outcome === 'failed' ? 'duplicate-of-failed' : 'duplicate-of-unknown';
}

export class TelegramCallbackDedupe {
  private readonly filePath: string | null;
  private readonly seen = new Map<string, Entry>();
  private readonly now: () => number;
  duplicates = 0;
  writeFailures = 0;
  /** The persisted store existed but could not be parsed (started empty). */
  corruptAtLoad = false;

  /**
   * @param stateDir  state dir for the persisted store, or `null` for an
   *                  in-memory store (used for taps accepted WITHOUT proof, so
   *                  a caller that never proved itself cannot fill or evict
   *                  the durable store of real taps).
   */
  constructor(stateDir: string | null, now: () => number = Date.now) {
    this.filePath = stateDir === null ? null : path.join(stateDir, CALLBACK_DEDUPE_RELPATH);
    this.now = now;
    if (this.filePath === null) return;
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf-8');
    } catch {
      // @silent-fallback-ok — no file yet: start empty.
      return;
    }
    try {
      const parsed = JSON.parse(raw) as { seen?: Record<string, [number, Outcome]> };
      const cutoff = this.now() - CALLBACK_DEDUPE_TTL_MS;
      for (const [id, v] of Object.entries(parsed.seen ?? {})) {
        if (!Array.isArray(v) || typeof v[0] !== 'number' || v[0] < cutoff) continue;
        const outcome: Outcome = v[1] === 'done' || v[1] === 'failed' ? v[1] : 'pending';
        this.seen.set(id, { at: v[0], outcome });
      }
    } catch {
      // Present but unparseable: start empty (the in-memory map still dedupes
      // for this process's lifetime) and say so on /health.
      this.corruptAtLoad = true;
    }
  }

  /** Has this id been claimed here? Counts a duplicate when it has. */
  peek(callbackQueryId: string | number): 'none' | Exclude<CallbackClaim, 'first'> {
    const entry = this.seen.get(String(callbackQueryId));
    if (!entry) return 'none';
    this.duplicates++;
    return duplicateOf(entry.outcome);
  }

  /** Claim a callback id: `first` the first time, otherwise what is known. */
  claim(callbackQueryId: string | number): CallbackClaim {
    const id = String(callbackQueryId);
    const existing = this.seen.get(id);
    if (existing) {
      this.duplicates++;
      return duplicateOf(existing.outcome);
    }
    const nowMs = this.now();
    this.seen.set(id, { at: nowMs, outcome: 'pending' });
    const cutoff = nowMs - CALLBACK_DEDUPE_TTL_MS;
    for (const [k, v] of this.seen) {
      if (v.at < cutoff || this.seen.size > CALLBACK_DEDUPE_MAX) this.seen.delete(k);
      else break; // insertion-ordered: the rest are newer
    }
    this.persist();
    return 'first';
  }

  /** The handler for a claimed id completed. */
  markDone(callbackQueryId: string | number): void {
    this.settle(String(callbackQueryId), 'done');
  }

  /** The handler for a claimed id threw. The claim is kept. */
  markFailed(callbackQueryId: string | number): void {
    this.settle(String(callbackQueryId), 'failed');
  }

  get size(): number {
    return this.seen.size;
  }

  private settle(id: string, outcome: Outcome): void {
    const entry = this.seen.get(id);
    if (!entry) return;
    entry.outcome = outcome;
    this.persist();
  }

  private persist(): void {
    if (this.filePath === null) return;
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const seen: Record<string, [number, Outcome]> = {};
      for (const [id, v] of this.seen) seen[id] = [v.at, v.outcome];
      /* state-registry: lifeline-ingress-guard */
      fs.writeFileSync(tmp, JSON.stringify({ seen }), { mode: 0o600 });
      fs.renameSync(tmp, this.filePath);
    } catch {
      this.writeFailures++;
      try {
        if (fs.existsSync(tmp)) {
          SafeFsExecutor.safeUnlinkSync(tmp, { operation: 'src/server/TelegramCallbackDedupe.ts:persist-cleanup' });
        }
      } catch { /* best-effort */ }
    }
  }
}
