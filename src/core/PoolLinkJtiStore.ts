/**
 * PoolLinkJtiStore — the single-use replay defense for WS4.4 pool-link
 * assertions (MULTI-MACHINE-SEAMLESSNESS-SPEC §WS4.4 e). SECURITY-SENSITIVE.
 *
 * Lives on the HOLDER machine. When a fronting machine proxies a `/view/:id`
 * request with a signed, audience-bound assertion, the holder verifies it
 * (PoolLinkAssertion.verifyPoolLinkAssertion) and then RECORDS its jti here so
 * the SAME assertion can never be accepted twice. The recorded set is PERSISTED
 * so a captured assertion cannot be replayed even across a holder restart,
 * within its (short) TTL window.
 *
 * Mirrors StreamTicketStore's factoring: pure + injected (clock, fs path) so the
 * record / replay-detect / expiry / replay-across-restart lifecycle is
 * deterministically unit-testable.
 */
import fs from 'node:fs';
import path from 'node:path';

interface JtiRecord {
  /** ms epoch when this jti's assertion expired (after which retention GC may drop it). */
  expiresAtMs: number;
}

interface StoreFileShape {
  version: 1;
  jtis: Record<string, JtiRecord>;
}

export interface PoolLinkJtiStoreDeps {
  /** Absolute path to the persistence file. */
  filePath: string;
  now: () => number;
  /**
   * How long a recorded jti is retained for replay rejection (ms). MUST be ≥ the
   * assertion TTL so a captured assertion can never outlive its retention. Default 1h.
   */
  retentionMs?: number;
  /**
   * Hard ceiling on the number of recorded jtis. A registered-but-misbehaving
   * peer could otherwise mint many distinct-jti assertions and grow this store
   * unboundedly (memory + disk DoS). At the cap, the oldest-expiry records are
   * evicted to make room (they are the closest to GC anyway) and a loss counter
   * is bumped. Default 100_000. (P19 — bounded by construction.)
   */
  maxEntries?: number;
  logger?: (line: string) => void;
}

const DEFAULT_RETENTION_MS = 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 100_000;

export class PoolLinkJtiStore {
  private jtis = new Map<string, JtiRecord>();
  private loaded = false;
  /** Count of records evicted to stay under maxEntries — observability. */
  private droppedForCap = 0;

  constructor(private readonly d: PoolLinkJtiStoreDeps) {}

  private retention(): number {
    return this.d.retentionMs ?? DEFAULT_RETENTION_MS;
  }

  private maxEntries(): number {
    return this.d.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (fs.existsSync(this.d.filePath)) {
        const body = JSON.parse(fs.readFileSync(this.d.filePath, 'utf-8')) as StoreFileShape;
        if (body && body.jtis) {
          for (const [j, r] of Object.entries(body.jtis)) {
            if (r && typeof r.expiresAtMs === 'number') {
              this.jtis.set(j, { expiresAtMs: r.expiresAtMs });
            }
          }
        }
      }
    } catch (e) {
      // @silent-fallback-ok: a corrupt store FAILS CLOSED on the replay window
      // only (loses recorded jtis), never crashes the serve path. The widened
      // window is bounded by the assertion TTL (a re-presented jti's assertion
      // fails 'expired' anyway once its short exp passes). Mirrors
      // StreamTicketStore; logged with context, not a DegradationReporter case.
      this.d.logger?.(`[pool-link-jti] store unreadable, starting empty: ${(e as Error)?.message ?? e}`);
      this.jtis.clear();
    }
    this.gc();
  }

  /** Has this jti already been seen (replay)? Read-only; does not record. */
  seen(jti: string): boolean {
    this.ensureLoaded();
    const rec = this.jtis.get(jti);
    if (!rec) return false;
    // A record past retention is GC-eligible but, while present, still blocks
    // replay. (Its assertion is long-expired, so this is belt-and-suspenders.)
    return true;
  }

  /**
   * Record a jti as consumed, bound to the assertion's expiry. Idempotent: a
   * second record of the same jti is a no-op (the first already blocks replay).
   * Persists BEFORE returning so a crash mid-record cannot yield a second accept.
   */
  record(jti: string, assertionExpMs: number): void {
    this.ensureLoaded();
    this.gc();
    if (this.jtis.has(jti)) return;
    // Clamp the retained expiry to now + retention. Defense-in-depth: even if a
    // far-future `exp` slipped past the holder's TTL-span ceiling, gc() (which
    // keys off expiresAtMs) reliably drops this record within the retention
    // window instead of pinning it for the attacker-chosen span.
    const maxExpiry = this.d.now() + this.retention();
    const expiresAtMs = Math.min(assertionExpMs, maxExpiry);
    // Enforce the size ceiling: at the cap, evict oldest-expiry records first
    // (closest to GC anyway). Bounded by construction (P19).
    this.enforceCap();
    this.jtis.set(jti, { expiresAtMs });
    this.persist();
  }

  /** Evict oldest-expiry records until below the cap (leaving room for one insert). */
  private enforceCap(): void {
    const cap = this.maxEntries();
    if (this.jtis.size < cap) return;
    const sorted = [...this.jtis.entries()].sort((a, b) => a[1].expiresAtMs - b[1].expiresAtMs);
    const toDrop = this.jtis.size - cap + 1;
    for (let i = 0; i < toDrop && i < sorted.length; i++) {
      this.jtis.delete(sorted[i][0]);
      this.droppedForCap++;
    }
    this.d.logger?.(
      `[pool-link-jti] size cap ${cap} reached — evicted ${toDrop} oldest record(s) (total dropped-for-cap: ${this.droppedForCap})`,
    );
  }

  /** Count of currently-recorded jtis — tests/observability. */
  size(): number {
    this.ensureLoaded();
    return this.jtis.size;
  }

  /** Count of records evicted to stay under the size cap — tests/observability. */
  droppedForCapCount(): number {
    return this.droppedForCap;
  }

  /** Drop records whose expiry is older than the retention window. */
  private gc(): void {
    const cutoff = this.d.now() - this.retention();
    let changed = false;
    for (const [j, r] of this.jtis) {
      if (r.expiresAtMs < cutoff) {
        this.jtis.delete(j);
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  private persist(): void {
    try {
      const dir = path.dirname(this.d.filePath);
      fs.mkdirSync(dir, { recursive: true });
      const jtis: Record<string, JtiRecord> = {};
      for (const [j, r] of this.jtis) jtis[j] = r;
      const body: StoreFileShape = { version: 1, jtis };
      const tmp = `${this.d.filePath}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(body, null, 2));
      fs.renameSync(tmp, this.d.filePath);
    } catch (e) {
      // @silent-fallback-ok: a persistence failure degrades replay-across-restart
      // protection for in-flight jtis only (all TTL-bounded); must not crash the
      // serve path. The in-memory set still blocks replay within this process.
      this.d.logger?.(`[pool-link-jti] persist failed: ${(e as Error)?.message ?? e}`);
    }
  }
}
