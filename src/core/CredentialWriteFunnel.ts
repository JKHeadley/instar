/**
 * CredentialWriteFunnel — Step 4 (primitive) of live credential re-pointing (spec §2.2).
 *
 * The SOLE in-process serialization point for credential writes to a config-home slot. Every
 * in-process keychain credential write (the swap executor, the QuotaPoller 401-refresh closure,
 * OAuthRefresher / EnrollmentWizard writes, KeychainCredentialProvider.writeCredentials) is meant
 * to go through `withSlotLock(slot, fn)` so a write can never interleave with another write — or
 * with a swap — on the SAME slot. A companion lint (Step 4b) forbids those write primitives
 * outside this funnel, mirroring the SafeGitExecutor / SafeFsExecutor single-funnel precedent.
 *
 * This file is the PRIMITIVE only: the lock machinery + its tests. Routing the existing writers
 * through it and adding the forbidding lint is the next commit (the lint can't land until every
 * existing writer is routed, or it would break the build).
 *
 * Concurrency model (spec §2.2 "Concurrency model"):
 *   - The server process is the only writer; these locks serialize WITHIN that process.
 *   - One per-slot lock serializes every write to a given slot.
 *   - One machine-local single-mover mutex serializes whole SWAPS against each other (a swap
 *     touches two slots; two concurrent swaps could deadlock on cross-ordered slot locks, so a
 *     swap takes the single-mover first, then the slot locks in a canonical order).
 *   - Lock order: single-mover (swaps only) → per-slot locks ordered by slot path → ledger write.
 *   - Crash-stale lock state is cleared by process restart (all state is in-memory).
 *
 * Bounded, never wedged (spec §2.2 "Bounded under the lock"): lock acquisition is a
 * try-lock-WITH-TIMEOUT. On timeout the caller is told it was SKIPPED with a named reason rather
 * than blocking forever — a slow holder degrades to a skipped action, never a wedged slot. (The
 * caller is responsible for bounding any `await` it does INSIDE `fn` — e.g. a refresh fetch must
 * carry its own `AbortSignal.timeout`; the funnel bounds acquisition, not the work.)
 */

/** Outcome of a funnel-guarded operation. `ran:false` = the lock could not be acquired in time. */
export interface FunnelResult<T> {
  ran: boolean;
  /** Present when `ran` is true. */
  value?: T;
  /** Present when `ran` is false — a human-readable, credential-free reason. */
  skippedReason?: string;
}

export interface CredentialWriteFunnelOptions {
  /** Default try-lock timeout for a single slot acquisition (ms). */
  slotLockTimeoutMs?: number;
}

const DEFAULT_SLOT_LOCK_TIMEOUT_MS = 15_000;

export class CredentialWriteFunnel {
  /** Per-slot serialization: slot → the tail promise of that slot's lock queue. */
  private readonly slotTails = new Map<string, Promise<void>>();
  /** Machine-local single-mover mutex (swaps). In-memory ⇒ a restart clears any crash-stale hold. */
  private singleMoverHeld = false;
  private readonly slotLockTimeoutMs: number;

  constructor(opts: CredentialWriteFunnelOptions = {}) {
    this.slotLockTimeoutMs = opts.slotLockTimeoutMs ?? DEFAULT_SLOT_LOCK_TIMEOUT_MS;
  }

