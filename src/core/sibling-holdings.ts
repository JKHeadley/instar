/**
 * Sibling-machine holdings — what each of this agent's OTHER machines holds
 * (signed-in subscription accounts and signed-in browser accounts), kept in
 * memory so the outbound gate's reach can describe them WITHOUT a network call
 * at send time. Spec: docs/specs/sibling-machine-reach.md (CMT-2073).
 *
 * WHY: on 2026-11-20, after the Mac Studio rebuild, four subscription accounts
 * were missing on the Studio but signed in on the Mac Mini. The agent asked its
 * operator to do four sign-ins by hand; the agent reach the gate read described
 * only the Studio, so "this machine lacks it" looked like "the agent lacks it".
 * The real fix was agent work: start the login on the Studio, approve it in the
 * Mini's browser profile signed in to that account.
 *
 * DATA ONLY, NO AUTHORITY. A refresh runs on a timer, off the send path, and
 * reads each peer's own plain routes under the agent's bearer key. Send time
 * reads memory only. Each surface keeps its last SUCCESSFUL read, dated by THIS
 * machine's clock; a failed read never erases or renews evidence. A machine or
 * surface not read recently is UNKNOWN — never "holds nothing". Only labels,
 * emails, providers, normalized login states and browser account names are
 * kept: never a login folder, quota detail, profile path, vault name or credential.
 *
 * @self-action-controller: sibling-holdings-refresh
 * The refresh timer is a self-triggered loop. Its brakes: a fixed 10-minute interval,
 * at most 12 peers dialed per tick, per-peer backoff on a dead peer
 * (`nextSiblingAttemptAtMs`: one 60 s retry for a never-read peer, then 10 → 20 → 40 →
 * 60 minutes, capped at the age limit), long backoff for an off or oversize surface,
 * and the live `enabled` switch read every tick. Modeled in
 * src/testing/selfActionRegistry.ts and proven by tests/unit/self-action-convergence.test.ts.
 */

export type SiblingLogin = 'signed-in' | 'not-signed-in' | 'unknown';

export interface SiblingPoolAccount {
  label: string;
  email?: string;
  provider: string;
  login: SiblingLogin;
}

export interface SiblingBrowserAccount {
  service: string;
  identity: string;
  owner: 'agent' | 'operator';
  /** When the signed-in assertion was last verified on that machine (ISO), if ever. */
  lastVerifiedAt?: string;
}

export type SiblingFailure = 'unreachable' | 'unauthorized' | 'identity-mismatch' | 'surface-off' | 'oversize' | 'peer-too-old';
export type SiblingUnknownReason = 'never-read' | 'stale' | 'no-known-url' | 'offline' | SiblingFailure;

export interface SiblingSurface<T> {
  accounts: T[];
  omitted: number;
  /** Minutes since this surface was last read successfully. */
  ageMinutes: number;
}

export interface SiblingMachineView {
  machineId: string;
  nickname?: string;
  /** The address the browser surface's last identity-checked read used (for the route hint). */
  verifiedAddress?: string;
  /** Undefined = UNKNOWN for that surface (never read, aged out, or off there). */
  pool?: SiblingSurface<SiblingPoolAccount>;
  browser?: SiblingSurface<SiblingBrowserAccount>;
  poolUnknownReason?: SiblingUnknownReason;
  browserUnknownReason?: SiblingUnknownReason;
}

export interface SiblingSnapshot {
  /** Machines with at least one fresh surface. */
  machines: SiblingMachineView[];
  /** Machines with no fresh surface at all. */
  unknown: Array<{ machineId: string; nickname?: string; reason: SiblingUnknownReason }>;
}

export interface SiblingRosterEntry {
  machineId: string;
  nickname?: string;
  /** False when the machine has no dialable URL. */
  dialable: boolean;
  /** False when the pool registry marks it offline. */
  online: boolean;
  /** The admitted dial URL (from resolvePeerUrls), when dialable. */
  address?: string;
}

/** A fetch result: parsed JSON, or a classified failure. */
export type SiblingFetchResult = { ok: true; body: unknown } | { ok: false; failure: SiblingFailure };

