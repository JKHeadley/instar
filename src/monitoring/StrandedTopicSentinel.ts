/**
 * StrandedTopicSentinel — a pure-signal, dark-gated monitoring sentinel that
 * detects a Telegram/Slack topic whose owner machine is online-but-unable-to-
 * serve and raises ONE aggregated attention item per (owner-machine, stranding
 * window). It MUTATES NOTHING — no ownership CAS, no pin write, no session kill.
 *
 * The wedge (proven live 2026-06-24): a durable ownership record names a machine
 * that is online-by-heartbeat but quota-walled or adapter-disconnected, while a
 * healthy machine holds the lease. Inbound routes to the owner that cannot serve
 * it → silently dead for that topic; outbound still flows from the healthy
 * machine (the "my replies send but his messages never arrive" split). The
 * existing OwnershipReconciler (Case C) only fires on a PROVABLY-DEAD owner, so a
 * walled-but-online owner defers forever — this sentinel covers that gap.
 *
 * Per tick (synchronous, LLM-free, acquires NO spawn-cap slot — asserted by test
 * so a future "ask an LLM if it's stranded" can never silently land on the
 * monitoring hot path):
 *   1. early no-op gates (< 2 machines / not lease-holder / pool view stale)
 *   2. evaluate the PURE decision over the in-memory ownership cache + pool view
 *   3. emit ONE aggregated attention item per owner stranding-window
 *   4. emit ONE separate LOW "can't-assess" item when ≥1 online owner was
 *      skipped for missing/unparseable rich heartbeat fields (anti-blind-spot)
 *
 * Spec: docs/specs/stranded-inbound-self-heal.md
 *
 * Signal-vs-authority: PURE SIGNAL. The only output is an advisory attention
 * item; it has no authority to misuse. (The auto-failover is a tracked v2 with
 * its prerequisites named in the spec.)
 */

import { EventEmitter } from 'node:events';
import type { SessionOwnershipRecord } from '../core/SessionOwnership.js';
import type { MachineCapacity } from '../core/types.js';
import type { ChannelScope } from '../core/machineServesChannel.js';
import {
  evaluateStrandedTopics,
  type StrandedTopic,
  type StrandReason,
} from './strandedTopicDecision.js';

export interface StrandedTopicSentinelConfig {
  enabled?: boolean;
  /** Tick cadence (ms). Default 60s. */
  tickMs?: number;
  /** Dwell the unable-to-serve condition must hold before emitting (ms). Default 30s. */
  dwellMs?: number;
  /** A beat older than this is not a genuine rich beat (ms). Default = failover threshold (45s). */
  freshnessBoundMs?: number;
  /** Owner must have ZERO stranded topics for N consecutive ticks before its
   *  window closes. Default 3. */
  clearAfterTicks?: number;
}

const DEFAULT_CONFIG: Required<StrandedTopicSentinelConfig> = {
  enabled: false,
  tickMs: 60_000,
  dwellMs: 30_000,
  freshnessBoundMs: 45_000,
  clearAfterTicks: 3,
};

/** The raise/update payload for the aggregated attention item. */
export interface StrandAttentionItem {
  id: string;
  title: string;
  summary: string;
  description: string;
  category: string;
  priority: 'LOW' | 'NORMAL';
  sourceContext: string;
  lane: 'agent-health';
  healthKey: string;
}

export interface StrandedTopicSentinelDeps {
  /** All known ownership records (the in-memory `all()` scan). */
  listOwnershipRecords: () => SessionOwnershipRecord[];
  /** The replicated machine-pool capacities (in-memory view). */
  listCapacities: () => MachineCapacity[];
  /** This machine's id (null on a single-machine agent → never strands). */
  selfMachineId: () => string | null;
  /** Whether this machine holds the serving lease. */
  holdsLease: () => boolean;
  /** Raise/update an attention item (the sole output). Never throws upward. */
  raiseAttention: (item: StrandAttentionItem) => void;
  /** Resolve a topic's ChannelScope (adapter arm). Optional. */
  resolveScope?: (sessionKey: string) => ChannelScope | undefined;
  /** Resolve a machine's display nickname (for the item text). */
  nicknameOf?: (machineId: string) => string;
  /** Override Date.now (tests). */
  now?: () => number;
}

