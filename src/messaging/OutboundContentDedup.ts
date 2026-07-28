/**
 * OutboundContentDedup — suppress the agent re-sending the SAME conversational
 * reply to the same topic within a window.
 *
 * The problem (2026-06-06, EXO 3.0 topic): a status message went out
 * byte-identical at 21:14 and again at 21:28 — 13.5 minutes apart, same text.
 * The existing guards don't catch this: the X-Instar-DeliveryId dedup only
 * matches a re-POST of the SAME delivery id (these were two distinct sends with
 * different ids), and the tone-gate's dup awareness is SKIPPED for proxy /
 * system-template / cross-machine-relay sends. So an agent that re-announces
 * its last status after a restart/recovery, or a relay that re-emits identical
 * content under a fresh id, sends the user the same thing twice.
 *
 * This is a deterministic content fingerprint: (topicId + normalized text) seen
 * within `windowMs` ⇒ suppress. It runs BEFORE the tone gate (cheap, no LLM)
 * and independent of it, so it covers the relay/proxy paths the tone gate skips.
 *
 * Deliberately NARROW to avoid suppressing legitimate repeats:
 *  - Only messages of at least `minLength` chars are deduped. Brief acks ("Got
 *    it, looking into this") are SHORT and exempt — a user who sends two
 *    messages and gets two identical short acks must still see both.
 *  - The caller's existing `allowDuplicate` escape hatch bypasses it entirely
 *    (for the rare caller that legitimately repeats a long message).
 *  - record() is called only AFTER a successful send, so a failed send's retry
 *    (same content, new id) is NOT wrongly suppressed.
 *
 * Pure + signal-only: it decides "is this an exact recent duplicate?" and the
 * caller decides what to do. No LLM, no I/O.
 */

export interface OutboundContentDedupConfig {
  enabled?: boolean;
  /** A repeat of the same text within this window is a duplicate. Default 15min. */
  windowMs?: number;
  /** Messages shorter than this are never deduped (brief acks repeat legitimately). Default 40. */
  minLength?: number;
  /** Cap on remembered fingerprints per topic (ring). Default 50. */
  maxPerTopic?: number;
  /** How long an in-flight `tryReserve` claim stays live before it auto-expires,
   *  so a leaked reservation (a send that neither recorded nor released — e.g. a
   *  crash mid-send) can never permanently suppress a fingerprint. Must comfortably
   *  exceed the outbound route's own send budget. Default 3min. */
  reserveTtlMs?: number;
}

const DEFAULTS: Required<OutboundContentDedupConfig> = {
  enabled: true,
  windowMs: 15 * 60 * 1000,
  minLength: 40,
  maxPerTopic: 50,
  reserveTtlMs: 3 * 60 * 1000,
};

/** Normalize for fingerprinting: trim, collapse internal whitespace runs. Two
 *  sends that differ only in trailing/whitespace are the same message. */
export function normalizeForDedup(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** FNV-1a — small, dependency-free, collision-rare for this use. */
export function fingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // unsigned hex + length, so different-length texts that hash-collide still differ
  return `${(h >>> 0).toString(16)}:${text.length}`;
}

export class OutboundContentDedup {
  private readonly cfg: Required<OutboundContentDedupConfig>;
  /** topicId -> (fingerprint -> last-sent epoch ms) */
  private readonly seen = new Map<number, Map<string, number>>();
  /** topicId -> (fingerprint -> reserved-at epoch ms). An IN-FLIGHT claim taken
   *  by `tryReserve` BEFORE a send starts and cleared by `record` (success) or
   *  `releaseReservation` (failure). This closes the check-then-send race that
   *  `isDuplicate` + record-after-success left open: under a server stall a send
   *  can be in flight for tens of seconds, and a second identical request that
   *  arrives in that window used to pass the duplicate check (nothing recorded
   *  yet) and send a second copy. Reservations auto-expire after `reserveTtlMs`
   *  so a leaked claim can never permanently suppress a fingerprint. */
  private readonly reserved = new Map<number, Map<string, number>>();
  private readonly now: () => number;
  /** Optional durable backing so a duplicate is caught ACROSS a restart / across
   *  overlapping processes (the in-memory `seen` Map resets on restart — the exact
   *  window the 2026-06-07 restart churn opened, finding_cross_restart_duplicate_replies).
   *  Fail-open: the store itself never throws, so a backing hiccup degrades to the
   *  in-memory-only behavior — it can never suppress a legitimate message. */
  private readonly store: import('./OutboundDedupStore.js').OutboundDedupStore | null;

  constructor(
    cfg: OutboundContentDedupConfig = {},
    now: () => number = Date.now,
    store: import('./OutboundDedupStore.js').OutboundDedupStore | null = null,
  ) {
    this.cfg = { ...DEFAULTS, ...cfg };
    this.now = now;
    this.store = store;
  }

