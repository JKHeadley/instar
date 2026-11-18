/**
 * PinThrottle (docs/specs/dashboard-pin-throttle.md) — the in-memory brute-force brake and
 * owner-alert layer in front of the durable PinAttemptStore for the dashboard PIN unlock.
 *
 * Design (b), the operator-ratified pattern (echo-chief-of-staff, 2026-11-15): a KNOWN browser is
 * always let in; UNKNOWN sources share a HARD cap that actually bounds distributed guessing; and a
 * never-seen browser caught behind that cap during a live attack recovers OUT OF BAND (the agent
 * runs on the owner's own machine — local dashboard, the paired phone app, the token on disk).
 *
 *   - **Marked (prior-unlock cookie) → always admitted.** Checked FIRST, before any brake, so a
 *     returning owner reaches the PIN check instantly even while sharing a public IP (NAT/CGNAT,
 *     /64) with an active attacker. A marker is honored until that source abuses it past
 *     `markedAbuseCap` failures, after which the marker is ignored for that source (a leaked or
 *     stolen cookie cannot brute-force unboundedly). The PIN is still required — a marker alone
 *     unlocks nothing.
 *   - **Unmarked → a HARD global failure budget.** Unmarked FAILURES across all sources consume one
 *     shared budget per window; once drained, further unmarked attempts are REFUSED for the window.
 *     This is the real brute-force bound an address-rotating botnet cannot evade (rotating to fresh
 *     addresses does not refill a global budget). The accepted cost: a brand-new unmarked browser
 *     during a saturating attack is refused and recovers out of band — the owner is alerted and is
 *     never truly locked out (the machine itself still works).
 *   - **Secondary brakes:** per-source exponential backoff (a single hammering source slows fast,
 *     and its backoff does not reset at the window boundary), and a coarse per-/48 (IPv6) / per-/24
 *     (IPv4) failure budget so one routed allocation cannot multiply its share by sub-address churn.
 *
 * Pure and clock-injected. The caller passes an already-normalized source key (normalizePinSource).
 */

export interface PinThrottleConfig {
  /** Misses from one UNMARKED source before its exponential backoff begins. */
  softFailures: number;
  /** Misses before backoff for a MARKED source — gentler, so an owner fat-fingering a known browser is not slowed. */
  markedSoftFailures: number;
  /** Marked FAILURES for one cookie id before its marker stops being honored (bounds a leaked/stolen cookie). */
  markedAbuseCap: number;
  baseMs: number;
  maxBackoffMs: number;
  windowMs: number;
  /** HARD global UNMARKED failure budget per window; once drained, further unmarked attempts are refused. */
  globalFailureBudget: number;
  /** Per coarse-network (/48 IPv6, /24 IPv4) UNMARKED failure budget per window. */
  coarseFailureBudget: number;
  alertCooldownMs: number;
  maxSources: number;
}

export const DEFAULT_PIN_THROTTLE_CONFIG: PinThrottleConfig = {
  softFailures: 3,
  markedSoftFailures: 8,
  markedAbuseCap: 50,
  baseMs: 2_000,
  maxBackoffMs: 15 * 60_000,
  windowMs: 5 * 60_000,
  globalFailureBudget: 20,
  coarseFailureBudget: 10,
  alertCooldownMs: 30 * 60_000,
  maxSources: 4096,
};

export interface PinThrottleDecision {
  allow: boolean;
  retryAfterSeconds?: number;
  reason?: 'source-backoff' | 'marker-backoff' | 'global-cap' | 'coarse-cap';
}

export interface PinThrottleAlert {
  /** 'global-cap' = the hard unmarked budget is drained (owner should use out-of-band access). */
  kind: 'global-cap';
  failures: number;
}

interface Entry { failures: number; blockedUntil: number; lastAttempt: number; }
interface CoarseEntry { failures: number; lastAttempt: number; }