export class StrandedTopicSentinel extends EventEmitter {
  private readonly cfg: Required<StrandedTopicSentinelConfig>;
  private tickHandle: ReturnType<typeof setInterval> | null = null;
  /** Liveness of the tick loop (GUARD-POSTURE §2.2): 0 = never ticked. */
  private lastTickAt = 0;
  /** Per-topic dwell anchor carried across ticks. */
  private strandedSince: Record<string, number> = {};
  /** Per-owner consecutive-empty-tick count (window close discipline). */
  private emptyTicks = new Map<string, number>();
  /** Per-owner open stranding-window id (the dwell-epoch of the first strand). */
  private windowId = new Map<string, number>();

  constructor(
    private readonly deps: StrandedTopicSentinelDeps,
    cfg: StrandedTopicSentinelConfig = {},
  ) {
    super();
    this.cfg = { ...DEFAULT_CONFIG, ...cfg };
  }

  start(): void {
    if (!this.cfg.enabled || this.tickHandle) return;
    this.tickHandle = setInterval(() => {
      try {
        this.tick();
      } catch (err) {
        // @silent-fallback-ok — pure-signal sentinel: a tick error must NEVER
        // propagate or degrade anything (it mutates nothing). The error is
        // surfaced as a 'tick-error' event for observability; swallowing the
        // throw IS the correct fail-closed behavior, not a hidden degradation.
        this.emit('tick-error', { err });
      }
    }, this.cfg.tickMs);
    if (typeof this.tickHandle.unref === 'function') this.tickHandle.unref();
  }

  stop(): void {
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
  }

  /** One synchronous scan pass. LLM-free, no spawn-cap slot, no peer probe. */
  tick(): void {
    const now = (this.deps.now ?? Date.now)();
    this.lastTickAt = now;
    if (!this.cfg.enabled) return;

    const selfId = this.deps.selfMachineId();
    if (!selfId) {
      // Single-machine agent (no mesh id) → strict no-op; drop any stale state.
      this.strandedSince = {};
      this.emptyTicks.clear();
      this.windowId.clear();
      return;
    }

    const result = evaluateStrandedTopics({
      records: this.deps.listOwnershipRecords(),
      capacities: this.deps.listCapacities(),
      selfMachineId: selfId,
      holdsLease: this.deps.holdsLease(),
      prevStrandedSince: this.strandedSince,
      now,
      cfg: { dwellMs: this.cfg.dwellMs, freshnessBoundMs: this.cfg.freshnessBoundMs },
      resolveScope: this.deps.resolveScope,
    });

    // Reconcile the dwell map (delete stale keys — spec step 2).
    this.strandedSince = result.nextStrandedSince;

    // Group the stranded set by owner for the aggregated item.
    const byOwner = new Map<string, StrandedTopic[]>();
    for (const s of result.strandedSet) {
      const list = byOwner.get(s.ownerMachineId) ?? [];
      list.push(s);
      byOwner.set(s.ownerMachineId, list);
    }

    // Emit / update one item per owner with a non-empty stranded set; advance
    // the window-close discipline for every owner we have tracked.
    const seenOwners = new Set<string>();
    for (const [owner, topics] of byOwner) {
      seenOwners.add(owner);
      this.emptyTicks.set(owner, 0);
      this.emitOwnerItem(owner, topics, now);
    }

    // Window close: an owner with no strand this tick increments its empty-tick
    // count; after clearAfterTicks it closes (drops its window).
    for (const owner of [...this.windowId.keys()]) {
      if (seenOwners.has(owner)) continue;
      const n = (this.emptyTicks.get(owner) ?? 0) + 1;
      if (n >= this.cfg.clearAfterTicks) {
        this.windowId.delete(owner);
        this.emptyTicks.delete(owner);
        this.emit('window-closed', { owner });
      } else {
        this.emptyTicks.set(owner, n);
      }
    }

    // Separate LOW "can't-assess" anti-blind-spot signal (spec step 4).
    if (result.cantAssessCount > 0) {
      this.emitCantAssessItem(result.cantAssessCount, now);
    }
  }

