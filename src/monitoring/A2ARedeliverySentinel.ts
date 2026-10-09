/**
 * A2ARedeliverySentinel — the active-recovery layer of "communications never
 * just die out" (A2A-DURABLE-DELIVERY-SPEC.md §4, issue #939, CMT-1143). PR2.
 *
 * PR1 (A2ADeliveryTracker) made every outbound A2A message a durable, tracked
 * loop (`awaiting-ack`) and turned channel-liveness into a read. This sentinel
 * is the consumer that CLOSES those loops: on a cadence it sweeps the tracker's
 * overdue work-list and either gets the message through (redelivery with
 * backoff) or, once retries are exhausted, surfaces ONE aggregated, operator-
 * visible escalation per peer — so a peer going dark is impossible to miss.
 *
 * REWORKED (docs/specs/a2a-single-agent-identity.md §3 — honest sender-side
 * reporting of a send that stays queued). The per-MESSAGE escalation had no
 * resolve, no cooldown and no per-peer state, and its item id carried an
 * episode stamp. Under the `peerDark` gate the operator-facing trigger is now
 * PER PEER: `dark && queuedCount > 0 && selfHealExhausted`, where `dark` for the
 * RAISE is computed over the same pool-scope acks/inbounds the RESOLVE reads (a
 * peer that answered on my other machine is not dark); the item id is the
 * deterministic `a2a-peer-dark:<agent>:<peerFp>` (rows live on whichever machine
 * carried the send, so a lease move must not strand an item); the item RESOLVES
 * from pool-scope evidence newer than its raise time, naming the messages that
 * expired unacknowledged; and each peer carries a 12 h cooldown. Before blaming
 * the peer the sentinel heals its own side — ONLY on the awake machine (a
 * standby's relay is disconnected by design): reconnect a dropped relay, refresh
 * the presence map once, run the identity self-check; two passes 40 s apart.
 * When MY relay is not connected, ONE aggregated item replaces per-peer items.
 * Dry-run (the default) logs would-raise rows to logs/a2a-peer-dark.jsonl and
 * raises nothing. The legacy redelivery loop is unchanged and keeps its own
 * gate; its per-message escalation item is raised only when the peer-dark path
 * is NOT on (today's behaviour is byte-identical with the new gate dark).
 *
 * Signal-vs-authority: this is a SIGNAL CONSUMER feeding existing surfaces
 * (the relay client for redelivery, the Attention queue for escalation). It owns
 * NO blocking authority — it never gates a send or a receive; it only re-attempts
 * and reports.
 *
 * Modeled on CollaborationRedriveEngine (the sibling redrive/escalate engine):
 * injected deps for testability, per-tick caps, setInterval+unref lifecycle,
 * disabled-by-default (it sends + escalates, so it ships dark and is opt-in).
 */

/* @self-action-controller: a2a-peer-dark-raise */
import type { A2ADeliveryTracker, A2ADeliveryEntry, PeerHealth } from '../threadline/A2ADeliveryTracker.js';
import { mergeDefaults } from '../core/mergeDefaults.js';
import {
  DEFAULT_PEER_DARK_COOLDOWN_MS,
  DEFAULT_QUEUED_DARK_AFTER_MS,
  buildPeerDarkItemBody,
  buildPeerDarkResolveLine,
  peerDarkItemId,
  peerLabel,
  relayUnreachableItemId,
  type PeerDarkAuditRow,
} from '../threadline/peerDark.js';

/** A redelivery attempt: re-send the message body to the peer. Returns whether
 *  the transport accepted it. Resolving false (or throwing) leaves the message
 *  awaiting-ack for the next sweep. */
export type A2ARedeliverFn = (entry: A2ADeliveryEntry) => Promise<boolean> | boolean;

/** Raise ONE aggregated attention item (P17 — never one per message). `id` is
 *  set on the per-peer / aggregate dark items (deterministic, §3.2 iii); the
 *  legacy per-message escalation leaves it unset. */
export type A2ARaiseAttentionFn = (item: {
  id?: string;
  title: string;
  body: string;
  priority?: 'low' | 'medium' | 'high';
  source?: string;
}) => Promise<unknown> | unknown;

/** Resolve an item by id, delivering its resolve line. */
export type A2AResolveAttentionFn = (id: string, line: string) => Promise<unknown> | unknown;