/** Reduce a client address to a throttle key: IPv6 collapses to its /64; IPv4 and non-IPs pass (truncated). */
export function normalizePinSource(addr: string): string {
  let a = (addr ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!a) return 'unknown';
  // Strip an IPv4-mapped prefix so ::ffff:1.2.3.4 is keyed as the IPv4 address.
  const mapped = a.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) a = mapped[1];
  if (a.includes(':')) {
    // IPv6 (possibly with a trailing dotted-quad). Expand :: and canonicalize each hextet.
    let tail: string[] = [];
    let head = a;
    const dot = a.lastIndexOf(':');
    if (a.slice(dot + 1).includes('.')) {
      // trailing IPv4 → two hextets
      const quad = a.slice(dot + 1).split('.').map((n) => parseInt(n, 10) & 0xff);
      tail = [((quad[0] << 8) | quad[1]).toString(16), ((quad[2] << 8) | quad[3]).toString(16)];
      head = a.slice(0, dot);
    }
    const parts = head.split('::');
    let hextets: string[];
    if (parts.length === 2) {
      const left = parts[0] ? parts[0].split(':').filter((x) => x !== '') : [];
      const right = parts[1] ? parts[1].split(':').filter((x) => x !== '') : [];
      const fill = Array(Math.max(0, 8 - left.length - right.length - tail.length)).fill('0');
      hextets = [...left, ...fill, ...right, ...tail];
    } else {
      hextets = [...head.split(':').filter((x) => x !== ''), ...tail];
    }
    // Canonicalize: strip leading zeros so 0db8 and db8 are the same key. Keep the /64 (first 4).
    const canon = hextets.slice(0, 4).map((h) => (parseInt(h || '0', 16) || 0).toString(16));
    while (canon.length < 4) canon.push('0');
    return 'v6/' + canon.join(':');
  }
  return a.slice(0, 64);
}

/** The coarse network of a normalized source: IPv6 /48 (first 3 hextets), IPv4 /24 (first 3 octets).
 *  A single routed allocation is ONE coarse key, so an attacker who owns a network cannot multiply
 *  its guess budget by rotating sub-addresses within it. */
export function coarsePinNetwork(normalizedSource: string): string {
  if (normalizedSource.startsWith('v6/')) {
    return 'v6c/' + normalizedSource.slice(3).split(':').slice(0, 3).join(':');
  }
  const m = normalizedSource.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/);
  if (m) return `v4c/${m[1]}.${m[2]}.${m[3]}`;
  return 'c/' + normalizedSource;
}

function sanitize(c: Partial<PinThrottleConfig> | undefined): PinThrottleConfig {
  const d = DEFAULT_PIN_THROTTLE_CONFIG;
  const num = (v: unknown, def: number, min: number) =>
    typeof v === 'number' && Number.isFinite(v) && v >= min ? v : def;
  return {
    softFailures: num(c?.softFailures, d.softFailures, 1),
    markedSoftFailures: num(c?.markedSoftFailures, d.markedSoftFailures, 1),
    markedAbuseCap: num(c?.markedAbuseCap, d.markedAbuseCap, 1),
    baseMs: num(c?.baseMs, d.baseMs, 100),
    maxBackoffMs: num(c?.maxBackoffMs, d.maxBackoffMs, 1_000),
    windowMs: num(c?.windowMs, d.windowMs, 1_000),
    globalFailureBudget: num(c?.globalFailureBudget, d.globalFailureBudget, 1),
    coarseFailureBudget: num(c?.coarseFailureBudget, d.coarseFailureBudget, 1),
    alertCooldownMs: num(c?.alertCooldownMs, d.alertCooldownMs, 1_000),
    maxSources: num(c?.maxSources, d.maxSources, 16),
  };
}

