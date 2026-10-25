/**
 * PeerEndpointResolver — multi-transport-mesh-comms Layer 1.
 *
 * Pure, I/O-free, injectable (clock + health map). Resolves a peer's advertised
 * endpoint set into an ORDERED, VALIDATED, CAPPED candidate list for the hedged
 * failover transport (Layer 2), and tracks per-(peer,kind,url) health so the order
 * is latency+liveness-aware and a dead rope is deprioritized-but-probed.
 *
 * It NEVER does network I/O — the transport calls `resolve()` to get the order,
 * dials, then calls `recordResult()` to feed health back. Spec:
 * docs/specs/multi-transport-mesh-comms.md (Layers 0.5/1, Decisions 2-8,14,16,17).
 */

import type { MeshEndpoint } from './types.js';

const KIND_PRIORITY_DEFAULT: Record<MeshEndpoint['kind'], number> = {
  tailscale: 10,
  lan: 20,
  cloudflare: 30,
};

/** The health-map key separator (a NUL — a character no machine id or kind can
 *  contain), named so read seams (snapshot) split on it explicitly. */
const KEY_SEP = '\u0000';

/** Decision 4 — the cap is enforced HERE on resolve, never trusted from the advertiser. */
export const MAX_ENDPOINTS = 4;
/** Decision 5 — EWMA smoothing factor for latency + failure-rate. */
const EWMA_ALPHA = 0.3;
/** Decision 5 — demote a sticky rope whose EWMA failure-rate exceeds this. */
const FAILRATE_DEMOTE = 0.25;
/** Decision 5 — a recovered rope must be stable K cycles before reclaiming last-known-good. */
const RECOVERY_HYSTERESIS = 3;
/** Exponential-backoff base for probing a deprioritized (dead) rope. */
const PROBE_BACKOFF_BASE_MS = 5_000;

export interface PeerEndpointResolverConfig {
  enabled: boolean;
  hedgeDelayMs: number;
  priorityTailscale: number;
  priorityLan: number;
  priorityCloudflare: number;
  tailscaleEnabled: boolean;
  lanSubnetGate: boolean;
  unhealthyAfterFailures: number;
  endpointEvictionMs: number;
  maxProbeBackoffMs: number;
  /** The transport's per-attempt timeout — drives the "slow rope" latency demotion (EWMA > timeout/2). */
  requestTimeoutMs: number;
}

export interface PeerEndpointResolverDeps {
  config: PeerEndpointResolverConfig;
  now?: () => number;
  /**
   * This machine's own IPv4 CIDRs (e.g. ['192.168.87.67/24','100.64.165.27/10']),
   * used by the LAN-subnet gate (Decision 8) to skip a peer's LAN IP that is not
   * on a subnet we share. Injected (no `os` import here — stays pure/testable).
   */
  ownCidrs?: () => string[];
  logger?: (msg: string) => void;
}

interface HealthRecord {
  lastOkAt: number;
  lastFailAt: number;
  consecutiveFailures: number;
  /** EWMA of attempt latency (ms). */
  ewmaLatencyMs: number;
  /** EWMA of failure (1=fail,0=ok). */
  ewmaFailRate: number;
  /** consecutive successes since last fail — for recovery hysteresis. */
  recoveryStreak: number;
  /** true once this rope earned last-known-good (cleared on demotion). */
  lastKnownGood: boolean;
  /** the URL last seen advertised for this (peer,kind) — for eviction + change tracking. */
  url: string;
  /** when this (peer,kind) was last seen in an advertised set. */
  lastAdvertisedAt: number;
}

/** A validated candidate the transport should dial, in order. */
export interface ResolvedEndpoint extends MeshEndpoint {
  priority: number;
  lastKnownGood: boolean;
  /** false ⇒ deprioritized (dead) and NOT yet due for a backoff probe — caller may still try it last. */
  dueForAttempt: boolean;
}

/**
 * U4.3 (u4-3-breaker-recovery-probe) — one per-(peer,kind) row of the read seam
 * `snapshot()`. This is the SINGLE health authority's read surface: the recovery
 * prober's eligibility scan, the authed /health `ropeHealth` field, and U4.5's
 * RopeHealthMonitor all consume THIS shape (never a copy of the map). Contains
 * NO URLs/IPs by design — kind + counters only (the content-scrub rule).
 */