export interface SiblingHoldingsCacheOptions {
  /** Local registry read of the other machines (no network). Called at refresh time only. */
  roster: () => SiblingRosterEntry[];
  /** Fetch a peer's route at its admitted address. Must never throw; classify failures instead. */
  fetchJson: (peer: { machineId: string; address: string }, path: string) => Promise<SiblingFetchResult>;
  /** Whether the feature is on right now (read every tick). Default: on. */
  enabled?: () => boolean;
  now?: () => number;
  maxAgeMs?: number;
  intervalMs?: number;
}

export const SIBLING_MAX_ACCOUNTS = 24;
export const SIBLING_DEFAULT_MAX_AGE_MS = 60 * 60_000;
export const SIBLING_DEFAULT_INTERVAL_MS = 10 * 60_000;
/** First retry for a peer that has never been read (e.g. still booting after a rebuild). */
export const SIBLING_FIRST_RETRY_MS = 60_000;
/** Per-refresh fetch bound: more peers than this are read round-robin over refreshes. */
export const SIBLING_MAX_FETCH_PEERS = 12;
/** Largest peer body accepted per surface (a real one is a few KB). */
export const SIBLING_MAX_BODY_BYTES = 256 * 1024;
/** Minimum gap between targeted (verdict-triggered) refreshes. */
export const SIBLING_TARGETED_MIN_GAP_MS = 60_000;

/**
 * The backoff decision for a peer whose reads all failed (pure, for the convergence
 * ratchet): `failures` is the consecutive failure count AFTER this failure. A peer
 * never read before gets one quick retry; after that the gap doubles from one interval
 * up to the age limit. Returns the earliest time of the next attempt.
 */
export function nextSiblingAttemptAtMs(input: {
  nowMs: number;
  failures: number;
  neverRead: boolean;
  intervalMs?: number;
  maxAgeMs?: number;
}): number {
  const intervalMs = input.intervalMs ?? SIBLING_DEFAULT_INTERVAL_MS;
  const maxAgeMs = input.maxAgeMs ?? SIBLING_DEFAULT_MAX_AGE_MS;
  if (input.neverRead && input.failures === 1) return input.nowMs + SIBLING_FIRST_RETRY_MS;
  // Gap 10 → 20 → 40 → 60 min (capped). The tick that lands at or after the gap runs it,
  // so the next attempt is due just past (gap − one interval) from now.
  const gap = Math.min(maxAgeMs, intervalMs * 2 ** Math.max(0, input.failures - 1));
  return input.nowMs + Math.max(0, gap - intervalMs) + 1;
}