export class PinThrottle {
  private readonly cfg: PinThrottleConfig;
  /** IP-keyed state for UNMARKED (stranger) traffic. */
  private readonly sources = new Map<string, Entry>();
  /** marker-id-keyed state for KNOWN-browser traffic — so a leaked cookie is bounded by its OWN
   *  failures across any addresses, and a real owner behind a shared IP is never blocked by it. */
  private readonly markers = new Map<string, Entry>();
  private readonly coarse = new Map<string, CoarseEntry>();
  private globalUnmarkedFailures = 0;
  private globalResetAt = 0;
  private lastAlertAt = 0;

  constructor(config?: Partial<PinThrottleConfig>) {
    this.cfg = sanitize(config);
  }

  /** True iff a marker id should still be honored (not abused past its own cap). Each cookie is judged
   *  in isolation — one stolen cookie never affects another browser's marker — and a marker can only
   *  be minted by a correct PIN, so the per-id abuse cap + its own backoff is the full bound. */
  private markerHonored(markerId: string): boolean {
    const m = this.markers.get(markerId);
    return !m || m.failures < this.cfg.markedAbuseCap;
  }

  /** Read-only: whether a verified marker id is still honoured (not abused past its own cap). */
  isMarkerHonored(markerId: string): boolean { return this.markerHonored(markerId); }

  /** Decide whether this attempt reaches the PIN check, BEFORE the PIN is compared. A blocked
   *  attempt is refused without comparing the PIN (no success oracle, a real limit). `markerId` is
   *  the verified prior-unlock cookie id, or null for an unmarked request. */
  consult(source: string, markerId: string | null, now: number): PinThrottleDecision {
    this.roll(now);
    // A KNOWN browser is judged on its own marker id, not the shared IP — so an owner behind a NAT
    // shared with an attacker is never blocked by the attacker's IP failures, while a stolen cookie
    // stays under ITS OWN (gentle) backoff and the marked budgets.
    if (markerId && this.markerHonored(markerId)) {
      const m = this.markers.get(markerId);
      if (m && m.blockedUntil > now) {
        m.lastAttempt = now;
        return { allow: false, retryAfterSeconds: Math.ceil((m.blockedUntil - now) / 1000), reason: 'marker-backoff' };
      }
      return { allow: true };
    }
    // UNMARKED (or an abused marker): IP-keyed backoff, then the hard stranger caps.
    const e = this.sources.get(source);
    if (e && e.blockedUntil > now) {
      e.lastAttempt = now; // a refused attempt keeps the entry alive so backoff does not reset
      return { allow: false, retryAfterSeconds: Math.ceil((e.blockedUntil - now) / 1000), reason: 'source-backoff' };
    }
    // HARD global bound: once the shared unmarked budget is drained, refuse further unmarked
    // attempts for the window. This is the brute-force bound an address-rotating botnet cannot evade.
    if (this.globalUnmarkedFailures >= this.cfg.globalFailureBudget) {
      return { allow: false, retryAfterSeconds: Math.ceil((this.globalResetAt - now) / 1000), reason: 'global-cap' };
    }
    const cc = this.coarse.get(coarsePinNetwork(source));
    if (cc && cc.failures >= this.cfg.coarseFailureBudget) {
      return { allow: false, retryAfterSeconds: Math.ceil((this.globalResetAt - now) / 1000), reason: 'coarse-cap' };
    }
    return { allow: true };
  }