export interface RopeHealthSnapshotRow {
  peer: string;
  kind: MeshEndpoint['kind'];
  /** consecutiveFailures >= unhealthyAfterFailures — the dead flag the hedge ordering uses. */
  dead: boolean;
  consecutiveFailures: number;
  recoveryStreak: number;
  lastKnownGood: boolean;
  /** epoch-ms of the last ok/fail result; 0 = never. */
  lastOkAt: number;
  lastFailAt: number;
  ewmaFailRate: number;
  ewmaLatencyMs: number;
}

export class PeerEndpointResolver {
  private readonly cfg: PeerEndpointResolverConfig;
  private readonly now: () => number;
  private readonly ownCidrs: () => string[];
  private readonly log: (m: string) => void;
  /** key = `${peerMachineId}\u0000${kind}\u0000${url}`. URL is load-bearing:
   * an observed endpoint must be able to outrank a dead advertised endpoint of
   * the same transport kind without borrowing its failure record. */
  private readonly health = new Map<string, HealthRecord>();

  constructor(deps: PeerEndpointResolverDeps) {
    this.cfg = deps.config;
    this.now = deps.now ?? Date.now;
    this.ownCidrs = deps.ownCidrs ?? (() => []);
    this.log = deps.logger ?? (() => {});
  }

  private key(peer: string, kind: MeshEndpoint['kind'], url = ''): string {
    return `${peer}${KEY_SEP}${kind}${KEY_SEP}${url}`;
  }

  private priorityOf(kind: MeshEndpoint['kind']): number {
    switch (kind) {
      case 'tailscale':
        return this.cfg.priorityTailscale ?? KIND_PRIORITY_DEFAULT.tailscale;
      case 'lan':
        return this.cfg.priorityLan ?? KIND_PRIORITY_DEFAULT.lan;
      case 'cloudflare':
        return this.cfg.priorityCloudflare ?? KIND_PRIORITY_DEFAULT.cloudflare;
    }
  }

