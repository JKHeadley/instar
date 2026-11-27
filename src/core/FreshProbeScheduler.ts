/**
 * FreshProbeScheduler — when to run a fresh-login probe for an account, and which result may be used
 * (spec docs/specs/stale-process-login-expired.md, D1b).
 *
 * It decides only WHEN evidence is gathered and WHICH completed result is still current. It never
 * decides what a verdict means for pool status: the QuotaPoller does that.
 *
 * Brakes (Bounded Blast Radius / No Unbounded Loops):
 *  - at most MAX_SPAWNS_PER_WINDOW spawns per account per rolling SPAWN_WINDOW_MS, whatever the verdicts;
 *  - a conclusive verdict (ok / refused) is final for its credential until the credential changes,
 *    contrary evidence arrives (ok only), or VERDICT_TTL_MS passes;
 *  - non-conclusive spawned results back off 30 → 60 → 120 → 240 min; after BREAKER_AFTER in a row the
 *    breaker trips for BREAKER_MS or until the credential changes;
 *  - one probe in flight per account (the promise is shared by every caller).
 * A spawn is reserved (persisted through a serial queue, atomically) inside the spawn cap's admitted
 * callback and before the process starts, so a restart or concurrent reservations can never drop a
 * spawn from the ceiling, and a shed reserves nothing.
 */

import type { FreshProbeResult } from './freshLoginProbe.js';

export const MAX_SPAWNS_PER_WINDOW = 6;
export const SPAWN_WINDOW_MS = 12 * 60 * 60_000;
export const VERDICT_TTL_MS = 12 * 60 * 60_000;
export const BACKOFF_STEPS_MS = [30, 60, 120, 240].map((m) => m * 60_000);
export const BREAKER_AFTER = 4;
export const BREAKER_MS = 24 * 60 * 60_000;
export const SHED_RETRY_MS = 5 * 60_000;

export interface PersistedAccountState {
  spawns: number[];
  consecutiveInconclusive: number;
  breakerUntil: number | null;
  breakerFingerprint: string | null;
}
export type PersistedState = Record<string, PersistedAccountState>;

export interface CachedVerdict { verdict: 'ok' | 'refused'; fingerprint: string; at: number }

export type ProbeDisposition = 'ok' | 'refused' | 'pending' | 'inconclusive';

export interface SchedulerDeps {
  now: () => number;
  /**
   * Runs one probe on the account's routed folder, through the host spawn cap. It must call `reserve()`
   * INSIDE the cap's admitted callback, immediately before spawning, and spawn only if it resolves true.
   * A shed never calls `reserve()` and returns `{ verdict: 'not-run', reason: 'spawn-cap-shed' }`.
   */
  probe: (accountId: string, reserve: () => Promise<boolean>) => Promise<FreshProbeResult>;
  /** Current routed-slot credential fingerprint (null when unreadable). */
  fingerprint: (accountId: string) => string | null;
  /** Live switch, read on every decision. */
  enabled: () => boolean;
  load: () => PersistedState;
  /** Atomic replace of the whole state. Called only through the scheduler's serial queue. */
  persist: (state: PersistedState) => Promise<void>;
  onRan?: (accountId: string, result: FreshProbeResult) => void;
  /** Called after a result passed validation and was cached (the poller applies D3 here). */
  onVerdict?: (accountId: string, verdict: 'ok' | 'refused') => void;
  onBreaker?: (accountId: string) => void;
  log?: (msg: string) => void;
}

interface InFlight { promise: Promise<void>; startedAt: number; fingerprint: string }

