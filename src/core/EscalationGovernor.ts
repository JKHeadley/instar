/**
 * EscalationGovernor — §7 (subscription envelope + lease) and §8 (cost
 * guards) of docs/specs/FABLE-MODEL-ESCALATION-SPEC.md.
 *
 * Admission control for model-tier escalation. Every refusal means "the
 * session stays on its default model" — the governor can never block a
 * message, tool call, or session (§3.5).
 *
 * Invariants implemented here:
 *  - **Lease, not bare headroom read** (round-1 Adversarial-H2): concurrent
 *    escalation onto one account goes through a reservation with
 *    `maxConcurrentEscalatedPerAccount`.
 *  - **Crash-safe lease** (round-2 Security-N3 / Adversarial-NEW-1): leases
 *    carry a TTL, are keyed on the session-instance id (the spawn-generated
 *    INSTAR_SESSION_ID — unforgeable from outside, monotonic per spawn), are
 *    released on session-end (SessionManager 'sessionReaped' — wired at
 *    boot), and a lease whose holder is no longer live is reclaimable.
 *    Expiry is evaluated lazily on read — no dedicated poller.
 *  - **Quota fail-closed** (round-1 Adversarial-H3): `requireQuotaHeadroom`
 *    reads the subscription pool's CACHED snapshot via an injected provider
 *    (never a live poll on the hot path); unavailable/errored ⇒ refuse.
 *  - **Once-per-episode counting** (round-3 Adversarial-NEW-5): an
 *    escalation counts against `maxEscalationsPerHour` exactly once per
 *    (instance-id, tier-transition) episode; canary retries and per-turn
 *    re-derivations never multiply the count. **Accounting fails toward
 *    counting** (round-2 Adversarial-NEW-2): `recordInjection` is called at
 *    injection time, regardless of read-back outcome.
 *  - **Free windows** (§8): UTC-date, inclusive through the named day;
 *    informational only — crossing the expiry emits ONE audit note (no
 *    silent cost cliff). The window relaxes nothing structural.
 *  - **Daily ultra-token cap as admission control** (§8): refuses NEW
 *    escalations once today's ultra spend (injected provider) crosses the
 *    cap. Mid-run visibility is UltraSessionCapMonitor's job.
 *
 * State is file-backed under `<stateDir>/state/model-tier-escalation/`
 * (atomic tmp+rename writes; single-writer — the server process). The
 * audit trail is an append-only JSONL with structured fields only — never
 * raw operator text (round-2 Security-F7).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  isWithinFreeWindow,
  type TierEscalationConfig,
} from './ModelTierEscalation.js';

/** Conservative "has headroom" bound: a cached window utilization at/over
 *  this percentage is treated as capped for escalation purposes. */
export const QUOTA_HEADROOM_MAX_UTILIZATION_PCT = 90;

/** Shape-compatible with SubscriptionPool's AccountQuotaSnapshot — narrowed
 *  to what admission needs so the provider is easy to inject/test. */
export interface QuotaSnapshotLike {
  fiveHour?: { utilizationPct: number; resetsAt?: string };
  sevenDay?: { utilizationPct: number; resetsAt?: string };
  measuredAt?: string;
}

export interface EscalationLease {
  instanceId: string;
  accountId: string;
  acquiredAt: number;
  ttlMs: number;
}

interface GovernorState {
  leases: EscalationLease[];
  /** Episode ledger: key → first-counted epoch ms. Pruned past 24h. */
  episodes: Record<string, number>;
  /** Free-window expiry notes already emitted (modelId → ISO date noted). */
  freeWindowExpiryNoted: Record<string, string>;
}

export type AdmitRefusalReason =
  | 'disabled'
  | 'no-instance-id'
  | 'lease-capacity'
  | 'hourly-budget-exhausted'
  | 'quota-unavailable'
  | 'quota-capped'
  | 'daily-cap-exhausted';

export interface AdmitResult {
  allow: boolean;
  reason?: AdmitRefusalReason;
  /** True when the model is inside a configured free window (informational). */
  freeWindow?: boolean;
}