function clean(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f<>`]/g, '').trim().slice(0, max);
}

const NOT_SIGNED_IN = new Set(['signed-out', 'needs-reauth', 'revoked', 'expired', 'disabled', 'removed', 'walled', 'error']);

/** Normalize a pool row's lifecycle status + live login signal into a closed set. */
export function normalizePoolLogin(status: unknown, loginCheck: unknown): SiblingLogin {
  const s = typeof status === 'string' ? status : '';
  const l = typeof loginCheck === 'string' ? loginCheck : '';
  if (l === 'signed-out' || NOT_SIGNED_IN.has(s)) return 'not-signed-in';
  if (s === 'active' && l === 'ok') return 'signed-in';
  return 'unknown';
}

const LOGIN_ORDER: Record<SiblingLogin, number> = { 'signed-in': 0, unknown: 1, 'not-signed-in': 2 };

/** Project a peer's plain GET /subscription-pool body. Null when it is not a readable, enabled pool. */
export function projectPoolBody(body: unknown): { accounts: SiblingPoolAccount[]; omitted: number; machineId?: string } | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as { enabled?: unknown; accounts?: unknown };
  if (b.enabled === false) return null; // pool off there → UNKNOWN, never "none"
  if (!Array.isArray(b.accounts)) return null;
  const all: SiblingPoolAccount[] = [];
  for (const raw of b.accounts) {
    if (!raw || typeof raw !== 'object') continue;
    const a = raw as Record<string, unknown>;
    const label = clean(a.nickname, 64) || clean(a.id, 64);
    const provider = clean(a.provider, 32) || clean(a.framework, 32);
    if (!label || !provider) continue;
    const email = clean(a.email, 128);
    all.push({ label, ...(email ? { email } : {}), provider, login: normalizePoolLogin(a.status, a.loginCheck) });
  }
  all.sort((x, y) => LOGIN_ORDER[x.login] - LOGIN_ORDER[y.login] || x.provider.localeCompare(y.provider) || x.label.localeCompare(y.label));
  const responder = clean((body as { machineId?: unknown }).machineId, 128);
  return { accounts: all.slice(0, SIBLING_MAX_ACCOUNTS), omitted: Math.max(0, all.length - SIBLING_MAX_ACCOUNTS), ...(responder ? { machineId: responder } : {}) };
}

/**
 * Project a peer's GET /playwright-profiles(?view=accounts) body. Only accounts
 * asserted signed in are kept. Null when unreadable. Returns the responder's
 * machineId when the body carries one (the light view does).
 */
export function projectProfilesBody(body: unknown): { accounts: SiblingBrowserAccount[]; omitted: number; machineId?: string } | null {
  if (!body || typeof body !== 'object') return null;
  const profiles = (body as { profiles?: unknown }).profiles;
  if (!Array.isArray(profiles)) return null;
  const all: SiblingBrowserAccount[] = [];
  for (const p of profiles) {
    if (!p || typeof p !== 'object') continue;
    const accounts = (p as { accounts?: unknown }).accounts;
    if (!Array.isArray(accounts)) continue;
    for (const raw of accounts) {
      if (!raw || typeof raw !== 'object') continue;
      const a = raw as Record<string, unknown>;
      if (a.lastAsserted !== true) continue;
      const service = clean(a.service, 64);
      const identity = clean(a.identity, 128);
      if (!service || !identity) continue;
      const verified = typeof a.lastVerifiedAt === 'string' && Number.isFinite(Date.parse(a.lastVerifiedAt)) ? new Date(a.lastVerifiedAt).toISOString() : '';
      all.push({ service, identity, owner: a.owner === 'operator' ? 'operator' : 'agent', ...(verified ? { lastVerifiedAt: verified } : {}) });
    }
  }
  all.sort((x, y) => x.service.localeCompare(y.service) || x.identity.localeCompare(y.identity));
  const responder = clean((body as { machineId?: unknown }).machineId, 128);
  return {
    accounts: all.slice(0, SIBLING_MAX_ACCOUNTS),
    omitted: Math.max(0, all.length - SIBLING_MAX_ACCOUNTS),
    ...(responder ? { machineId: responder } : {}),
  };
}

interface StoredSurface<T> { accounts: T[]; omitted: number; observedAtMs: number; verifiedAddress: string }

interface Entry {
  pool?: StoredSurface<SiblingPoolAccount>;
  browser?: StoredSurface<SiblingBrowserAccount>;
  poolFailure?: SiblingFailure;
  browserFailure?: SiblingFailure;
  lastAttemptAtMs?: number;
  consecutiveFailures: number;
  nextAttemptAtMs: number;
  /** Per-surface long backoff for an off / oversize browser surface. */
  browserNextAttemptAtMs?: number;
  /** Set by an identity mismatch on EITHER surface; cleared by a fresh matching browser read. */
  addressInvalid?: boolean;
}

export interface SiblingCacheStatus {
  armed: boolean;
  enabled: boolean;
  lastRefreshAt: string | null;
  machines: Array<{
    machineId: string;
    nickname?: string;
    poolAgeMinutes: number | null;
    browserAgeMinutes: number | null;
    lastFailure: SiblingFailure | 'no-known-url' | 'offline' | null;
  }>;
}

export class SiblingHoldingsCache {
  private readonly entries = new Map<string, Entry>();
  private roster: SiblingRosterEntry[] = [];
  private inFlight: Promise<void> | null = null;
  private cursor = 0;
  private lastRefreshAtMs: number | null = null;
  private lastTargetedAtMs = 0;
  private timers: Array<ReturnType<typeof setTimeout>> = [];
  private armed = false;
  private readonly now: () => number;
  private readonly maxAgeMs: number;
  private readonly intervalMs: number;

  constructor(private readonly opts: SiblingHoldingsCacheOptions) {
    this.now = opts.now ?? Date.now;
    this.maxAgeMs = opts.maxAgeMs ?? SIBLING_DEFAULT_MAX_AGE_MS;
    this.intervalMs = opts.intervalMs ?? SIBLING_DEFAULT_INTERVAL_MS;
  }

  isEnabled(): boolean {
    try {
      return this.opts.enabled ? this.opts.enabled() !== false : true;
    } catch {
      // @silent-fallback-ok — an unreadable switch keeps the default (on); the data is
      // advisory-only and the gate's own fail behavior is unchanged.
      return true;
    }
  }

  /** Arm the background refresh: first run after `firstDelayMs`, then every interval. */
  start(firstDelayMs = 30_000): void {
    if (this.armed) return;
    this.armed = true;
    // Load the roster now (a local registry read, no network) so a fresh boot already
    // shows the other machines as UNKNOWN (never-read) rather than as absent.
    this.roster = this.safeRoster();
    const first = setTimeout(() => { void this.tick(); }, firstDelayMs);
    const every = setInterval(() => { void this.tick(); }, this.intervalMs);
    first.unref?.();
    every.unref?.();
    this.timers.push(first, every);
  }

  stop(): void {
    for (const t of this.timers) { clearTimeout(t); clearInterval(t as ReturnType<typeof setInterval>); }
    this.timers = [];
    this.armed = false;
  }

  /** One timer tick: a no-op while the switch is off. */
  async tick(): Promise<void> {
    if (!this.isEnabled()) return;
    await this.refresh();
  }

  /**
   * Fire-and-forget refresh after a B17/B21 verdict met a stale or unknown peer.
   * Rate-limited; the caller never awaits it.
   */
  kickTargeted(): void {
    const t = this.now();
    if (!this.isEnabled() || t - this.lastTargetedAtMs < SIBLING_TARGETED_MIN_GAP_MS) return;
    this.lastTargetedAtMs = t;
    // Only dialable, online peers that are stale or never read; each peer's backoff is honored.
    const targets = this.roster.filter((r) => {
      if (!r.dialable || !r.online) return false;
      const e = this.entries.get(r.machineId);
      if ((e?.nextAttemptAtMs ?? 0) > t) return false;
      const newest = Math.max(e?.pool?.observedAtMs ?? -Infinity, e?.browser?.observedAtMs ?? -Infinity);
      return !Number.isFinite(newest) || t - newest > this.intervalMs;
    }).map((r) => r.machineId);
    if (targets.length === 0) return;
    void this.refresh(new Set(targets));
  }

  private safeRoster(): SiblingRosterEntry[] {
    try {
      const list = this.opts.roster();
      if (!Array.isArray(list)) return [];
      const seen = new Set<string>();
      const out: SiblingRosterEntry[] = [];
      for (const r of list) {
        if (!r || typeof r.machineId !== 'string' || !r.machineId || seen.has(r.machineId)) continue;
        seen.add(r.machineId);
        const nickname = clean(r.nickname ?? '', 64);
        const address = typeof r.address === 'string' && r.address ? r.address : undefined;
        out.push({ machineId: r.machineId, ...(nickname ? { nickname } : {}), dialable: r.dialable !== false && !!address, online: r.online !== false, ...(address ? { address } : {}) });
      }
      return out;
    } catch {
      // @silent-fallback-ok — an unreadable roster keeps the previous one; the reach then
      // shows at worst older dated evidence, which ages out to UNKNOWN on its own.
      return this.roster;
    }
  }

  /** Refresh the due peers. Single-flight; never throws. */
  refresh(only?: Set<string>): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.doRefresh(only)
      .catch(() => {
        // @silent-fallback-ok — a refresh bug leaves the previous dated evidence in place;
        // it ages out to UNKNOWN, the pass direction.
      })
      .finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async doRefresh(only?: Set<string>): Promise<void> {
    if (!only) this.roster = this.safeRoster();
    const live = new Set(this.roster.map((r) => r.machineId));
    for (const id of [...this.entries.keys()]) if (!live.has(id)) this.entries.delete(id);
    const t = this.now();
    const due = this.roster.filter((r) => r.dialable && r.online && (!only || only.has(r.machineId)) && (this.entries.get(r.machineId)?.nextAttemptAtMs ?? 0) <= t);
    let batch = due;
    if (due.length > SIBLING_MAX_FETCH_PEERS) {
      const start = this.cursor % due.length;
      batch = [...due.slice(start), ...due.slice(0, start)].slice(0, SIBLING_MAX_FETCH_PEERS);
      this.cursor = start + SIBLING_MAX_FETCH_PEERS;
    }
    await Promise.all(batch.map((r) => this.refreshPeer(r.machineId, r.address ?? '')));
    if (!only) this.lastRefreshAtMs = this.now();
  }

  private async read(machineId: string, address: string, path: string): Promise<SiblingFetchResult> {
    try {
      return await this.opts.fetchJson({ machineId, address }, path);
    } catch {
      // @silent-fallback-ok — a throwing fetcher is classified as unreachable; that surface
      // keeps its dated evidence and the next refresh tries again.
      return { ok: false, failure: 'unreachable' };
    }
  }

  private async refreshPeer(machineId: string, address: string): Promise<void> {
    if (!address) return;
    const entry: Entry = this.entries.get(machineId) ?? { consecutiveFailures: 0, nextAttemptAtMs: 0 };
    const poolRes = await this.read(machineId, address, '/subscription-pool');
    let t = this.now();
    entry.lastAttemptAtMs = t;
    let identified = false;
    let mismatch = false;
    let poolOk = false;
    if (poolRes.ok) {
      const proj = projectPoolBody(poolRes.body);
      if (proj?.machineId && proj.machineId !== machineId) {
        mismatch = true;
      } else if (proj) {
        identified = !!proj.machineId;
        entry.pool = { accounts: proj.accounts, omitted: proj.omitted, observedAtMs: t, verifiedAddress: address };
        entry.poolFailure = undefined;
        poolOk = true;
      } else {
        // Pool off there, or a body that is not a pool. A peer that identifies itself is
        // still on this code even with its pool off.
        identified = !!(poolRes.body && typeof poolRes.body === 'object' && typeof (poolRes.body as { machineId?: unknown }).machineId === 'string' && (poolRes.body as { machineId: string }).machineId === machineId);
        mismatch = !!(poolRes.body && typeof poolRes.body === 'object' && typeof (poolRes.body as { machineId?: unknown }).machineId === 'string' && (poolRes.body as { machineId: string }).machineId !== machineId);
        entry.poolFailure = 'surface-off';
      }
    } else {
      entry.poolFailure = poolRes.failure;
    }

    let browserOk = false;
    if (mismatch) {
      // The URL reached a different machine: nothing it said is attributed to the machine asked.
      entry.poolFailure = 'identity-mismatch';
      entry.browserFailure = 'identity-mismatch';
      entry.addressInvalid = true;
    } else if (!poolRes.ok) {
      // Unreachable for the pool read: do not dial the browser surface this tick.
    } else if (!identified) {
      // Older peer: never ask it for the light view (it would serve the heavy full view).
      entry.browserFailure = 'peer-too-old';
    } else if ((entry.browserNextAttemptAtMs ?? 0) <= t) {
      const profRes = await this.read(machineId, address, '/playwright-profiles?view=accounts');
      t = this.now();
      if (profRes.ok) {
        const proj = projectProfilesBody(profRes.body);
        if (proj && proj.machineId && proj.machineId !== machineId) {
          entry.browserFailure = 'identity-mismatch';
          entry.addressInvalid = true;
        } else if (proj) {
          entry.browser = { accounts: proj.accounts, omitted: proj.omitted, observedAtMs: t, verifiedAddress: address };
          entry.browserFailure = undefined;
          if (proj.machineId === machineId) entry.addressInvalid = false;
          entry.browserNextAttemptAtMs = 0;
          browserOk = true;
        } else {
          entry.browserFailure = 'surface-off';
          entry.browserNextAttemptAtMs = t + this.maxAgeMs;
        }
      } else {
        entry.browserFailure = profRes.failure;
        if (profRes.failure === 'surface-off' || profRes.failure === 'oversize') entry.browserNextAttemptAtMs = t + this.maxAgeMs;
      }
    }

    if (poolOk || browserOk || (identified && entry.poolFailure === 'surface-off')) {
      entry.consecutiveFailures = 0;
      entry.nextAttemptAtMs = 0;
    } else if (entry.poolFailure === 'oversize' || entry.poolFailure === 'surface-off') {
      entry.nextAttemptAtMs = t + this.maxAgeMs;
    } else {
      const neverRead = !entry.pool && !entry.browser;
      entry.consecutiveFailures += 1;
      entry.nextAttemptAtMs = nextSiblingAttemptAtMs({ nowMs: t, failures: entry.consecutiveFailures, neverRead, intervalMs: this.intervalMs, maxAgeMs: this.maxAgeMs });
    }
    this.entries.set(machineId, entry);
  }

  private surfaceView<T>(s: StoredSurface<T> | undefined, t: number): SiblingSurface<T> | undefined {
    if (!s || t - s.observedAtMs > this.maxAgeMs) return undefined;
    return { accounts: s.accounts, omitted: s.omitted, ageMinutes: Math.max(0, Math.round((t - s.observedAtMs) / 60_000)) };
  }

  /** Synchronous, memory-only read for the send path. Never throws. */
  snapshot(): SiblingSnapshot {
    const t = this.now();
    const machines: SiblingMachineView[] = [];
    const unknown: SiblingSnapshot['unknown'] = [];
    for (const r of this.roster) {
      const base = { machineId: clean(r.machineId, 128), ...(r.nickname ? { nickname: r.nickname } : {}) };
      const e = this.entries.get(r.machineId);
      const fallbackReason: SiblingUnknownReason = !r.dialable ? 'no-known-url' : !r.online ? 'offline' : 'never-read';
      const pool = this.surfaceView(e?.pool, t);
      const browser = this.surfaceView(e?.browser, t);
      const reasonFor = (stored: StoredSurface<unknown> | undefined, failure: SiblingFailure | undefined): SiblingUnknownReason =>
        failure ?? (stored ? 'stale' : fallbackReason);
      if (!pool && !browser) {
        unknown.push({ ...base, reason: reasonFor(e?.pool ?? e?.browser, e?.poolFailure ?? e?.browserFailure) });
        continue;
      }
      const browserAddress = browser && !e?.addressInvalid && e?.browserFailure !== 'identity-mismatch' ? e?.browser?.verifiedAddress : undefined;
      machines.push({
        ...base,
        ...(browserAddress ? { verifiedAddress: browserAddress } : {}),
        ...(pool ? { pool } : { poolUnknownReason: reasonFor(e?.pool, e?.poolFailure) }),
        ...(browser ? { browser } : { browserUnknownReason: reasonFor(e?.browser, e?.browserFailure) }),
      });
    }
    return { machines, unknown };
  }

  /** Whether any listed machine is stale (older than one interval) or unknown. */
  hasStaleOrUnknown(): boolean {
    const t = this.now();
    for (const r of this.roster) {
      if (!r.dialable || !r.online) continue;
      const e = this.entries.get(r.machineId);
      const newest = Math.max(e?.pool?.observedAtMs ?? -Infinity, e?.browser?.observedAtMs ?? -Infinity);
      if (!Number.isFinite(newest) || t - newest > this.intervalMs) return true;
    }
    return false;
  }

  /** True when the roster is non-empty and no machine has a fresh surface (feature effectively off). */
  allDark(): boolean {
    if (this.roster.length === 0) return false;
    return this.snapshot().machines.length === 0;
  }

  status(): SiblingCacheStatus {
    const t = this.now();
    const age = (s: StoredSurface<unknown> | undefined): number | null => (s ? Math.max(0, Math.round((t - s.observedAtMs) / 60_000)) : null);
    return {
      armed: this.armed,
      enabled: this.isEnabled(),
      lastRefreshAt: this.lastRefreshAtMs === null ? null : new Date(this.lastRefreshAtMs).toISOString(),
      machines: this.roster.map((r) => {
        const e = this.entries.get(r.machineId);
        return {
          machineId: r.machineId,
          ...(r.nickname ? { nickname: r.nickname } : {}),
          poolAgeMinutes: age(e?.pool),
          browserAgeMinutes: age(e?.browser),
          lastFailure: !r.dialable ? 'no-known-url' : !r.online ? 'offline' : (e?.poolFailure ?? e?.browserFailure ?? null),
        };
      }),
    };
  }
}