  /**
   * Resolve a peer's advertised endpoints into the ordered candidate list. Pure:
   * validates URL shape per kind, applies the LAN-subnet gate, caps to
   * MAX_ENDPOINTS by priority, and orders last-known-good → priority → dead-last.
   *
   * `advertised` is the peer's signed-heartbeat endpoint set (may be undefined for
   * an un-upgraded peer); `lastKnownUrl` is the legacy single rope (the cloudflare
   * fallback). An un-upgraded peer (no advertised set) resolves to exactly one
   * endpoint from lastKnownUrl — byte-for-byte today's single-rope behavior.
   */
  resolve(
    peerMachineId: string,
    advertised: MeshEndpoint[] | undefined,
    lastKnownUrl: string | undefined,
  ): ResolvedEndpoint[] {
    const nowMs = this.now();

    // 1) Assemble the raw candidate set.
    const raw: MeshEndpoint[] = [];
    const seen = new Set<string>();
    const push = (e: MeshEndpoint) => {
      const k = `${e.kind}\u0000${e.url}`;
      if (!seen.has(k)) {
        seen.add(k);
        raw.push(e);
      }
    };
    if (Array.isArray(advertised)) {
      for (const e of advertised) {
        if (e && typeof e.url === 'string' && (e.kind === 'tailscale' || e.kind === 'lan' || e.kind === 'cloudflare')) {
          push(e);
        }
      }
    }
    // Always include the legacy lastKnownUrl as a cloudflare fallback rope (so an
    // upgraded peer that drops cloudflare from endpoints[] still has the tunnel,
    // and an un-upgraded peer resolves to exactly this one).
    if (lastKnownUrl) push({ kind: 'cloudflare', url: lastKnownUrl });

    // 2) Validate URL shape per kind (Decision 7) + LAN-subnet gate (Decision 8).
    const validated = raw.filter((e) => {
      if (e.kind === 'tailscale' && !this.cfg.tailscaleEnabled) return false;
      const host = hostOf(e.url);
      if (!host) {
        this.log(`drop endpoint (unparseable url) ${e.kind} ${e.url}`);
        return false;
      }
      if (isForbiddenHost(host)) {
        this.log(`drop endpoint (forbidden host) ${e.kind} ${host}`);
        return false;
      }
      if (e.kind === 'tailscale' && !isTailscaleCgnat(host)) {
        this.log(`drop endpoint (tailscale not 100.64/10) ${host}`);
        return false;
      }
      if (e.kind === 'lan') {
        if (!isRfc1918(host)) {
          this.log(`drop endpoint (lan not rfc1918) ${host}`);
          return false;
        }
        if (this.cfg.lanSubnetGate && !this.sharesSubnet(host)) {
          this.log(`drop endpoint (lan different subnet) ${host}`);
          return false;
        }
      }
      if (e.kind === 'cloudflare' && !isPublicHttps(e.url)) {
        this.log(`drop endpoint (cloudflare not public-https) ${e.url}`);
        return false;
      }
      return true;
    });

    // 3) Touch/seed health for surviving endpoints (lastAdvertisedAt for eviction).
    for (const e of validated) {
      const k = this.key(peerMachineId, e.kind, e.url);
      const h = this.health.get(k);
      if (h) {
        h.lastAdvertisedAt = nowMs;
        h.url = e.url;
      } else {
        // Backward-compatible unit/API calls can feed health before resolve()
        // and therefore have no URL. Adopt that generic row into the first
        // concrete endpoint instead of discarding its evidence.
        const genericKey = this.key(peerMachineId, e.kind);
        const generic = this.health.get(genericKey);
        if (generic) {
          this.health.delete(genericKey);
          generic.url = e.url;
          generic.lastAdvertisedAt = nowMs;
          this.health.set(k, generic);
        } else {
          this.health.set(k, this.freshHealth(e.url, nowMs));
        }
      }
    }
    this.evictStale(peerMachineId, nowMs);

    // 4) Order the COMPLETE validated set before applying the cap. Evidence is
    // load-bearing here: priority-first capping can discard a locally observed,
    // corroborated same-kind endpoint merely because four dead advertised URLs
    // appeared first.
    // 5) Order: last-known-good first, then priority; a deprioritized (dead, not
    //    due-for-probe) rope sinks to the back (Decision 5).
    const resolved: ResolvedEndpoint[] = validated.map((e) => {
      const h = this.health.get(this.key(peerMachineId, e.kind, e.url));
      const dead = !!h && h.consecutiveFailures >= this.cfg.unhealthyAfterFailures;
      const dueForAttempt = !dead || this.isProbeDue(h!, nowMs);
      return {
        ...e,
        priority: this.priorityOf(e.kind),
        lastKnownGood: !!h?.lastKnownGood,
        dueForAttempt,
      };
    });

    resolved.sort((a, b) => {
      // due-for-attempt before dead-not-due
      if (a.dueForAttempt !== b.dueForAttempt) return a.dueForAttempt ? -1 : 1;
      const healthTier = (ep: ResolvedEndpoint): number => {
        const h = this.health.get(this.key(peerMachineId, ep.kind, ep.url));
        const advertisedAlive = ep.origin !== 'observed'
          && !!h && h.lastOkAt > 0 && h.lastOkAt >= h.lastFailAt
          && h.consecutiveFailures < this.cfg.unhealthyAfterFailures;
        if (advertisedAlive) return 0;
        if (ep.origin === 'observed') return 1;
        return 2;
      };
      // Normative machine-self-assertion precedence:
      // advertised-alive > observed-corroborated > advertised-dead/unknown.
      const aTier = healthTier(a);
      const bTier = healthTier(b);
      if (aTier !== bTier) return aTier - bTier;
      // last-known-good first within the same evidence tier.
      if (a.lastKnownGood !== b.lastKnownGood) return a.lastKnownGood ? -1 : 1;
      // then by priority
      return a.priority - b.priority;
    });

    // Decision 4's bound applies only after authority/evidence and health have
    // selected the best candidates.
    return resolved.slice(0, MAX_ENDPOINTS);
  }

