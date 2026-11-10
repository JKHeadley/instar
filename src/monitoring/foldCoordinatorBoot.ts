/**
 * Server-boot construction of the FoldCoordinator and its boot sweep
 * (context-budget-layered-summaries §9.3: "A boot sweep for folds
 * (`recoverPendingFolds` …) executes on the same unconditional synchronous
 * path as the inbound sweep, before it").
 *
 * Phase 0 posture: the coordinator exists and its sweep runs on every boot,
 * but **no fold can begin** — the sentinel heartbeat precondition is false
 * until the ContextBudgetSentinel ships (Phase 0 task 10), the layer kind is
 * absent until task 9, and on a pool whose placement is live the owner is
 * `unknown` until ownership records are consulted. Every one of those reads
 * as a named `fold-skipped` reason, never as a fold.
 */
import path from 'node:path';
import { FoldCoordinator, FoldRecordStore, TERMINAL_STATES, type FoldEvent, type FoldPreconditions } from './FoldCoordinator.js';
import { FoldHoldStore } from './FoldHoldStore.js';
import { defaultFoldCarriers } from './foldCarriers.js';
import { createFoldLeaseLockForAgent, FOLD_LOCK_TTL_CEILING_MS } from '../core/foldLeaseFactory.js';

export interface FoldBootDeps {
  stateDir: string;
  /** Running sessions on this machine with their topic (Telegram topic id as a string). */
  runningTopicSessions: () => Array<{ topicKey: string }>;
  /** Is the multi-machine pool's placement live (any stage other than dark/off)? */
  poolPlacementLive: () => boolean;
  /** Will the Durable Inbound Message Queue drain this boot (enabled, not dry-run, pool gate open)? */
  inboundQueueLive: () => boolean;
  /** Does TopicMemory hold rows for the topic? */
  topicRowsPresent: (topicKey: string) => boolean;
  /** The ContextBudgetSentinel's heartbeat; absent until that slice ships (⇒ no fold begins). */
  sentinelHeartbeatFresh?: () => boolean;
  /** Is the replicated layer kind registered on this build (the §14 skew rule)? Absent ⇒ false. */
  layerKindPresent?: () => boolean;
  onEvent?: (e: FoldEvent) => void;
}

export function buildFoldCoordinator(d: FoldBootDeps): { coordinator: FoldCoordinator; holderId: string } {
  const { lock, holderId } = createFoldLeaseLockForAgent(d.stateDir);
  const hosts = (topicKey: string) => d.runningTopicSessions().filter((s) => s.topicKey === topicKey).length;
  const preconditions: FoldPreconditions = {
    isOwner: (topicKey) => {
      if (d.poolPlacementLive()) return 'unknown'; // ownership records are not consulted yet: never act
      return hosts(topicKey) > 0;
    },
    sentinelHeartbeatFresh: () => d.sentinelHeartbeatFresh?.() ?? false,
    // Phase 1 adds the channel-neutral row writer; today only Telegram topics (numeric keys) have rows.
    hasRowSource: (topicKey) => /^\d+$/.test(topicKey),
    exactlyOneLiveSession: (topicKey) => hosts(topicKey) === 1,
    inboundQueueLive: () => d.inboundQueueLive(),
    layerKindPresent: () => d.layerKindPresent?.() ?? false,
    topicRowsPresent: (topicKey) => d.topicRowsPresent(topicKey),
    // Single machine / dark pool: the host is the owner by default, so its own
    // crashed fold is resolved at boot even if the topic's session died with it.
    isSweepOwner: () => !d.poolPlacementLive(),
  };
  const coordinator = new FoldCoordinator({
    store: new FoldRecordStore(d.stateDir),
    lock,
    machineId: holderId,
    preconditions,
    ownerEpoch: () => null, // pool placement dark ⇒ no ownership record (§9.3)
    carriers: defaultFoldCarriers(d.stateDir),
    ...(d.onEvent ? { onEvent: d.onEvent } : {}),
  });
  return { coordinator, holderId };
}

/**
 * The egress fold hold, built the way the server builds it (§10): its record
 * reads go to the same fold-record store the coordinator writes, its refusals
 * are audited, and its known-holds set is rebuilt from disk. Register its
 * carrier on the coordinator BEFORE the boot sweep.
 */
export function buildFoldHolds(d: {
  stateDir: string;
  onUnreadable?: (e: { topicKey: string; foldId?: string; error?: string }) => void;
  /** An expired hold whose fold record is missing or torn is still refusing sends. */
  onStaleUnresolved?: (e: { topicKey: string; foldId?: string }) => void;
}): FoldHoldStore {
  const records = new FoldRecordStore(d.stateDir);
  const staleReported = new Set<string>();
  const holds = new FoldHoldStore({
    stateDir: d.stateDir,
    ttlCeilingMs: FOLD_LOCK_TTL_CEILING_MS,
    recordOpen: (topicKey, foldId) => {
      const r = records.get(topicKey, foldId);
      return r ? !TERMINAL_STATES.has(r.state) : null;
    },
    auditFile: path.join(d.stateDir, 'state', 'context-layers', '_fold-hold-audit.jsonl'),
    ...(d.onUnreadable || d.onStaleUnresolved ? { onAudit: (e) => {
      if (e.type === 'fold-hold-unreadable') d.onUnreadable?.(e);
      else if (e.type === 'fold-hold-stale-unresolved') {
        // Once per fold per process: every refused send would otherwise report again.
        const k = `${e.topicKey}/${e.foldId ?? ''}`;
        if (!staleReported.has(k)) { staleReported.add(k); d.onStaleUnresolved?.(e); }
      }
    } } : {}),
  });
  holds.rebuild();
  return holds;
}