  /**
   * Run `fn` while holding the per-slot lock for `slot`. Serializes against every other
   * `withSlotLock` on the same slot. Acquisition is bounded: if the lock is not free within
   * `timeoutMs`, `fn` does NOT run and the result is `{ ran: false, skippedReason }`.
   */
  async withSlotLock<T>(
    slot: string,
    fn: () => Promise<T> | T,
    opts?: { timeoutMs?: number },
  ): Promise<FunnelResult<T>> {
    const timeoutMs = opts?.timeoutMs ?? this.slotLockTimeoutMs;
    const prev = this.slotTails.get(slot) ?? Promise.resolve();
    let releaseMine!: () => void;
    const mine = new Promise<void>((resolve) => {
      releaseMine = resolve;
    });
    // I become the new tail immediately — later waiters queue behind `mine`.
    this.slotTails.set(slot, mine);

    // Wait for the previous holder to finish, bounded by the timeout.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    const winner = await Promise.race([prev.then(() => 'acquired' as const), timeout]);
    if (timer) clearTimeout(timer);

    if (winner === 'timeout') {
      // We never acquired the slot. We ARE the registered tail, so release `mine` ONLY after the
      // real prior holder finishes — otherwise the next waiter (queued behind `mine`) could run
      // concurrently with the holder we were waiting on. We never run `fn`.
      void prev.then(
        () => releaseMine(),
        () => releaseMine(),
      );
      return { ran: false, skippedReason: `slot-lock acquire on '${slot}' timed out after ${timeoutMs}ms` };
    }

    try {
      const value = await fn();
      return { ran: true, value };
    } finally {
      releaseMine();
      // GC the tail entry if no later waiter replaced us.
      if (this.slotTails.get(slot) === mine) this.slotTails.delete(slot);
    }
  }

  /**
   * Run `fn` while holding the per-slot locks for ALL `slots`, acquired in a CANONICAL order
   * (sorted by path) so two concurrent multi-slot operations can't deadlock on opposite orders.
   * If ANY slot lock cannot be acquired in time, NO `fn` runs and the result is skipped (the
   * already-held inner locks are released by unwinding). Used by the swap executor (Step 5).
   */
  async withSlotLocks<T>(
    slots: string[],
    fn: () => Promise<T> | T,
    opts?: { timeoutMs?: number },
  ): Promise<FunnelResult<T>> {
    const ordered = Array.from(new Set(slots)).sort();
    const acquire = async (i: number): Promise<FunnelResult<T>> => {
      if (i >= ordered.length) {
        const value = await fn();
        return { ran: true, value };
      }
      const inner = await this.withSlotLock(ordered[i], () => acquire(i + 1), opts);
      // If the inner acquire was skipped (timeout deeper in the chain), propagate the skip.
      if (!inner.ran) return { ran: false, skippedReason: inner.skippedReason };
      return inner.value as FunnelResult<T>;
    };
    return acquire(0);
  }

  /**
   * Run `fn` holding the machine-local single-mover mutex. A swap takes this BEFORE its slot
   * locks so two swaps never run at once. Try-acquire: if a move is already in flight, `fn`
   * does NOT run and the result is skipped (never blocks).
   */
  async withSingleMover<T>(fn: () => Promise<T> | T): Promise<FunnelResult<T>> {
    if (this.singleMoverHeld) {
      return { ran: false, skippedReason: 'another credential move is already in flight (single-mover mutex held)' };
    }
    this.singleMoverHeld = true;
    try {
      const value = await fn();
      return { ran: true, value };
    } finally {
      this.singleMoverHeld = false;
    }
  }

  /** Test/observability: is the single-mover mutex currently held? */
  isSingleMoverHeld(): boolean {
    return this.singleMoverHeld;
  }

  /** Test/observability: how many slots currently have a live lock queue tail. */
  get trackedSlotCount(): number {
    return this.slotTails.size;
  }
}

/**
 * Process-wide shared funnel singleton (Step 4b). Every in-process credential writer — the
 * QuotaPoller refresh path (via `refreshClaudeToken`), the AccountSwitcher write (via
 * `writeCredentialsSerialized`), and the swap executor (Step 5) — routes through THIS instance so
 * a refresh write and a swap on the same slot share one per-slot lock and can never interleave.
 * In-memory ⇒ a process restart clears any crash-stale hold. Tests inject their own instance.
 */
export const credentialWriteFunnel = new CredentialWriteFunnel();

/**
 * Thrown by a void-returning serialized writer when the per-slot lock could not be acquired in
 * time (the funnel SKIPPED the write rather than wedging). It is a transient "busy, retry" signal
 * — NEVER a credential failure: callers must not treat it as a dead login / needs-reauth.
 */
export class CredentialWriteSkippedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'CredentialWriteSkippedError';
  }
}