  /** Is `text` an exact duplicate of a message sent to `topicId` within the
   *  window? Pure read — does NOT record. Returns false when disabled or the
   *  text is below the length floor. */
  isDuplicate(topicId: number, text: string): boolean {
    if (!this.cfg.enabled) return false;
    const norm = normalizeForDedup(text);
    if (norm.length < this.cfg.minLength) return false;
    const fp = fingerprint(norm);
    const topicMap = this.seen.get(topicId);
    const last = topicMap?.get(fp);
    if (last !== undefined && this.now() - last < this.cfg.windowMs) return true;
    // In-memory missed (or was reset by a restart) — consult the durable store so
    // an identical send across a restart / overlapping process is still caught.
    // Fail-open: the store swallows its own errors and returns false on trouble.
    if (this.store) {
      return this.store.wasSentSince(topicId, fp, this.now() - this.cfg.windowMs);
    }
    return false;
  }

  /** Atomically decide whether `text` may be sent to `topicId`, AND — if so —
   *  reserve it in-flight so a concurrent/rapid identical send is caught before
   *  the first one has recorded. Returns:
   *    - false  ⇒ suppress: an identical text was sent within the window OR is
   *               currently in flight (a live reservation). The caller must NOT
   *               send and must NOT release (it doesn't own the reservation).
   *    - true   ⇒ proceed: the caller now OWNS a reservation and MUST resolve it
   *               with `record` (on success) or `releaseReservation` (on failure).
   *  Below-floor text is never deduped → always returns true with no reservation
   *  (brief acks legitimately repeat). This supersedes the plain `isDuplicate`
   *  check at the send callsite to close the check-then-send race. */
  tryReserve(topicId: number, text: string): boolean {
    if (!this.cfg.enabled) return true;
    const norm = normalizeForDedup(text);
    if (norm.length < this.cfg.minLength) return true;
    const fp = fingerprint(norm);
    // Already sent within the window (in-memory or durable) → duplicate.
    if (this.isDuplicate(topicId, text)) return false;
    // Currently in flight (a live, non-expired reservation) → duplicate.
    const now = this.now();
    const resMap = this.reserved.get(topicId);
    const reservedAt = resMap?.get(fp);
    if (reservedAt !== undefined && now - reservedAt < this.cfg.reserveTtlMs) return false;
    // Claim it.
    let topicRes = this.reserved.get(topicId);
    if (!topicRes) {
      topicRes = new Map();
      this.reserved.set(topicId, topicRes);
    }
    topicRes.set(fp, now);
    this.pruneReserved(topicRes);
    return true;
  }

  /** Release an in-flight reservation taken by `tryReserve` — call when the send
   *  FAILED, so the legitimate retry of the same text isn't wrongly suppressed. */
  releaseReservation(topicId: number, text: string): void {
    const norm = normalizeForDedup(text);
    if (norm.length < this.cfg.minLength) return;
    this.reserved.get(topicId)?.delete(fingerprint(norm));
  }

  /** Record that `text` was sent to `topicId` now. Call AFTER a successful send.
   *  No-op for below-floor text (it can never be a dedup target anyway). Also
   *  clears any in-flight reservation for this fingerprint (the send resolved). */
  record(topicId: number, text: string): void {
    if (!this.cfg.enabled) return;
    const norm = normalizeForDedup(text);
    if (norm.length < this.cfg.minLength) return;
    let topicMap = this.seen.get(topicId);
    if (!topicMap) {
      topicMap = new Map();
      this.seen.set(topicId, topicMap);
    }
    const now = this.now();
    const fp = fingerprint(norm);
    topicMap.set(fp, now);
    this.pruneTopic(topicMap);
    // The send resolved → drop the in-flight reservation; the `seen` record now
    // carries the (longer) window suppression.
    this.reserved.get(topicId)?.delete(fp);
    // Mirror to the durable store so a post-restart process sees it. Fail-open.
    this.store?.record(topicId, fp, now);
  }

  /** Drop expired entries, then enforce the per-topic ring cap (oldest-first). */
  private pruneTopic(topicMap: Map<string, number>): void {
    const cutoff = this.now() - this.cfg.windowMs;
    for (const [fp, at] of topicMap) {
      if (at < cutoff) topicMap.delete(fp);
    }
    while (topicMap.size > this.cfg.maxPerTopic) {
      const oldest = topicMap.keys().next().value; // insertion-ordered
      if (oldest === undefined) break;
      topicMap.delete(oldest);
    }
  }

  /** Drop expired reservations (past `reserveTtlMs`), then cap the ring. Keeps a
   *  leaked reservation from lingering and bounds memory the same way `seen` is. */
  private pruneReserved(resMap: Map<string, number>): void {
    const cutoff = this.now() - this.cfg.reserveTtlMs;
    for (const [fp, at] of resMap) {
      if (at < cutoff) resMap.delete(fp);
    }
    while (resMap.size > this.cfg.maxPerTopic) {
      const oldest = resMap.keys().next().value; // insertion-ordered
      if (oldest === undefined) break;
      resMap.delete(oldest);
    }
  }
}
