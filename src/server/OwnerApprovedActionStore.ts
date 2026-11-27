/**
 * Owner-approved sensitive action — the shared approval store
 * (docs/specs/owner-approved-sensitive-action.md, SEC-018 primitive).
 *
 * A sensitive MCP handler (threadline_delete first; trust-grant later) cannot be
 * authorized by `isLocal` alone, because a peer-driven local session is local.
 * The owner approves the EXACT action from their phone with a Face-ID-gated
 * owner-presence signature (mobileOwnerPresenceRoutes). That verified approval is
 * recorded HERE, keyed by {purpose, actionKey}; the handler consumes it to apply
 * the action.
 *
 * In-memory, single-use, TTL'd — exactly like the owner-presence challenge store
 * (BoundSecretStore). A server restart drops pending approvals, which is
 * fail-safe: the action simply waits for a fresh owner tap (never an auto-apply),
 * so a restart can never leave a replayable approval, and consume-then-apply with
 * an idempotent action can never double-apply. Nothing here is a secret the
 * calling session could read to self-service: an approval EXISTS only after a
 * valid presence signature the local session cannot forge.
 */

const DEFAULT_TTL_MS = 5 * 60_000;
const MAX_ENTRIES = 256;

/** The exact action an approval authorizes. `actionKey` identifies the resource
 *  (a threadId; or `fingerprint|level` for a trust grant). `revision` is the
 *  resource state the owner reviewed, or null when the action has no revision. */
export interface ApprovalKey {
  purpose: string;
  actionKey: string;
  revision?: string | null;
}

interface Entry {
  purpose: string;
  actionKey: string;
  revision: string | null;
  expiresAt: number;
  ref: string;
}

function keyOf(purpose: string, actionKey: string): string {
  return `${purpose}\n${actionKey}`;
}

export class OwnerApprovedActionStore {
  private readonly entries = new Map<string, Entry>();
  private seq = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
    private readonly max: number = MAX_ENTRIES,
  ) {}

  /**
   * Record an owner-verified approval for one action. The caller MUST have
   * verified a fresh owner-presence signature first (this store never verifies a
   * signature — it holds the RESULT). Replaces any prior approval for the same
   * {purpose, actionKey}. Returns an opaque ref for the audit trail.
   */
  record(key: ApprovalKey): string {
    this.prune();
    const ref = `apr_${(++this.seq).toString(36)}_${this.now().toString(36)}`;
    const entry: Entry = {
      purpose: key.purpose,
      actionKey: key.actionKey,
      revision: key.revision ?? null,
      expiresAt: this.now() + this.ttlMs,
      ref,
    };
    this.entries.set(keyOf(key.purpose, key.actionKey), entry);
    // Bound the map: drop the oldest-expiring beyond the cap.
    while (this.entries.size > this.max) {
      let oldestKey: string | undefined;
      let oldestAt = Infinity;
      for (const [k, e] of this.entries) if (e.expiresAt < oldestAt) { oldestAt = e.expiresAt; oldestKey = k; }
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
    }
    return ref;
  }

  /**
   * Atomically consume a live approval for the exact action. Deletes first (so a
   * concurrent second consume cannot also succeed), then checks expiry and — when
   * the caller supplies a `revision` — that it matches the revision the owner
   * reviewed (the resource must not have changed since the tap). Returns the ref
   * when a valid approval was consumed, else null.
   */
  consume(key: ApprovalKey): string | null {
    const mapKey = keyOf(key.purpose, key.actionKey);
    const e = this.entries.get(mapKey);
    if (!e) return null;
    if (e.expiresAt <= this.now()) { this.entries.delete(mapKey); return null; } // expired → prune + fail
    // A wrong revision must NOT destroy the owner's still-valid approval (that would be a
    // griefing DoS by a hostile local caller). Node is single-threaded, so checking before the
    // delete is still atomic for single-use — nothing interleaves inside this synchronous call.
    if (key.revision !== undefined && (key.revision ?? null) !== e.revision) return null;
    this.entries.delete(mapKey); // valid → consume once
    return e.ref;
  }

  /** Is there a live approval for this action right now (without consuming it)? */
  has(key: ApprovalKey): boolean {
    const e = this.entries.get(keyOf(key.purpose, key.actionKey));
    return !!e && e.expiresAt > this.now();
  }

  size(): number { this.prune(); return this.entries.size; }

  private prune(): void {
    const t = this.now();
    for (const [k, e] of this.entries) if (e.expiresAt <= t) this.entries.delete(k);
  }
}