  /**
   * Feed an attempt outcome back (the transport calls this after each dial). Drives
   * the health-based ordering: EWMA latency/failure, consecutive-failure count,
   * last-known-good with recovery hysteresis + latency demotion.
   */
  recordResult(peerMachineId: string, kind: MeshEndpoint['kind'], ok: boolean, latencyMs: number, url?: string): void {
    let k = url
      ? this.key(peerMachineId, kind, url)
      : this.latestKey(peerMachineId, kind) ?? this.key(peerMachineId, kind);
    const nowMs = this.now();
    let h = this.health.get(k);
    if (!h && url) {
      const genericKey = this.key(peerMachineId, kind);
      const generic = this.health.get(genericKey);
      if (generic) {
        this.health.delete(genericKey);
        generic.url = url;
        k = this.key(peerMachineId, kind, url);
        h = generic;
      }
    }
    h ??= this.freshHealth(url ?? '', nowMs);
    h.ewmaFailRate = EWMA_ALPHA * (ok ? 0 : 1) + (1 - EWMA_ALPHA) * h.ewmaFailRate;
    if (ok) {
      h.lastOkAt = nowMs;
      h.consecutiveFailures = 0;
      h.recoveryStreak += 1;
      if (Number.isFinite(latencyMs) && latencyMs >= 0) {
        h.ewmaLatencyMs = h.ewmaLatencyMs === 0 ? latencyMs : EWMA_ALPHA * latencyMs + (1 - EWMA_ALPHA) * h.ewmaLatencyMs;
      }
      // Latency-aware demotion: a slow-but-alive rope (EWMA > timeout/2) or a
      // high failure-rate rope does NOT earn/keep last-known-good (Decision 5).
      const tooSlow = h.ewmaLatencyMs > this.cfg.requestTimeoutMs / 2;
      const tooFlaky = h.ewmaFailRate > FAILRATE_DEMOTE;
      if (tooSlow || tooFlaky) {
        h.lastKnownGood = false;
      } else if (h.recoveryStreak >= RECOVERY_HYSTERESIS) {
        h.lastKnownGood = true;
      }
    } else {
      h.lastFailAt = nowMs;
      h.consecutiveFailures += 1;
      h.recoveryStreak = 0;
      h.lastKnownGood = false;
    }
    this.health.set(k, h);
  }

  /** Test/inspection helper — current health snapshot for a (peer,kind). */
  healthOf(peerMachineId: string, kind: MeshEndpoint['kind'], url?: string): Readonly<HealthRecord> | undefined {
    const key = url ? this.key(peerMachineId, kind, url) : this.latestKey(peerMachineId, kind);
    return key ? this.health.get(key) : undefined;
  }

  /**
   * U4.3 — the read seam over the WHOLE health map: one row per known
   * (peer, kind), never a live reference (rows are copies; mutating a row can't
   * poison the authority). Served through MultiMachineCoordinator's registration
   * handle into the authed /health `multiMachine.syncStatus.ropeHealth`, and
   * consumed in-process by the RopeRecoveryProber (eligibility) and U4.5's
   * RopeHealthMonitor (classification). URLs deliberately excluded.
   */
  snapshot(): RopeHealthSnapshotRow[] {
    const grouped = new Map<string, { peer: string; kind: MeshEndpoint['kind']; records: HealthRecord[] }>();
    for (const [key, h] of this.health) {
      const parsed = this.parseKey(key);
      if (!parsed) continue;
      const groupKey = `${parsed.peer}${KEY_SEP}${parsed.kind}`;
      const group = grouped.get(groupKey) ?? { peer: parsed.peer, kind: parsed.kind, records: [] };
      group.records.push(h);
      grouped.set(groupKey, group);
    }
    const rows: RopeHealthSnapshotRow[] = [];
    for (const { peer, kind, records } of grouped.values()) {
      const dead = records.every((h) => h.consecutiveFailures >= this.cfg.unhealthyAfterFailures);
      rows.push({
        peer,
        kind,
        dead,
        consecutiveFailures: Math.min(...records.map((h) => h.consecutiveFailures)),
        recoveryStreak: Math.max(...records.map((h) => h.recoveryStreak)),
        lastKnownGood: records.some((h) => h.lastKnownGood),
        lastOkAt: Math.max(...records.map((h) => h.lastOkAt)),
        lastFailAt: Math.max(...records.map((h) => h.lastFailAt)),
        ewmaFailRate: Math.min(...records.map((h) => h.ewmaFailRate)),
        ewmaLatencyMs: Math.min(...records.map((h) => h.ewmaLatencyMs)),
      });
    }
    return rows;
  }

  private freshHealth(url: string, nowMs: number): HealthRecord {
    return {
      lastOkAt: 0,
      lastFailAt: 0,
      consecutiveFailures: 0,
      ewmaLatencyMs: 0,
      ewmaFailRate: 0,
      recoveryStreak: 0,
      lastKnownGood: false,
      url,
      lastAdvertisedAt: nowMs,
    };
  }

  /** A deprioritized (dead) rope is due for a probe on exponential backoff. */
  private isProbeDue(h: HealthRecord, nowMs: number): boolean {
    const overshoot = Math.max(0, h.consecutiveFailures - this.cfg.unhealthyAfterFailures);
    const backoff = Math.min(this.cfg.maxProbeBackoffMs, PROBE_BACKOFF_BASE_MS * 2 ** overshoot);
    return nowMs - h.lastFailAt >= backoff;
  }