export class FreshProbeScheduler {
  private state: PersistedState;
  private readonly cache = new Map<string, CachedVerdict>();
  private readonly lastContraryAt = new Map<string, number>();
  private readonly lastShedAt = new Map<string, number>();
  private readonly inFlight = new Map<string, InFlight>();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly deps: SchedulerDeps) {
    try { this.state = deps.load() ?? {}; } catch { this.state = {}; } // @silent-fallback-ok: an unreadable state file starts empty; the ceiling then counts from now
  }

  /** Contrary evidence against a cached `ok` for this account (a fresh process failed, a 401 read). */
  noteContrary(accountId: string): void {
    this.lastContraryAt.set(accountId, this.deps.now());
    const c = this.cache.get(accountId);
    if (c && c.verdict === 'ok') this.cache.delete(accountId);
  }

  /** A cached conclusive verdict for the CURRENT credential, if still valid and the switch is on. */
  cached(accountId: string): CachedVerdict | null {
    if (!this.deps.enabled()) return null;
    const c = this.cache.get(accountId);
    if (!c) return null;
    const fp = this.deps.fingerprint(accountId);
    if (!fp || fp !== c.fingerprint || this.deps.now() - c.at >= VERDICT_TTL_MS) { this.cache.delete(accountId); return null; }
    return c;
  }

  isInFlight(accountId: string): boolean { return this.inFlight.has(accountId); }

  /**
   * Get a disposition for this account: a cached verdict, or (when allowed) start/join a probe and wait
   * up to `waitMs`. `start: false` only joins a probe already running.
   */
  async evaluate(accountId: string, opts: { waitMs: number; start: boolean }): Promise<ProbeDisposition> {
    if (!this.deps.enabled()) return 'inconclusive';
    const hit = this.cached(accountId);
    if (hit) return hit.verdict;
    let flight = this.inFlight.get(accountId);
    if (!flight && opts.start) flight = await this.tryStart(accountId) ?? undefined;
    if (!flight) return 'inconclusive';
    if (opts.waitMs > 0) {
      await Promise.race([flight.promise, new Promise((r) => setTimeout(r, opts.waitMs))]);
    }
    const after = this.cached(accountId);
    if (after) return after.verdict;
    return this.inFlight.has(accountId) ? 'pending' : 'inconclusive';
  }

  private acct(accountId: string): PersistedAccountState {
    const a = this.state[accountId] ?? { spawns: [], consecutiveInconclusive: 0, breakerUntil: null, breakerFingerprint: null };
    this.state[accountId] = a;
    return a;
  }

  private nextAllowedAt(a: PersistedAccountState): number {
    if (a.consecutiveInconclusive <= 0 || a.spawns.length === 0) return 0;
    const step = BACKOFF_STEPS_MS[Math.min(a.consecutiveInconclusive - 1, BACKOFF_STEPS_MS.length - 1)];
    return a.spawns[a.spawns.length - 1] + step;
  }

  private queueWrite(): Promise<void> {
    const snapshot = JSON.parse(JSON.stringify(this.state)) as PersistedState;
    const next = this.writeChain.then(() => this.deps.persist(snapshot));
    this.writeChain = next.catch(() => { /* @silent-fallback-ok: a failed write is retried with the next state change */ });
    return next;
  }

  private async tryStart(accountId: string): Promise<InFlight | null> {
    const now = this.deps.now();
    const fp = this.deps.fingerprint(accountId);
    if (!fp) return null;
    const a = this.acct(accountId);
    a.spawns = a.spawns.filter((t) => now - t < SPAWN_WINDOW_MS);
    if (a.breakerUntil !== null) {
      if (now < a.breakerUntil && a.breakerFingerprint === fp) return null;
      a.breakerUntil = null; a.breakerFingerprint = null; a.consecutiveInconclusive = 0;
    }
    if (a.spawns.length >= MAX_SPAWNS_PER_WINDOW) return null;
    if (now < this.nextAllowedAt(a)) return null;
    const shed = this.lastShedAt.get(accountId);
    if (shed !== undefined && now - shed < SHED_RETRY_MS) return null;
    if (this.inFlight.has(accountId)) return this.inFlight.get(accountId)!;
    let resolveSlot!: () => void;
    const flight: InFlight = { promise: new Promise<void>((r) => { resolveSlot = r; }), startedAt: now, fingerprint: fp };
    this.inFlight.set(accountId, flight);
    void this.run(accountId, flight).finally(() => { this.inFlight.delete(accountId); resolveSlot(); });
    return flight;
  }

  /** Reserve one spawn durably. Called by the probe inside the spawn cap's admitted callback. */
  private async reserve(accountId: string): Promise<boolean> {
    const now = this.deps.now();
    const a = this.acct(accountId);
    a.spawns = a.spawns.filter((t) => now - t < SPAWN_WINDOW_MS);
    if (a.spawns.length >= MAX_SPAWNS_PER_WINDOW) return false;
    a.spawns.push(now);
    try { await this.queueWrite(); return true; }
    catch { // @silent-fallback-ok: no committed reservation, no spawn
      const i = a.spawns.lastIndexOf(now);
      if (i >= 0) a.spawns.splice(i, 1);
      return false;
    }
  }

  private async run(accountId: string, flight: InFlight): Promise<void> {
    let result: FreshProbeResult;
    let reserved = false;
    try { result = await this.deps.probe(accountId, async () => { reserved = await this.reserve(accountId); return reserved; }); }
    catch { result = { verdict: 'unavailable', reason: 'probe-threw' }; } // @silent-fallback-ok: a throwing probe concludes nothing
    try { this.deps.onRan?.(accountId, result); } catch { /* @silent-fallback-ok: metrics must not break the probe */ }
    const a = this.acct(accountId);
    if (!reserved) {
      // Never spawned (a shed, or the reservation could not commit): no counters, a short retry floor.
      this.lastShedAt.set(accountId, this.deps.now());
      return;
    }
    // Validate BEFORE caching: credential, switch, and contrary evidence since the probe started.
    const fpNow = this.deps.fingerprint(accountId);
    const contrary = this.lastContraryAt.get(accountId) ?? -Infinity;
    const current = this.deps.enabled() && fpNow === flight.fingerprint && flight.startedAt >= contrary;
    if (result.verdict === 'ok' || result.verdict === 'refused') {
      if (current) {
        a.consecutiveInconclusive = 0;
        this.cache.set(accountId, { verdict: result.verdict, fingerprint: flight.fingerprint, at: this.deps.now() });
        try { this.deps.onVerdict?.(accountId, result.verdict); } catch { /* @silent-fallback-ok: the cached verdict stands; the next poll applies it */ }
      } else {
        // A discarded result changes no counters (spec D1a/D1b).
        this.deps.log?.(`[FreshProbe] ${accountId}: stale-probe-result discarded (${result.verdict})`);
      }
    } else {
      a.consecutiveInconclusive += 1;
      if (a.consecutiveInconclusive >= BREAKER_AFTER) {
        a.breakerUntil = this.deps.now() + BREAKER_MS;
        a.breakerFingerprint = flight.fingerprint;
        try { this.deps.onBreaker?.(accountId); } catch { /* @silent-fallback-ok: reporting only */ }
      }
    }
    await this.queueWrite().catch(() => {});
  }
}