export interface EscalationGovernorDeps {
  /** The agent state dir (`.instar`). */
  stateDir: string;
  /** Live config getter — re-read per call so operator flips apply. */
  getConfig: () => TierEscalationConfig;
  /**
   * CACHED quota snapshot for the account (never a live poll — §7 /
   * round-1 Scalability-M7). Return null when no snapshot is available;
   * with `requireQuotaHeadroom:true` that REFUSES (fail closed).
   */
  quotaSnapshot?: (accountId: string) => QuotaSnapshotLike | null;
  /**
   * Today's (UTC) ultra-model token total, from the token ledger. Used for
   * the §8 daily-cap admission check. Return null when unavailable — with a
   * cap configured, unavailable ⇒ refuse (fail closed).
   */
  ultraTokensTodayUtc?: () => number | null;
  /** Liveness probe for lease reclaim — false ⇒ the holder crashed/ended. */
  isHolderLive?: (instanceId: string) => boolean;
  /** Injectable clock for tests. */
  now?: () => number;
}

const EPISODE_RETENTION_MS = 24 * 60 * 60 * 1000;

export class EscalationGovernor {
  private readonly deps: EscalationGovernorDeps;
  private readonly dir: string;
  private readonly statePath: string;
  private readonly auditPath: string;
  private readonly now: () => number;