  /** Evict per-(peer,kind,url) health for endpoints no longer advertised past the TTL (Decision 4). */
  private evictStale(peerMachineId: string, nowMs: number): void {
    for (const [key, h] of this.health) {
      const parsed = this.parseKey(key);
      if (parsed?.peer === peerMachineId && nowMs - h.lastAdvertisedAt > this.cfg.endpointEvictionMs) this.health.delete(key);
    }
  }

  private parseKey(key: string): { peer: string; kind: MeshEndpoint['kind']; url: string } | null {
    const first = key.indexOf(KEY_SEP);
    const second = key.indexOf(KEY_SEP, first + 1);
    if (first <= 0 || second <= first) return null;
    const kind = key.slice(first + 1, second) as MeshEndpoint['kind'];
    if (kind !== 'tailscale' && kind !== 'lan' && kind !== 'cloudflare') return null;
    return { peer: key.slice(0, first), kind, url: key.slice(second + 1) };
  }

  private latestKey(peer: string, kind: MeshEndpoint['kind']): string | undefined {
    let best: { key: string; at: number } | undefined;
    for (const [key, h] of this.health) {
      const parsed = this.parseKey(key);
      if (parsed?.peer !== peer || parsed.kind !== kind) continue;
      if (!best || h.lastAdvertisedAt >= best.at) best = { key, at: h.lastAdvertisedAt };
    }
    return best?.key;
  }

  /** LAN-subnet gate: does `host` share a subnet with one of our own interfaces? */
  private sharesSubnet(host: string): boolean {
    const target = ipv4ToInt(host);
    if (target === null) return false;
    for (const cidr of this.ownCidrs()) {
      const [base, prefixStr] = cidr.split('/');
      const baseInt = ipv4ToInt(base);
      const prefix = Number(prefixStr);
      if (baseInt === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) continue;
      const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
      if ((target & mask) >>> 0 === (baseInt & mask) >>> 0) return true;
    }
    return false;
  }
}

// ── URL / host validation helpers (pure) ────────────────────────────────────

export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    // @silent-fallback-ok: an unparseable endpoint URL is dropped (never dialed) by the
    // resolver — an invalid advertised rope is data to discard, not a degradation.
    return null;
  }
}

export function ipv4ToInt(host: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1, 5).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/** Tailscale CGNAT range 100.64.0.0/10 (100.64.0.0 – 100.127.255.255). */
export function isTailscaleCgnat(host: string): boolean {
  const ip = ipv4ToInt(host);
  if (ip === null) return false;
  const base = ipv4ToInt('100.64.0.0')!;
  const mask = (0xffffffff << (32 - 10)) >>> 0;
  return (ip & mask) >>> 0 === (base & mask) >>> 0;
}

/** RFC-1918 private ranges (10/8, 172.16/12, 192.168/16). Excludes CGNAT + link-local. */
export function isRfc1918(host: string): boolean {
  const ip = ipv4ToInt(host);
  if (ip === null) return false;
  const inRange = (baseStr: string, prefix: number) => {
    const base = ipv4ToInt(baseStr)!;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (ip & mask) >>> 0 === (base & mask) >>> 0;
  };
  return inRange('10.0.0.0', 8) || inRange('172.16.0.0', 12) || inRange('192.168.0.0', 16);
}

/** Forbidden hosts a mesh rope must never dial (Decision 7): loopback, link-local, metadata, 0.0.0.0. */
export function isForbiddenHost(host: string): boolean {
  if (host === 'localhost' || host === '0.0.0.0' || host === '::1') return true;
  const ip = ipv4ToInt(host);
  if (ip === null) return false; // a non-IPv4 hostname (e.g. cloudflare) is judged elsewhere
  const inRange = (baseStr: string, prefix: number) => {
    const base = ipv4ToInt(baseStr)!;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (ip & mask) >>> 0 === (base & mask) >>> 0;
  };
  // 127/8 loopback, 169.254/16 link-local (incl. 169.254.169.254 metadata), 0/8.
  return inRange('127.0.0.0', 8) || inRange('169.254.0.0', 16) || inRange('0.0.0.0', 8);
}

/** A cloudflare rope must be https:// to a public (non-private, non-IP) host. */
export function isPublicHttps(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // @silent-fallback-ok: an unparseable cloudflare URL fails the public-https shape
    // check (the rope is dropped, never dialed) — invalid input to discard, not a degradation.
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname;
  // Reject private/loopback/IP-literal cloudflare hosts (a real tunnel host is a public DNS name).
  if (ipv4ToInt(host) !== null) return false;
  if (isForbiddenHost(host)) return false;
  return host.includes('.');
}
