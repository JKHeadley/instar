/**
 * Pending owner-approval requests (SEC-018; docs/specs/owner-approved-sensitive-action.md).
 *
 * The discovery half. When a sensitive MCP handler needs the owner's approval it REGISTERS a
 * pending request here and returns `owner-approval-required` to its caller. The owner's phone
 * learns a request is waiting by listing these (GET /mobile/action-approval/pending, and — as a
 * fast-follow — as a /mobile/needs item so the dashboard + Mac count it). `title` and `why` are
 * SERVER-WRITTEN plain words derived from the action the server will actually apply, never from
 * the calling session — so the owner's card can never be phrased by the (possibly peer-driven)
 * caller.
 *
 * In-memory, TTL'd (a restart drops pending requests — fail-safe: the caller re-asks and the owner
 * re-sees). Keyed by {purpose, actionKey}; re-registering the same action refreshes it.
 */

const DEFAULT_TTL_MS = 5 * 60_000;
const MAX_ENTRIES = 128;

export interface PendingApproval {
  purpose: string;
  actionKey: string;
  /** Server-written card title, e.g. "Delete the conversation with Dawn?". */
  title: string;
  /** Server-written detail, e.g. "Asked by a session at 21:04. Expires in 5 min.". */
  why: string;
  /** The machine that will apply the action (verified name). */
  machine: string;
  requestedAt: number;
  expiresAt: number;
}

function keyOf(purpose: string, actionKey: string): string {
  return `${purpose}\n${actionKey}`;
}

export class PendingApprovalRegistry {
  private readonly entries = new Map<string, PendingApproval>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
    private readonly max: number = MAX_ENTRIES,
  ) {}

  /** Register (or refresh) a pending request. title/why MUST be server-composed. */
  register(req: { purpose: string; actionKey: string; title: string; why: string; machine: string }): PendingApproval {
    this.prune();
    while (this.entries.size >= this.max && !this.entries.has(keyOf(req.purpose, req.actionKey))) {
      const k = this.entries.keys().next().value as string | undefined;
      if (k === undefined) break;
      this.entries.delete(k);
    }
    const entry: PendingApproval = {
      purpose: req.purpose,
      actionKey: req.actionKey,
      title: req.title,
      why: req.why,
      machine: req.machine,
      requestedAt: this.now(),
      expiresAt: this.now() + this.ttlMs,
    };
    this.entries.set(keyOf(req.purpose, req.actionKey), entry);
    return entry;
  }

  /** Is a live request registered for this exact action? (The challenge route gates on this.) */
  has(purpose: string, actionKey: string): boolean {
    const e = this.entries.get(keyOf(purpose, actionKey));
    return !!e && e.expiresAt > this.now();
  }

  /** All live pending requests (for the phone list + the needs-model). */
  list(): PendingApproval[] {
    this.prune();
    return [...this.entries.values()].sort((a, b) => a.requestedAt - b.requestedAt);
  }

  /** Clear a request (approve applied / declined / handler finished). Idempotent. */
  remove(purpose: string, actionKey: string): void {
    this.entries.delete(keyOf(purpose, actionKey));
  }

  size(): number { this.prune(); return this.entries.size; }

  private prune(): void {
    const t = this.now();
    for (const [k, e] of this.entries) if (e.expiresAt <= t) this.entries.delete(k);
  }
}