  constructor(deps: EscalationGovernorDeps) {
    this.deps = deps;
    this.dir = path.join(deps.stateDir, 'state', 'model-tier-escalation');
    this.statePath = path.join(this.dir, 'governor.json');
    this.auditPath = path.join(this.dir, 'audit.jsonl');
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * §7/§8 admission decision for escalating `instanceId` on `accountId`.
   * Pure cost/capacity routing — a refusal means "stay on default".
   * Acquiring is idempotent: an instance already holding a lease is
   * re-admitted without consuming additional capacity.
   */
  admitEscalation(input: {
    instanceId: string;
    accountId?: string;
    modelId: string;
    /** e.g. 'default→escalated' — the episode key half (§8 once-per-episode). */
    transition: string;
    /** dryRun evaluation: run every check but acquire NOTHING — a dry-run
     *  swap must never consume lease capacity (§9 dryRun semantics). */
    dry?: boolean;
  }): AdmitResult {
    const cfg = this.deps.getConfig();
    if (!cfg.enabled) {
      return this.refuse(input, 'disabled');
    }
    if (!input.instanceId) {
      return this.refuse(input, 'no-instance-id');
    }
    const accountId = input.accountId ?? 'default';
    const state = this.loadState();
    this.reclaimStale(state);
    const guards = cfg.costGuards;

    // Free-window bookkeeping (informational; never gates) — §8 "no silent
    // cost cliff": the first admission attempt after a window expires emits
    // one audit note.
    const freeWindow = isWithinFreeWindow(input.modelId, guards, this.now());
    this.noteFreeWindowExpiryOnce(state, input.modelId, guards, freeWindow);

    // 1) Lease capacity (per-account, idempotent for the same instance).
    const holding = state.leases.find(l => l.instanceId === input.instanceId);
    if (!holding) {
      const accountLeases = state.leases.filter(l => l.accountId === accountId);
      if (accountLeases.length >= guards.maxConcurrentEscalatedPerAccount) {
        this.saveState(state); // persist any reclaim/expiry-note work
        return this.refuse(input, 'lease-capacity');
      }
    }

    // 2) Hourly escalation budget (§8 — load-bearing for Trigger #1).
    // The episode for THIS (instance, transition) does not double-count.
    const episodeKey = this.episodeKey(input.instanceId, input.transition);
    const hourAgo = this.now() - 3_600_000;
    const countedThisHour = Object.entries(state.episodes).filter(
      ([key, at]) => at >= hourAgo && key !== episodeKey,
    ).length;
    const alreadyCounted = Object.prototype.hasOwnProperty.call(state.episodes, episodeKey);
    if (!alreadyCounted && countedThisHour >= guards.maxEscalationsPerHour) {
      this.saveState(state);
      return this.refuse(input, 'hourly-budget-exhausted');
    }

    // 3) Quota headroom from the CACHED snapshot — unavailable ⇒ fail closed.
    if (guards.requireQuotaHeadroom) {
      let snapshot: QuotaSnapshotLike | null = null;
      try {
        snapshot = this.deps.quotaSnapshot?.(accountId) ?? null;
      } catch {
        // @silent-fallback-ok — fail-closed conversion, not a swallow: an
        // erroring probe reads as "unavailable" and the very next branch
        // refuses with the AUDITED structured reason 'quota-unavailable'.
        snapshot = null;
      }
      if (!snapshot) {
        this.saveState(state);
        return this.refuse(input, 'quota-unavailable');
      }
      const capped = [snapshot.fiveHour, snapshot.sevenDay].some(
        w => w && w.utilizationPct >= QUOTA_HEADROOM_MAX_UTILIZATION_PCT,
      );
      if (capped) {
        this.saveState(state);
        return this.refuse(input, 'quota-capped');
      }
    }

    // 4) Daily ultra-token cap as ADMISSION control (§8). Cap configured but
    // spend unreadable ⇒ fail closed.
    if (guards.dailyUltraTokenCap != null) {
      let spent: number | null = null;
      try {
        spent = this.deps.ultraTokensTodayUtc?.() ?? null;
      } catch {
        // @silent-fallback-ok — fail-closed conversion, not a swallow: an
        // unreadable ledger reads as null and the next branch refuses with
        // the AUDITED structured reason 'daily-cap-exhausted'.
        spent = null;
      }
      if (spent == null || spent >= guards.dailyUltraTokenCap) {
        this.saveState(state);
        return this.refuse(input, 'daily-cap-exhausted');
      }
    }

    if (input.dry) {
      this.saveState(state); // persist reclaim/expiry-note work only
      this.audit({
        type: 'dry-admit',
        instanceId: input.instanceId,
        accountId,
        modelId: input.modelId,
        transition: input.transition,
        freeWindow,
      });
      return { allow: true, freeWindow };
    }

    // Admit: acquire/refresh the lease (TTL = maxEscalationTtlMs).
    const lease: EscalationLease = {
      instanceId: input.instanceId,
      accountId,
      acquiredAt: this.now(),
      ttlMs: guards.maxEscalationTtlMs,
    };
    state.leases = state.leases.filter(l => l.instanceId !== input.instanceId);
    state.leases.push(lease);
    this.saveState(state);
    this.audit({
      type: 'admit',
      instanceId: input.instanceId,
      accountId,
      modelId: input.modelId,
      transition: input.transition,
      freeWindow,
    });
    return { allow: true, freeWindow };
  }

  /**
   * Count the escalation against the hourly budget — called AT INJECTION
   * time (fails toward counting, round-2 Adversarial-NEW-2), idempotent per
   * (instance, transition) episode (round-3 Adversarial-NEW-5).
   * Returns true when this call newly counted the episode.
   */
  recordInjection(instanceId: string, transition: string): boolean {
    const state = this.loadState();
    const key = this.episodeKey(instanceId, transition);
    if (Object.prototype.hasOwnProperty.call(state.episodes, key)) {
      return false; // already counted this episode — retries don't multiply
    }
    state.episodes[key] = this.now();
    this.saveState(state);
    this.audit({ type: 'injection-counted', instanceId, transition });
    return true;
  }

  /** Release the instance's lease (wired to SessionManager 'sessionReaped'
   *  at boot — the same close event that retires the session, §7). */
  releaseLease(instanceId: string): void {
    const state = this.loadState();
    const before = state.leases.length;
    state.leases = state.leases.filter(l => l.instanceId !== instanceId);
    if (state.leases.length !== before) {
      this.saveState(state);
      this.audit({ type: 'lease-released', instanceId });
    }
  }

  /** Current live leases (post-reclaim) — observability/testing surface. */
  activeLeases(): EscalationLease[] {
    const state = this.loadState();
    const changed = this.reclaimStale(state);
    if (changed) this.saveState(state);
    return [...state.leases];
  }

  // ── internals ──────────────────────────────────────────────────────────

  private episodeKey(instanceId: string, transition: string): string {
    return `${instanceId}::${transition}`;
  }

  /** Drop expired leases and leases whose holder is no longer live. Lazy —
   *  runs on every read; no poller (§7). Returns true when anything changed. */
  private reclaimStale(state: GovernorState): boolean {
    const now = this.now();
    const before = state.leases.length;
    state.leases = state.leases.filter(l => {
      if (now - l.acquiredAt >= l.ttlMs) {
        this.audit({ type: 'lease-reclaimed', instanceId: l.instanceId, why: 'ttl-expired' });
        return false;
      }
      try {
        if (this.deps.isHolderLive && !this.deps.isHolderLive(l.instanceId)) {
          this.audit({ type: 'lease-reclaimed', instanceId: l.instanceId, why: 'holder-not-live' });
          return false;
        }
      } catch {
        // liveness probe errored — keep the lease (TTL still bounds it)
      }
      return true;
    });
    // Prune stale episodes while we're here (same lazy pass).
    for (const [key, at] of Object.entries(state.episodes)) {
      if (now - at > EPISODE_RETENTION_MS) delete state.episodes[key];
    }
    return state.leases.length !== before;
  }

  private noteFreeWindowExpiryOnce(
    state: GovernorState,
    modelId: string,
    guards: TierEscalationConfig['costGuards'],
    currentlyInWindow: boolean,
  ): void {
    const windows = guards.respectFreeWindows ?? {};
    if (!Object.prototype.hasOwnProperty.call(windows, modelId)) return;
    if (currentlyInWindow) return;
    if (state.freeWindowExpiryNoted[modelId] === windows[modelId]) return;
    state.freeWindowExpiryNoted[modelId] = windows[modelId];
    this.audit({
      type: 'free-window-expired',
      modelId,
      window: windows[modelId],
      note: 'free window crossed — quota/budget guards apply unchanged',
    });
  }

  private loadState(): GovernorState {
    try {
      const raw = JSON.parse(fs.readFileSync(this.statePath, 'utf-8')) as Partial<GovernorState>;
      return {
        leases: Array.isArray(raw.leases) ? raw.leases.filter(l => l && typeof l.instanceId === 'string') : [],
        episodes: raw.episodes && typeof raw.episodes === 'object' ? raw.episodes : {},
        freeWindowExpiryNoted:
          raw.freeWindowExpiryNoted && typeof raw.freeWindowExpiryNoted === 'object'
            ? raw.freeWindowExpiryNoted
            : {},
      };
    } catch {
      return { leases: [], episodes: {}, freeWindowExpiryNoted: {} };
    }
  }

  private saveState(state: GovernorState): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = `${this.statePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
      fs.renameSync(tmp, this.statePath);
    } catch (err) {
      // State-write failure must never block the caller — but it must be
      // loud: a governor that can't persist is a governor that can't bound.
      console.warn(`[escalation-governor] state write failed: ${(err as Error).message}`);
    }
  }

  /** Structured-fields-only audit appender (Sec-F7: no raw operator text). */
  private audit(event: Record<string, unknown>): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.appendFileSync(
        this.auditPath,
        JSON.stringify({ ts: new Date(this.now()).toISOString(), ...event }) + '\n',
      );
    } catch {
      // best-effort — never throws into the routing path
    }
  }

  private refuse(
    input: { instanceId: string; accountId?: string; modelId: string; transition: string },
    reason: AdmitRefusalReason,
  ): AdmitResult {
    this.audit({
      type: 'refuse',
      reason,
      instanceId: input.instanceId,
      accountId: input.accountId ?? 'default',
      modelId: input.modelId,
      transition: input.transition,
    });
    return { allow: false, reason };
  }
}
