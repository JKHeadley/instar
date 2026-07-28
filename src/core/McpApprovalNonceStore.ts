/**
 * McpApprovalNonceStore — the single-use approval nonce substrate for the dynamic
 * MCP lifecycle's authorization gate (DYNAMIC-MCP-LIFECYCLE-SPEC, fold C4).
 *
 * When a non-preapproved session asks to load/offload a server, the SERVER mints a
 * nonce bound to the exact (topicId, kind, server) and hands it back in the
 * `needs-approval` payload. The operator's approval — arriving on an
 * operator-authenticated channel (dashboard PIN / a MessageSentinel-bound "yes") —
 * carries that nonce; `consume` verifies it and invalidates it (single-use). An
 * agent forwarding an `approved:true` flag over the shared Bearer can NEVER satisfy
 * this, because there is no nonce it could have legitimately obtained for someone
 * else's approval: the nonce is the proof that an operator-authenticated approval
 * actually happened.
 *
 * In-memory + TTL-bounded (an approval is a short-lived flow). A nonce is bound to
 * the exact change so a captured nonce cannot be replayed against a different
 * server, a different kind, or a different topic.
 */

import crypto from 'node:crypto';

export type McpChangeKind = 'load' | 'offload';

interface NonceEntry {
  nonce: string;
  key: string; // topicId|kind|server
  expiresAt: number;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 min — long enough for a human yes

function bindKey(topicId: number, kind: McpChangeKind, server: string): string {
  return `${topicId}|${kind}|${server}`;
}

export class McpApprovalNonceStore {
  private readonly byKey = new Map<string, NonceEntry>();

  constructor(
    private readonly ttlMs: number = DEFAULT_TTL_MS,
    /** Injectable clock for tests; defaults to real time. */
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Mint a fresh single-use nonce for (topicId, kind, server). A new mint for the
   * SAME change replaces any prior outstanding nonce for it (only the latest
   * prompt is valid), so a stale nonce from an earlier prompt cannot be replayed.
   */
  mint(topicId: number, kind: McpChangeKind, server: string): string {
    const key = bindKey(topicId, kind, server);
    const nonce = crypto.randomBytes(18).toString('base64url');
    this.byKey.set(key, { nonce, key, expiresAt: this.now() + this.ttlMs });
    return nonce;
  }

  /**
   * Verify + invalidate. Returns true ONLY when an unexpired nonce for this exact
   * (topicId, kind, server) matches `nonce`. Always single-use: a successful
   * consume removes it; a mismatched/expired attempt removes nothing (so the real
   * operator can still retry with the right one until it expires).
   */
  consume(topicId: number, kind: McpChangeKind, server: string, nonce: string): boolean {
    const key = bindKey(topicId, kind, server);
    const entry = this.byKey.get(key);
    if (!entry) return false;
    if (this.now() > entry.expiresAt) {
      this.byKey.delete(key);
      return false;
    }
    if (entry.nonce !== nonce) return false;
    this.byKey.delete(key); // single-use
    return true;
  }

  /** Best-effort sweep of expired entries (callable on a cadence; not required). */
  pruneExpired(): number {
    const t = this.now();
    let removed = 0;
    for (const [key, entry] of this.byKey) {
      if (t > entry.expiresAt) { this.byKey.delete(key); removed++; }
    }
    return removed;
  }

  /** Outstanding (un-consumed, unexpired) nonce count — for status/tests. */
  size(): number {
    this.pruneExpired();
    return this.byKey.size;
  }
}
