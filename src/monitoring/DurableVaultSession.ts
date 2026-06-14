/**
 * DurableVaultSession — the flag-gated, TTL+idle-bounded, in-flight-only warm
 * org-Bitwarden session that lets the self-unblock checklist's org-vault probe
 * (§5.2) actually reach the vault, so "the cred is in the vault but I can't reach
 * it" never recurs (the motivating incident).
 *
 * CRITICAL SECURITY CONTRACT (spec §5.3 — the main security tradeoff of the
 * standard, acknowledged as such):
 *   - The session value lives in PROCESS MEMORY ONLY (this object's private field).
 *   - It is NEVER written to any log/config/temp file.
 *   - It is NEVER passed as a CLI argument (argv is visible in `ps`); it is handed
 *     to `bw` ONLY via the child process's `BW_SESSION` env (the `runBw` injection
 *     point is responsible for that, and the real provider does so).
 *   - It is NEVER placed on the cross-machine `multiMachine.secretSync` path — this
 *     object holds it in a transient field, never in the SecretStore the sync layer
 *     reads. Machine-local.
 *   - The master password stays operator-held; this introduces NO new on-disk
 *     secret.
 *
 * Standing-privilege bound:
 *   - TTL: the session is considered stale `ttlMs` after it was derived.
 *   - Idle expiry: the session is dropped after `idleMs` with no use.
 *   - In-flight only: `withSession` derives (or reuses a fresh) session, runs the
 *     caller, and the session is only KEPT warm while a checklist run is actually
 *     in flight — minimizing the window a compromised process could reach the
 *     vault. Outside a run the session is eligible to be cleared.
 *
 * Ships DARK behind `monitoring.blockerLedger.durableVaultSession.*` (dev-gate via
 * omitted `enabled`). When disabled, the org-vault probe simply reports unreachable.
 */

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 min — a refreshable warm session
const DEFAULT_IDLE_MS = 2 * 60 * 1000; // 2 min idle → drop

export interface DurableVaultSessionOptions {
  /**
   * Derive a fresh session value (e.g. `bw unlock <password> --raw`, or read an
   * already-unlocked session). MUST return the raw session string or null when the
   * vault cannot be unlocked. INJECTED so the real bw call stays out of this class
   * (and tests never shell out). The password is the caller's responsibility — this
   * class never holds or logs it.
   */
  deriveSession: () => Promise<string | null> | string | null;
  /** Time-to-live for a derived session (default 10 min). */
  ttlMs?: number;
  /** Idle-expiry (default 2 min). */
  idleMs?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

export class DurableVaultSession {
  /** The in-memory session value. NEVER persisted, logged, or argv-passed. */
  private session: string | null = null;
  private derivedAt = 0;
  private lastUsedAt = 0;
  /** Re-entrancy guard: how many in-flight runs are holding the session warm. */
  private inFlight = 0;
  /** Coalesce concurrent derivations so we never unlock twice in parallel. */
  private derivePromise: Promise<string | null> | null = null;

  private readonly deriveSession: () => Promise<string | null> | string | null;
  private readonly ttlMs: number;
  private readonly idleMs: number;
  private readonly now: () => number;

  constructor(opts: DurableVaultSessionOptions) {
    this.deriveSession = opts.deriveSession;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Is the held session still valid (not past TTL, not idle-expired)? */
  private isValid(): boolean {
    if (!this.session) return false;
    const t = this.now();
    if (t - this.derivedAt >= this.ttlMs) return false; // TTL
    if (this.inFlight === 0 && t - this.lastUsedAt >= this.idleMs) return false; // idle
    return true;
  }

  /**
   * Ensure a valid session, deriving one if needed (coalescing concurrent
   * derivations). Returns null when the vault cannot be unlocked. NEVER returns or
   * logs the value through any surface other than the direct return.
   */
  private async ensure(): Promise<string | null> {
    if (this.isValid()) {
      this.lastUsedAt = this.now();
      return this.session;
    }
    // Drop a stale value before re-deriving.
    this.session = null;
    if (this.derivePromise) return this.derivePromise;
    this.derivePromise = (async () => {
      try {
        const value = await this.deriveSession();
        if (typeof value === 'string' && value.length > 0) {
          this.session = value;
          this.derivedAt = this.now();
          this.lastUsedAt = this.derivedAt;
          return this.session;
        }
        this.session = null;
        return null;
      } finally {
        this.derivePromise = null;
      }
    })();
    return this.derivePromise;
  }

  /**
   * Run `fn` with a warm session value, keeping it warm ONLY while the run is in
   * flight. The session value is passed to `fn` for direct, in-process use (e.g.
   * handing it to the bw child's `BW_SESSION` env) — `fn` MUST NOT log or persist
   * it. Returns null (without running `fn`) when no session can be derived.
   */
  async withSession<T>(fn: (session: string) => Promise<T> | T): Promise<T | null> {
    this.inFlight += 1;
    try {
      const session = await this.ensure();
      if (!session) return null;
      this.lastUsedAt = this.now();
      const result = await fn(session);
      this.lastUsedAt = this.now();
      return result;
    } finally {
      this.inFlight -= 1;
      // Outside a run, allow idle-expiry to clear the value on the next check; an
      // explicit clear is offered for callers that want zero standing privilege.
      if (this.inFlight === 0 && !this.isValid()) {
        this.session = null;
      }
    }
  }

  /** True iff a usable session is currently held (for the observability surface — NEVER the value). */
  hasWarmSession(): boolean {
    return this.isValid();
  }

  /** Explicitly drop the in-memory session (zero standing privilege). */
  clear(): void {
    this.session = null;
    this.derivedAt = 0;
    this.lastUsedAt = 0;
  }

  /**
   * Redacted serialization. A logger (or an accidental `JSON.stringify`) must
   * NEVER spill the session value — this overrides the default enumeration so the
   * value can only ever be reached through `withSession`'s fn argument. Part of
   * the §5.3 no-leak contract.
   */
  toJSON(): { warm: boolean; redacted: true } {
    return { warm: this.hasWarmSession(), redacted: true };
  }

  /** Same redaction for Node's util.inspect / console.log. */
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `DurableVaultSession { warm: ${this.hasWarmSession()}, session: <redacted> }`;
  }
}