/** Read an item's durable state (restart-safe cooldown / dedupe). */
export type A2AAttentionStateFn = (id: string) => { status: string; updatedAt: string; createdAt?: string } | null | undefined;

/** My relay connection, as /threadline/health reports it. */
export type A2ARelayState = 'connected' | 'disconnected' | 'displaced' | 'not-configured';

/** One machine's view of a peer, from GET /threadline/peers/:fp/health (pool scope). */
export interface A2APoolPeerRow {
  machineId: string;
  lastAckedAt: string | null;
  lastInboundAt: string | null;
  lastDeliveredAt?: string | null;
}

export interface A2APeerDarkConfig {
  /** The §3 gate (threadline.peerDarkNotice, dev-gated). Ships dark on the fleet. */
  enabled: boolean;
  /** Default true: would-raise rows only. */
  dryRun: boolean;
  queuedDarkAfterMs: number;
  cooldownMs: number;
  /** Delay between the two self-heal passes (§3.3: 40 s inside the 120 s ceiling). */
  healPassDelayMs: number;
}

export const DEFAULT_A2A_PEER_DARK_CONFIG: A2APeerDarkConfig = {
  enabled: false,
  dryRun: true,
  queuedDarkAfterMs: DEFAULT_QUEUED_DARK_AFTER_MS,
  cooldownMs: DEFAULT_PEER_DARK_COOLDOWN_MS,
  healPassDelayMs: 40_000,
};

export interface A2ARedeliveryConfig {
  /** Master switch for the legacy redelivery loop. Ships OFF (it re-sends + escalates). */
  enabled: boolean;
  /** Sweep cadence. */
  sweepIntervalMs: number;
  /** A message awaiting-ack longer than this (since last attempt) is overdue. */
  ttlMs: number;
  /** Re-attempts before escalation (the original send counts as attempt 1). */
  maxAttempts: number;
  /** Backoff base: nextRetry ≈ backoffBaseMs * 2^(attempts-1). */
  backoffBaseMs: number;
  /** Cap redelivery sends per sweep (protect a degraded transport). */
  maxRedrivesPerTick: number;
  /** The §3 per-peer dark path. Constructed with EITHER gate on. */
  peerDark?: Partial<A2APeerDarkConfig>;
}

export const DEFAULT_A2A_REDELIVERY_CONFIG: A2ARedeliveryConfig = {
  enabled: false,
  sweepIntervalMs: 15 * 60 * 1000, // 15m
  ttlMs: 6 * 60 * 60 * 1000,       // 6h — matches the ACK-discipline window
  maxAttempts: 5,
  backoffBaseMs: 5 * 60 * 1000,    // 5m, doubling
  maxRedrivesPerTick: 10,
};

export interface A2ARedeliveryDeps {
  tracker: A2ADeliveryTracker;
  /** Re-send a message. Omit to run escalate-only (no redelivery). */
  redeliver?: A2ARedeliverFn;
  /** Raise the aggregated escalation. Omit and escalations are state-only. */
  raiseAttention?: A2ARaiseAttentionFn;
  /** Resolve a dark item (§3.2 iv). Omit and resolves are state-only. */
  resolveAttention?: A2AResolveAttentionFn;
  /** Durable item state, for restart-safe dedupe + cooldown. */
  attentionState?: A2AAttentionStateFn;
  /** This agent's id (item ids). Default 'agent'. */
  agentId?: string;
  /** My relay state. Omit ⇒ treated as `not-configured` (no aggregation, no reconnect). */
  relayState?: () => A2ARelayState;
  /** Awake (telegram-polling) machine? A standby runs no heal and raises nothing (§3.3). Default true. */
  isAwake?: () => boolean;
  /** §3.3 heal step 1: re-arm a dropped relay (idempotent). */
  reconnectRelay?: () => Promise<unknown> | unknown;
  /** §3.3 heal step 2: one discover; false when the call was rejected (no relay client). */
  refreshPresence?: () => Promise<boolean> | boolean;
  /** §3.2 `connectedNow` from the presence map (never an inline discover). */
  peerConnectedNow?: (peerFp: string) => boolean | null;
  /** §3.3 heal step 3: the §2 identity self-check. 'split' supersedes a per-peer item. */
  identitySelfCheck?: () => Promise<'ok' | 'split' | 'unknown'> | 'ok' | 'split' | 'unknown';
  /** Pool-scope reads of a peer's health on my other machines (raise AND resolve). */
  poolPeerHealth?: (peerFp: string) => Promise<A2APoolPeerRow[]>;
  /** Audit rows → logs/a2a-peer-dark.jsonl. */
  audit?: (row: PeerDarkAuditRow) => void;
  /** Test seam for the inter-pass wait. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: { log: (m: string) => void; warn: (m: string) => void };
}

export interface A2ARedeliveryTickResult {
  disabled: boolean;
  overdue: number;
  redelivered: number;
  escalated: number;
  /** Peers that received an aggregated escalation this tick. */
  escalatedPeers: string[];
  /** §3: peers found dark pool-wide this tick (after the heal). */
  darkPeers: string[];
  /** §3: per-peer items raised (or, in dry-run, would-raised) this tick. */
  darkRaised: string[];
  /** §3: per-peer items resolved (or would-resolved) this tick. */
  darkResolved: string[];
  /** §3: the local-cause aggregate item was raised / would-raise this tick. */
  aggregateRaised: boolean;
  /** §3.3: why the heal did not run (`standby`), when it did not. */
  healSkipped?: string;
}

