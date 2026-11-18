/**
 * GraphPeerReplayGuard — one signed peer request, one effect, every copy answered.
 *
 * A graph peer signs ONE request and offers it to each of the target's installed
 * addresses in turn (Tailscale, home network, tunnel). All of them reach the same
 * server. When the first copy arrives but its answer takes longer than the
 * sender's per-address timeout (the target is busy, e.g. during Accept all), the
 * sender moves on and delivers the SAME signed bytes through the next address.
 *
 * The old guard refused that second copy as a replay. The first copy's work still
 * ran, but its answer went to a sender that had stopped listening, so the
 * confirmation was lost every time the target was slow: "Waiting for Mac M5 Pro
 * to confirm" forever (accept-all round 4, graph-peer-replayed 403s).
 *
 * This guard keeps the replay protection (an exact repeat never runs the work a
 * second time) but answers the repeat with the first copy's outcome, waiting for
 * it while it is still running. A packet that reuses a requestId with different
 * bytes is still refused. When the guard cannot hold an answer (window full, or
 * the answer is too large to keep), it refuses exactly as before.
 */
import { canonicalJson } from '../core/GraphWitnessTypes.js';

interface Entry {
  hash: string;
  at: number;
  /** null once the answer was too large to retain: a repeat is then refused. */
  outcome: Promise<unknown> | null;
  bytes: number;
}

export interface GraphPeerReplayGuardOptions {
  /** How long a request id is remembered. Must cover the sender's issuedAt skew window on both sides. */
  windowMs: number;
  maxEntries: number;
  /** Total bytes of settled answers kept for repeats. */
  maxRetainedBytes: number;
  /** Error message for a refused repeat (kept stable: peers and logs already know it). */
  replayCode: string;
  /** Error message when the window is full of distinct requests. */
  capacityCode: string;
  now?: () => number;
  /** Bytes an answer costs to keep. Callers pass the serialized response they already built, so this is free. */
  sizeOf?: (value: unknown) => number;
}

export class GraphPeerReplayGuard {
  private readonly entries = new Map<string, Entry>();
  private retainedBytes = 0;
  private readonly now: () => number;
  constructor(private readonly options: GraphPeerReplayGuardOptions) {
    this.now = options.now ?? Date.now;
  }

  /**
   * Run `work` once per (key, hash). A repeat with the same hash shares the first
   * outcome (value or refusal); a repeat with a different hash is refused.
   */
  run<T>(key: string, hash: string, work: () => Promise<T>): Promise<T> {
    this.prune();
    const prior = this.entries.get(key);
    if (prior) {
      if (prior.hash !== hash || !prior.outcome) return Promise.reject(new Error(this.options.replayCode));
      return prior.outcome as Promise<T>;
    }
    if (this.entries.size >= this.options.maxEntries) return Promise.reject(new Error(this.options.capacityCode));
    const outcome = Promise.resolve().then(work);
    const entry: Entry = { hash, at: this.now(), outcome, bytes: 0 };
    this.entries.set(key, entry);
    outcome.then(
      (value) => {
        if (this.entries.get(key) !== entry) return;
        let size: number;
        try { size = this.options.sizeOf ? this.options.sizeOf(value) : Buffer.byteLength(canonicalJson(value ?? null)); } catch { size = Number.POSITIVE_INFINITY; }
        if (this.retainedBytes + size > this.options.maxRetainedBytes) { entry.outcome = null; return; }
        entry.bytes = size;
        this.retainedBytes += size;
      },
      () => { /* @silent-fallback-ok: the refusal is kept so an exact repeat is refused the same way; the caller reports it. */ },
    );
    return outcome;
  }

  /** For tests and diagnostics. */
  get size(): number { return this.entries.size; }

  private prune(): void {
    const cutoff = this.now() - this.options.windowMs;
    // Full scan (bounded by maxEntries): a wall clock that steps back must not strand expired ids behind a newer one.
    for (const [key, entry] of this.entries) {
      if (entry.at > cutoff) continue;
      this.retainedBytes -= entry.bytes;
      this.entries.delete(key);
    }
  }
}

