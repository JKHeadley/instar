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
}

const DEFAULTS: Required<OutboundContentDedupConfig> = {
  enabled: true,
  windowMs: 15 * 60 * 1000,
  minLength: 40,
  maxPerTopic: 50,
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
  private readonly now: () => number;

  constructor(cfg: OutboundContentDedupConfig = {}, now: () => number = Date.now) {
    this.cfg = { ...DEFAULTS, ...cfg };
    this.now = now;
  }

  /** Is `text` an exact duplicate of a message sent to `topicId` within the
   *  window? Pure read — does NOT record. Returns false when disabled or the
   *  text is below the length floor. */
  isDuplicate(topicId: number, text: string): boolean {
    if (!this.cfg.enabled) return false;
    const norm = normalizeForDedup(text);
    if (norm.length < this.cfg.minLength) return false;
    const topicMap = this.seen.get(topicId);
    if (!topicMap) return false;
    const fp = fingerprint(norm);
    const last = topicMap.get(fp);
    if (last === undefined) return false;
    return this.now() - last < this.cfg.windowMs;
  }

  /** Record that `text` was sent to `topicId` now. Call AFTER a successful send.
   *  No-op for below-floor text (it can never be a dedup target anyway). */
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
    topicMap.set(fingerprint(norm), now);
    this.pruneTopic(topicMap);
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
}