interface DarkEpisode {
  itemId: string;
  raisedAtMs: number;
  darkSince: string | null;
  peerName: string | null;
}

const EMPTY: A2ARedeliveryTickResult = {
  disabled: true, overdue: 0, redelivered: 0, escalated: 0, escalatedPeers: [],
  darkPeers: [], darkRaised: [], darkResolved: [], aggregateRaised: false,
};

function newest(...isos: Array<string | null | undefined>): number {
  let best = Number.NEGATIVE_INFINITY;
  for (const v of isos) {
    if (typeof v !== 'string') continue;
    const t = Date.parse(v);
    if (!Number.isNaN(t) && t > best) best = t;
  }
  return best;
}

export class A2ARedeliverySentinel {
  private readonly cfg: A2ARedeliveryConfig;
  readonly peerDark: A2APeerDarkConfig;
  private readonly deps: A2ARedeliveryDeps;
  private readonly now: () => number;
  private readonly log: { log: (m: string) => void; warn: (m: string) => void };
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  /** Open per-peer dark episodes (restart: rebuilt from `attentionState`). */
  private readonly episodes = new Map<string, DarkEpisode>();
  /** Last raise per peer (ms) — the in-process half of the cooldown. */
  private readonly lastRaiseAt = new Map<string, number>();
  private aggregateOpen = false;

  constructor(deps: A2ARedeliveryDeps, cfg: Partial<A2ARedeliveryConfig> = {}) {
    this.cfg = mergeDefaults(DEFAULT_A2A_REDELIVERY_CONFIG, cfg);
    this.peerDark = mergeDefaults(DEFAULT_A2A_PEER_DARK_CONFIG, cfg.peerDark);
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.log ?? {
      log: (m) => console.log(`[A2ARedelivery] ${m}`),
      warn: (m) => console.warn(`[A2ARedelivery] ${m}`),
    };
  }

  /** The §3 path is LIVE: items and sentences are produced (enabled, not dry-run). */
  get peerDarkLive(): boolean {
    return this.peerDark.enabled && !this.peerDark.dryRun;
  }

  /** Either gate arms the sweep (§3.2 i). */
  get armed(): boolean {
    return this.cfg.enabled || this.peerDark.enabled;
  }