  private emitOwnerItem(owner: string, topics: StrandedTopic[], now: number): void {
    // The window-id is the FIRST qualifying strandedSince for this owner rounded
    // to the dwell epoch; it stays the same across a partial heal so the item
    // updates in place rather than spawning a new one (spec step 3).
    let windowId = this.windowId.get(owner);
    if (windowId === undefined) {
      const earliest = Math.min(...topics.map((t) => t.strandedSince));
      windowId = Math.floor(earliest / this.cfg.dwellMs) * this.cfg.dwellMs;
      this.windowId.set(owner, windowId);
    }

    const nick = this.deps.nicknameOf?.(owner) ?? owner;
    const reasons = new Set<StrandReason>(topics.map((t) => t.reason));
    const reasonText = [...reasons].join(' / ');
    const topicList = topics.map((t) => t.sessionKey).join(', ');
    const anyServable = topics.some((t) => t.servablePeerExists);
    const ageMs = Math.max(0, ...topics.map((t) => t.ownerBeatAgeMs ?? 0));

    const serveLine = anyServable
      ? 'another machine can serve them.'
      : 'no machine can currently serve them — fleet-wide wall.';

    const item: StrandAttentionItem = {
      id: `stranded-topic:${owner}:${windowId}`,
      title: `Inbound stranded on ${nick} (${topics.length} topic${topics.length === 1 ? '' : 's'})`,
      summary: `Topics owned by ${nick} (${reasonText}) — inbound can't reach a servable machine.`,
      description:
        `Inbound for topic(s) ${topicList} is going to ${nick}, which can't serve them ` +
        `(${reasonText}); ${serveLine} ` +
        `Based on ${nick}'s last full heartbeat ${Math.round(ageMs / 1000)}s ago.`,
      category: 'agent-health',
      priority: 'NORMAL',
      sourceContext: `stranded-topic:${owner}`,
      lane: 'agent-health',
      healthKey: `stranded-topic:${owner}:${windowId}`,
    };
    try {
      this.deps.raiseAttention(item);
      this.emit('stranded', { owner, windowId, topics });
    } catch (err) {
      // @silent-fallback-ok — the attention raise is the sentinel's only output;
      // if it throws, the correct signal-only behavior is to surface a
      // 'raise-error' event and continue (no degradation, nothing to fall back
      // to). Never let a raise failure crash the monitoring tick.
      this.emit('raise-error', { err });
    }
  }

  private emitCantAssessItem(count: number, now: number): void {
    const windowId = Math.floor(now / this.cfg.dwellMs) * this.cfg.dwellMs;
    const item: StrandAttentionItem = {
      id: `stranded-topic-blind:${windowId}`,
      title: `Can't assess ${count} online owner${count === 1 ? '' : 's'} for stranding`,
      summary: `${count} online owner machine${count === 1 ? '' : 's'} skipped — rich heartbeat fields missing.`,
      description:
        `I couldn't tell whether ${count} online machine${count === 1 ? ' is' : 's are'} able to serve their ` +
        `topics because their heartbeat is missing the quota/adapter fields. This is "I can't see", not "all clear" — ` +
        `a heartbeat/schema regression could be blinding the stranded-inbound detector.`,
      category: 'agent-health',
      priority: 'LOW',
      sourceContext: 'stranded-topic-blind',
      lane: 'agent-health',
      healthKey: 'stranded-topic-blind',
    };
    try {
      this.deps.raiseAttention(item);
      this.emit('cant-assess', { count });
    } catch (err) {
      // @silent-fallback-ok — signal-only: surface a 'raise-error' event and
      // continue; a raise failure must never crash the monitoring tick.
      this.emit('raise-error', { err });
    }
  }

  /** Sync in-memory runtime read for the GuardRegistry (GET /guards). MUST stay
   *  a cheap property read — no I/O. */
  guardStatus(): { enabled: boolean; lastTickAt: number } {
    return { enabled: this.cfg.enabled, lastTickAt: this.lastTickAt };
  }
}