  recordFailure(source: string, markerId: string | null, now: number): { alert?: PinThrottleAlert } {
    this.roll(now);
    const honored = !!markerId && this.markerHonored(markerId);
    if (honored && markerId) {
      // Track the KNOWN browser by its marker id: its own gentle backoff + the global marked budget.
      const m = this.touch(this.markers, markerId, now);
      m.failures += 1;
      if (m.failures >= this.cfg.markedSoftFailures) {
        const steps = m.failures - this.cfg.markedSoftFailures;
        m.blockedUntil = now + Math.min(this.cfg.baseMs * 2 ** steps, this.cfg.maxBackoffMs);
      }
      return {};
    }
    // UNMARKED (or abused marker): IP-keyed backoff + the hard unmarked & coarse budgets.
    const e = this.touch(this.sources, source, now);
    e.failures += 1;
    const soft = this.cfg.softFailures;
    if (e.failures >= soft) {
      const steps = e.failures - soft;
      e.blockedUntil = now + Math.min(this.cfg.baseMs * 2 ** steps, this.cfg.maxBackoffMs);
    }
    this.globalUnmarkedFailures += 1;
    const ck = coarsePinNetwork(source);
    const cc = this.coarse.get(ck) ?? this.addCoarse(ck, now);
    cc.failures += 1;
    cc.lastAttempt = now;
    // Alert ONLY when the hard cap is reached — the "an attack is draining the cap, use a known
    // browser or the machine" signal. A single hammering source is handled silently by backoff.
    // Deduped by cooldown, downstream of the self-healing cap (Self-Heal Before Notify).
    if (this.globalUnmarkedFailures >= this.cfg.globalFailureBudget && now - this.lastAlertAt >= this.cfg.alertCooldownMs) {
      this.lastAlertAt = now;
      return { alert: { kind: 'global-cap', failures: this.globalUnmarkedFailures } };
    }
    return {};
  }

  /** A correct PIN clears the source's IP backoff and (if present) the marker's backoff; the global
   *  and coarse budgets are NOT reset (a success does not hand an attacker a fresh budget). */
  recordSuccess(source: string, markerId: string | null): void {
    this.sources.delete(source);
    if (markerId) this.markers.delete(markerId);
  }

  size(): number { return this.sources.size + this.markers.size; }

  private roll(now: number): void {
    if (now >= this.globalResetAt) { this.globalUnmarkedFailures = 0; this.globalResetAt = now + this.cfg.windowMs; }
    for (const map of [this.sources, this.markers]) {
      for (const [k, v] of map) {
        // Expire only after a QUIET period since the last attempt (not since first contact) and the
        // block has ended — so a source that keeps attempting never resets its growing backoff.
        if (now - v.lastAttempt >= this.cfg.windowMs && v.blockedUntil <= now) map.delete(k);
      }
    }
    for (const [k, v] of this.coarse) {
      if (now - v.lastAttempt >= this.cfg.windowMs) this.coarse.delete(k);
    }
  }

  private touch(map: Map<string, Entry>, key: string, now: number): Entry {
    let e = map.get(key);
    if (!e) {
      this.evictIfFull(map, now);
      e = { failures: 0, blockedUntil: 0, lastAttempt: now };
      map.set(key, e);
    }
    e.lastAttempt = now;
    return e;
  }

  private addCoarse(key: string, now: number): CoarseEntry {
    if (this.coarse.size >= this.cfg.maxSources) {
      let victim: string | null = null, oldest = Infinity;
      for (const [k, v] of this.coarse) if (v.lastAttempt < oldest) { oldest = v.lastAttempt; victim = k; }
      if (victim) this.coarse.delete(victim);
    }
    const e: CoarseEntry = { failures: 0, lastAttempt: now };
    this.coarse.set(key, e);
    return e;
  }

  private evictIfFull(map: Map<string, Entry>, now: number): void {
    if (map.size < this.cfg.maxSources) return;
    // Prefer to evict the least-recently-active UNBLOCKED entry (never reset an active attacker's
    // backoff). But maxSources is a HARD bound (unbounded state on a public endpoint is a DoS), so
    // if every entry is blocked we evict the least-recently-active one anyway — resetting a single
    // stale guesser's backoff is a bounded, acceptable cost, and the hard global cap still holds.
    let unblocked: string | null = null, un = Infinity;
    let any: string | null = null, an = Infinity;
    for (const [k, v] of map) {
      if (v.lastAttempt < an) { an = v.lastAttempt; any = k; }
      if (v.blockedUntil <= now && v.lastAttempt < un) { un = v.lastAttempt; unblocked = k; }
    }
    const victim = unblocked ?? any;
    if (victim) map.delete(victim);
  }
}