  start(): void {
    if (this.timer) return;
    if (!this.armed) {
      this.log.log('disabled; sweep NOT armed');
      return;
    }
    this.timer = setInterval(() => {
      void Promise.resolve(this.tick()).catch((err) => {
        // @silent-fallback-ok: a sweep error must never crash the interval; it's
        // logged and the next sweep retries (the tracker state is durable).
        this.log.warn(`tick error: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, this.cfg.sweepIntervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    this.log.log(
      `armed (sweep ${this.cfg.sweepIntervalMs}ms, redelivery ${this.cfg.enabled ? 'on' : 'off'}, ` +
      `peer-dark ${this.peerDark.enabled ? (this.peerDark.dryRun ? 'dry-run' : 'LIVE') : 'off'}, ` +
      `ttl ${this.cfg.ttlMs}ms, maxAttempts ${this.cfg.maxAttempts})`,
    );
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** One sweep: the legacy redelivery loop (its gate), then the §3 dark pass (its gate). */
  async tick(): Promise<A2ARedeliveryTickResult> {
    if (!this.armed) return { ...EMPTY };
    if (this.ticking) return { ...EMPTY, disabled: false };
    this.ticking = true;
    try {
      const nowMs = this.now();
      const legacy = this.cfg.enabled ? await this.redeliveryPass(nowMs) : null;
      const dark = this.peerDark.enabled ? await this.darkPass(nowMs) : null;
      return {
        disabled: false,
        overdue: legacy?.overdue ?? 0,
        redelivered: legacy?.redelivered ?? 0,
        escalated: legacy?.escalated ?? 0,
        escalatedPeers: legacy?.escalatedPeers ?? [],
        darkPeers: dark?.darkPeers ?? [],
        darkRaised: dark?.darkRaised ?? [],
        darkResolved: dark?.darkResolved ?? [],
        aggregateRaised: dark?.aggregateRaised ?? false,
        ...(dark?.healSkipped ? { healSkipped: dark.healSkipped } : {}),
      };
    } finally {
      this.ticking = false;
    }
  }

  // ── Legacy per-message redelivery (unchanged behaviour under its own gate) ──

  private async redeliveryPass(nowMs: number): Promise<Pick<A2ARedeliveryTickResult, 'overdue' | 'redelivered' | 'escalated' | 'escalatedPeers'>> {
    const overdue = this.deps.tracker.findOverdue(this.cfg.ttlMs, nowMs);
    let redelivered = 0;
    // Peer → messages escalated this tick (for one aggregated attention item each).
    const escalatedByPeer = new Map<string, A2ADeliveryEntry[]>();

    for (const entry of overdue) {
      if (entry.attempts >= this.cfg.maxAttempts) {
        // Retries exhausted → escalate (once: markEscalated removes it from findOverdue).
        this.deps.tracker.markEscalated(entry.messageId, new Date(nowMs).toISOString());
        const list = escalatedByPeer.get(entry.peerFp) ?? [];
        list.push(entry);
        escalatedByPeer.set(entry.peerFp, list);
        continue;
      }
      // Under the cap → re-attempt delivery (subject to the per-tick cap).
      if (redelivered >= this.cfg.maxRedrivesPerTick) continue;
      let accepted = false;
      if (this.deps.redeliver) {
        try {
          accepted = await Promise.resolve(this.deps.redeliver(entry));
        } catch (err) {
          // @silent-fallback-ok: a redelivery transport error must not abort the
          // sweep; the message stays awaiting-ack and is retried next tick. Logged.
          this.log.warn(`redeliver failed for ${entry.messageId} → ${entry.peerFp.slice(0, 12)}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      // Whether or not the transport accepted, count the attempt + set backoff:
      // an "accepted" send still isn't acked (that's the whole point), so it must
      // remain awaiting-ack and keep its retry clock advancing toward escalation.
      const backoffMs = this.cfg.backoffBaseMs * Math.pow(2, Math.max(0, entry.attempts - 1));
      const nextRetry = new Date(nowMs + backoffMs).toISOString();
      this.deps.tracker.markAttempt(entry.messageId, nextRetry, new Date(nowMs).toISOString());
      if (accepted) redelivered++;
    }

    // ONE aggregated attention item per dark peer (P17 — never per message).
    // With the §3 peer-dark path LIVE (enabled and not dry-run), the per-peer
    // dark item IS the operator notice (deterministic id, resolve, cooldown) —
    // the legacy stamped item is not raised beside it. In dry-run the dark path
    // raises nothing, so the legacy item still goes out (no silent window). The
    // state change (markEscalated) happens either way, and an escalated row
    // never suppresses a later dark episode (§3.2).
    const escalatedPeers: string[] = [];
    let escalatedCount = 0;
    for (const [peerFp, msgs] of escalatedByPeer) {
      escalatedCount += msgs.length;
      escalatedPeers.push(peerFp);
      if (this.deps.raiseAttention && !this.peerDarkLive) {
        const peerName = msgs.find((m) => m.peerName)?.peerName ?? peerFp.slice(0, 12);
        const oldest = msgs.reduce((a, b) => (Date.parse(a.sentAt) <= Date.parse(b.sentAt) ? a : b));
        const ageH = Math.round((nowMs - Date.parse(oldest.sentAt)) / 3_600_000);
        try {
          await Promise.resolve(this.deps.raiseAttention({
            title: `Agent ${peerName} is dark: ${msgs.length} message(s) undelivered`,
            body: `${msgs.length} message(s) to ${peerName} (${peerFp.slice(0, 16)}…) have gone unacknowledged for ~${ageH}h after ${this.cfg.maxAttempts} delivery attempts. The peer may be offline or unreachable — check the relay and the peer's address. (A2A delivery escalation; threads: ${msgs.map((m) => m.threadId ?? '?').slice(0, 5).join(', ')})`,
            priority: 'medium',
            source: `a2a-redelivery:${peerFp}`,
          }));
        } catch (err) {
          // @silent-fallback-ok: a failed attention raise must not abort the sweep
          // or lose the escalated state (already persisted via markEscalated). Logged.
          this.log.warn(`raiseAttention failed for ${peerFp.slice(0, 12)}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    if (redelivered || escalatedCount) {
      this.log.log(`sweep: ${overdue.length} overdue, ${redelivered} redelivered, ${escalatedCount} escalated across ${escalatedPeers.length} peer(s)`);
    }
    return { overdue: overdue.length, redelivered, escalated: escalatedCount, escalatedPeers };
  }

  // ── §3 per-peer dark pass ──────────────────────────────────────────────

  private audit(row: { kind: PeerDarkAuditRow['kind'] } & Record<string, unknown>): void {
    try {
      const full: PeerDarkAuditRow = { ...row, kind: row.kind, ts: new Date(this.now()).toISOString(), dryRun: this.peerDark.dryRun };
      this.deps.audit?.(full);
    } catch (err) {
      // @silent-fallback-ok: the audit writer must never break the sweep; logged.
      this.log.warn(`audit failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private get agentId(): string {
    return this.deps.agentId ?? 'agent';
  }

  private relayState(): A2ARelayState {
    try { return this.deps.relayState?.() ?? 'not-configured'; } catch { return 'not-configured'; } // @silent-fallback-ok — an unreadable relay state reads as not-configured: no aggregation, no reconnect (the safe direction)
  }

  private isAwake(): boolean {
    try { return this.deps.isAwake?.() ?? true; } catch { return false; } // @silent-fallback-ok — an unreadable standby fact reads as standby: no heal, no raise (never a reconnect that could displace the holder)
  }

  private localHealth(nowMs: number): PeerHealth[] {
    return this.deps.tracker.allPeerHealth({ nowMs, queuedDarkAfterMs: this.peerDark.queuedDarkAfterMs });
  }

  /** Pool rows for a peer; a failing pool read answers [] (local evidence only — fail toward the local verdict). */
  private async poolRows(peerFp: string): Promise<A2APoolPeerRow[]> {
    if (!this.deps.poolPeerHealth) return [];
    try {
      const rows = await this.deps.poolPeerHealth(peerFp);
      return Array.isArray(rows) ? rows : [];
    } catch (err) {
      this.audit({ kind: 'error', peerFp, reason: `pool-read-failed:${err instanceof Error ? err.message : String(err)}` });
      return [];
    }
  }

  /** Newest sign of life for a peer across local + pool rows (ms, -Infinity when none). */
  private static lifeAt(local: PeerHealth | undefined, pool: A2APoolPeerRow[]): number {
    let best = newest(local?.lastAckedAt, local?.lastInboundAt, local?.lastDeliveredAt);
    for (const r of pool) best = Math.max(best, newest(r.lastAckedAt, r.lastInboundAt, r.lastDeliveredAt));
    return best;
  }

  /** Rebuild an episode after a restart from the durable item state. */
  private episodeFor(peerFp: string, health: PeerHealth | undefined): DarkEpisode | null {
    const existing = this.episodes.get(peerFp);
    if (existing) return existing;
    const itemId = peerDarkItemId(this.agentId, peerFp);
    const state = this.deps.attentionState?.(itemId);
    if (state && state.status === 'OPEN') {
      const raisedAtMs = newest(state.updatedAt, state.createdAt);
      const ep: DarkEpisode = {
        itemId,
        raisedAtMs: Number.isFinite(raisedAtMs) ? raisedAtMs : this.now(),
        darkSince: health?.darkSince ?? null,
        peerName: health?.peerName ?? null,
      };
      this.episodes.set(peerFp, ep);
      return ep;
    }
    return null;
  }

  /** Cooldown (§3.2 iv): in-process last raise, else the durable item's last update. */
  private inCooldown(peerFp: string, nowMs: number): boolean {
    const last = this.lastRaiseAt.get(peerFp);
    if (last !== undefined && nowMs - last < this.peerDark.cooldownMs) return true;
    const state = this.deps.attentionState?.(peerDarkItemId(this.agentId, peerFp));
    if (state && state.status !== 'OPEN') {
      const t = newest(state.updatedAt);
      if (Number.isFinite(t) && nowMs - t < this.peerDark.cooldownMs) return true;
    }
    return false;
  }

  private async resolveEpisode(peerFp: string, ep: DarkEpisode, nowMs: number, reason: string): Promise<void> {
    const expired = ep.darkSince ? this.deps.tracker.expiredUnacknowledgedSince(peerFp, ep.darkSince) : 0;
    const line = buildPeerDarkResolveLine({ peerFp, peerName: ep.peerName }, expired);
    this.episodes.delete(peerFp);
    if (this.peerDark.dryRun) {
      this.audit({ kind: 'would-resolve', peerFp, itemId: ep.itemId, expiredUnacknowledged: expired, reason });
      return;
    }
    try {
      await Promise.resolve(this.deps.resolveAttention?.(ep.itemId, line));
      this.audit({ kind: 'resolved', peerFp, itemId: ep.itemId, expiredUnacknowledged: expired, reason });
    } catch (err) {
      // @silent-fallback-ok: a failed resolve is retried next tick (the episode is
      // rebuilt from the still-OPEN item). Logged + audited.
      this.episodes.set(peerFp, ep);
      this.audit({ kind: 'error', peerFp, itemId: ep.itemId, reason: `resolve-failed:${err instanceof Error ? err.message : String(err)}` });
    }
    void nowMs;
  }

  private async raiseEpisode(peerFp: string, h: PeerHealth, nowMs: number): Promise<void> {
    const itemId = peerDarkItemId(this.agentId, peerFp);
    const connectedNow = this.deps.peerConnectedNow?.(peerFp) ?? null;
    const row = { peerFp, itemId, queuedCount: h.queuedCount, darkSince: h.darkSince, connectedNow };
    if (this.peerDark.dryRun) {
      this.audit({ kind: 'would-raise', ...row });
      this.lastRaiseAt.set(peerFp, nowMs);
      return;
    }
    const body = buildPeerDarkItemBody({ peerFp, peerName: h.peerName }, h.queuedCount, h.darkSince);
    try {
      await Promise.resolve(this.deps.raiseAttention?.({
        id: itemId,
        title: `Messages to ${peerLabel(peerFp, h.peerName)} are stuck (${h.queuedCount} queued)`,
        body,
        priority: 'medium',
        source: `a2a-peer-dark:${peerFp}`,
      }));
      this.episodes.set(peerFp, { itemId, raisedAtMs: nowMs, darkSince: h.darkSince, peerName: h.peerName });
      this.lastRaiseAt.set(peerFp, nowMs);
      this.audit({ kind: 'raised', ...row });
    } catch (err) {
      // @silent-fallback-ok: a failed raise is retried next tick. Logged + audited.
      this.audit({ kind: 'error', ...row, reason: `raise-failed:${err instanceof Error ? err.message : String(err)}` });
    }
  }

  private async darkPass(nowMs: number): Promise<Pick<A2ARedeliveryTickResult, 'darkPeers' | 'darkRaised' | 'darkResolved' | 'aggregateRaised' | 'healSkipped'>> {
    const out = { darkPeers: [] as string[], darkRaised: [] as string[], darkResolved: [] as string[], aggregateRaised: false, healSkipped: undefined as string | undefined };
    let health: PeerHealth[];
    try {
      health = this.localHealth(nowMs);
    } catch (err) {
      // Ledger unreadable → `dark: unknown`: no item, one audit row (Evidence table).
      this.audit({ kind: 'error', reason: `ledger-unreadable:${err instanceof Error ? err.message : String(err)}` });
      return out;
    }
    const byFp = new Map(health.map((h) => [h.peerFp, h]));

    // 1. Resolve: every open episode whose peer shows life (local or pool) newer than the raise.
    const openFps = new Set<string>(this.episodes.keys());
    for (const h of health) if (this.episodeFor(h.peerFp, h)) openFps.add(h.peerFp);
    for (const fp of openFps) {
      const ep = this.episodes.get(fp);
      if (!ep) continue;
      const pool = await this.poolRows(fp);
      const life = A2ARedeliverySentinel.lifeAt(byFp.get(fp), pool);
      if (life > ep.raisedAtMs) {
        await this.resolveEpisode(fp, ep, nowMs, 'life-after-raise');
        out.darkResolved.push(fp);
      }
    }

    // 2. Candidates: locally dark with queued rows.
    const candidates = health.filter((h) => h.dark && h.queuedCount > 0);
    const awake = this.isAwake();
    const relay = this.relayState();

    // 3. Local cause first: my relay is not connected → heal (awake only), then ONE aggregate.
    if (relay === 'disconnected' || relay === 'displaced') {
      if (!awake) {
        out.healSkipped = 'standby';
        this.audit({ kind: 'skipped', reason: 'standby', relayState: relay, peers: candidates.length });
        return out;
      }
      try {
        await Promise.resolve(this.deps.reconnectRelay?.());
        this.audit({ kind: 'heal', reason: 'reconnect-relay', relayState: relay });
      } catch (err) {
        this.audit({ kind: 'error', reason: `reconnect-failed:${err instanceof Error ? err.message : String(err)}` });
      }
      const after = this.relayState();
      if (after !== 'connected') {
        if (candidates.length > 0) {
          const messages = candidates.reduce((n, h) => n + h.queuedCount, 0);
          out.aggregateRaised = true;
          await this.raiseAggregate(candidates.length, messages, after, nowMs);
        }
        // Per-peer items are suppressed until the relay is back (§3.2).
        this.audit({ kind: 'skipped', reason: 'relay-not-connected', relayState: after, peers: candidates.length });
        return out;
      }
    }
    // Resolve the aggregate once the relay is back — including a durable OPEN
    // item from before a restart (the in-process flag alone would miss it).
    if (relay === 'connected' && (this.aggregateOpen || this.aggregateItemOpen())) await this.resolveAggregate();

    if (candidates.length === 0) return out;

    // 4. Pool-scope dark for the RAISE: a peer that answered on my other machine is not dark.
    const poolDark: PeerHealth[] = [];
    for (const h of candidates) {
      const pool = await this.poolRows(h.peerFp);
      const poolLife = pool.length ? Math.max(...pool.map((r) => newest(r.lastAckedAt, r.lastInboundAt, r.lastDeliveredAt))) : Number.NEGATIVE_INFINITY;
      const sinceMs = h.darkSince ? Date.parse(h.darkSince) : Number.POSITIVE_INFINITY;
      if (poolLife > sinceMs) {
        this.audit({ kind: 'pool-cleared', peerFp: h.peerFp, darkSince: h.darkSince, queuedCount: h.queuedCount });
        const ep = this.episodes.get(h.peerFp);
        if (ep && poolLife > ep.raisedAtMs) { await this.resolveEpisode(h.peerFp, ep, nowMs, 'pool-life'); out.darkResolved.push(h.peerFp); }
        continue;
      }
      poolDark.push(h);
    }
    if (poolDark.length === 0) return out;

    // 5. Self-heal before notify (§3.3) — awake only; two passes 40 s apart.
    if (!awake) {
      out.healSkipped = 'standby';
      out.darkPeers = poolDark.map((h) => h.peerFp);
      this.audit({ kind: 'skipped', reason: 'standby', peers: poolDark.length });
      return out;
    }
    const healed = await this.heal(nowMs);
    if (healed === 'split') {
      out.darkPeers = poolDark.map((h) => h.peerFp);
      this.audit({ kind: 'superseded', reason: 'identity-split', peers: poolDark.length });
      return out;
    }
    // Second pass: re-read after the wait; a peer that cleared gets no item.
    const after = new Map(this.localHealth(this.now()).map((h) => [h.peerFp, h]));
    for (const before of poolDark) {
      const h = after.get(before.peerFp);
      if (!h || !h.dark || h.queuedCount === 0) {
        this.audit({ kind: 'heal', peerFp: before.peerFp, reason: 'cleared-during-heal' });
        continue;
      }
      out.darkPeers.push(h.peerFp);
      if (this.episodes.has(h.peerFp)) continue; // already raised, still open
      if (this.inCooldown(h.peerFp, nowMs)) {
        this.audit({ kind: 'cooldown', peerFp: h.peerFp, queuedCount: h.queuedCount, darkSince: h.darkSince });
        continue;
      }
      await this.raiseEpisode(h.peerFp, h, this.now());
      out.darkRaised.push(h.peerFp);
    }
    return out;
  }

  /** §3.3 steps 2–3, then the inter-pass wait. */
  private async heal(nowMs: number): Promise<'ok' | 'split'> {
    let refreshed: boolean | null = null;
    try {
      refreshed = (await Promise.resolve(this.deps.refreshPresence?.())) ?? null;
    } catch (err) {
      this.audit({ kind: 'error', reason: `refresh-presence-failed:${err instanceof Error ? err.message : String(err)}` });
    }
    let selfCheck: 'ok' | 'split' | 'unknown' = 'unknown';
    try {
      selfCheck = (await Promise.resolve(this.deps.identitySelfCheck?.())) ?? 'unknown';
    } catch (err) {
      this.audit({ kind: 'error', reason: `self-check-failed:${err instanceof Error ? err.message : String(err)}` });
    }
    this.audit({ kind: 'heal', reason: 'pass-1', presenceRefreshed: refreshed, selfCheck });
    if (selfCheck === 'split') return 'split';
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    try { await sleep(this.peerDark.healPassDelayMs); } catch { /* @silent-fallback-ok: a cancelled wait just means pass 2 runs now */ }
    this.audit({ kind: 'heal', reason: 'pass-2', elapsedMs: this.now() - nowMs });
    return 'ok';
  }

  private async raiseAggregate(peers: number, messages: number, relayState: string, nowMs: number): Promise<void> {
    const itemId = relayUnreachableItemId(this.agentId);
    if (this.peerDark.dryRun) {
      this.audit({ kind: 'would-raise-aggregate', itemId, peers, messages, relayState });
      return;
    }
    if (this.aggregateOpen) return;
    const state = this.deps.attentionState?.(itemId);
    if (state && state.status === 'OPEN') { this.aggregateOpen = true; return; }
    try {
      await Promise.resolve(this.deps.raiseAttention?.({
        id: itemId,
        title: 'Agent relay unreachable from this machine',
        body: `relay unreachable from this machine; ${peers} peer${peers === 1 ? '' : 's'}, ${messages} message${messages === 1 ? '' : 's'} queued. Reconnect was attempted; per-peer notices are held until the relay is back.`,
        priority: 'medium',
        source: 'a2a-peer-dark:relay',
      }));
      this.aggregateOpen = true;
      this.audit({ kind: 'raised-aggregate', itemId, peers, messages, relayState });
    } catch (err) {
      this.audit({ kind: 'error', itemId, reason: `aggregate-raise-failed:${err instanceof Error ? err.message : String(err)}` });
    }
    void nowMs;
  }

  /** Durable state of the aggregate item (restart-safe). */
  private aggregateItemOpen(): boolean {
    if (this.peerDark.dryRun) return false;
    const state = this.deps.attentionState?.(relayUnreachableItemId(this.agentId));
    return state?.status === 'OPEN';
  }

  private async resolveAggregate(): Promise<void> {
    const itemId = relayUnreachableItemId(this.agentId);
    this.aggregateOpen = false;
    if (this.peerDark.dryRun) return;
    try {
      await Promise.resolve(this.deps.resolveAttention?.(itemId, 'Relay connection is back; per-peer checks resume.'));
      this.audit({ kind: 'resolved-aggregate', itemId });
    } catch (err) {
      this.aggregateOpen = true;
      this.audit({ kind: 'error', itemId, reason: `aggregate-resolve-failed:${err instanceof Error ? err.message : String(err)}` });
    }
  }

  /** Test/observability read: open per-peer episodes. */
  openEpisodes(): Array<{ peerFp: string; itemId: string; raisedAt: string }> {
    return [...this.episodes.entries()].map(([peerFp, e]) => ({ peerFp, itemId: e.itemId, raisedAt: new Date(e.raisedAtMs).toISOString() }));
  }
}
