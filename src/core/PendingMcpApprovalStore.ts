/**
 * PendingMcpApprovalStore — the server-side registry behind the dynamic-MCP
 * operator-approval TAP surface (DYNAMIC-MCP-LIFECYCLE-SPEC follow-up). When a
 * non-preapproved interactive change needs operator approval, the agent registers
 * the pending change here and gets back an OPAQUE `requestId` to put in a tap link
 * — the server-minted nonce stays SERVER-SIDE and never travels in the URL (the
 * same posture as Secret Drop's opaque tokens, vs. a nonce-in-query-string leak).
 *
 * The approval PAGE reads the request via `peek` (which NEVER returns the nonce),
 * renders "Approve load of X on topic N?", and the PIN-gated submit calls `consume`
 * (which returns the nonce once + removes the entry) so the route can drive the
 * existing `{kind:'operator-approved', nonce}` change. Single-use + TTL-bounded.
 */

import crypto from 'node:crypto';

export type McpChangeKind = 'load' | 'offload';

export interface PendingMcpApproval {
  topicId: number;
  kind: McpChangeKind;
  server: string;
  nonce: string;
  expiresAt: number;
}

/** What the approval page may see — deliberately WITHOUT the nonce. */
export interface PendingMcpApprovalView {
  requestId: string;
  topicId: number;
  kind: McpChangeKind;
  server: string;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 min — long enough for a human tap

export class PendingMcpApprovalStore {
  private readonly byId = new Map<string, PendingMcpApproval>();

  constructor(
    private readonly ttlMs: number = DEFAULT_TTL_MS,
    /** Injectable clock for tests; defaults to real time. */
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Register a pending change; returns an opaque single-use requestId. */
  register(input: { topicId: number; kind: McpChangeKind; server: string; nonce: string }): string {
    const requestId = crypto.randomBytes(18).toString('base64url');
    this.byId.set(requestId, {
      topicId: input.topicId, kind: input.kind, server: input.server, nonce: input.nonce,
      expiresAt: this.now() + this.ttlMs,
    });
    return requestId;
  }

  /** Read a pending request for the approval page — NEVER exposes the nonce.
   *  Returns null when absent or expired (an expired entry is dropped). */
  peek(requestId: string): PendingMcpApprovalView | null {
    const e = this.byId.get(requestId);
    if (!e) return null;
    if (this.now() > e.expiresAt) { this.byId.delete(requestId); return null; }
    return { requestId, topicId: e.topicId, kind: e.kind, server: e.server };
  }

  /** Consume (verify + invalidate) for the PIN-gated submit. Returns the full
   *  entry INCLUDING the nonce once, then removes it (single-use). Null when
   *  absent/expired. */
  consume(requestId: string): PendingMcpApproval | null {
    const e = this.byId.get(requestId);
    if (!e) return null;
    this.byId.delete(requestId); // single-use regardless of expiry
    if (this.now() > e.expiresAt) return null;
    return e;
  }

  /** Best-effort sweep of expired entries. */
  pruneExpired(): number {
    const t = this.now();
    let removed = 0;
    for (const [id, e] of this.byId) { if (t > e.expiresAt) { this.byId.delete(id); removed++; } }
    return removed;
  }

  /** Outstanding (unconsumed, unexpired) count — for status/tests. */
  size(): number { this.pruneExpired(); return this.byId.size; }
}
