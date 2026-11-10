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
import { FoldCoordinator, FoldRecordStore, type FoldEvent, type FoldPreconditions } from './FoldCoordinator.js';
import { defaultFoldCarriers } from './foldCarriers.js';
import { createFoldLeaseLockForAgent } from '../core/foldLeaseFactory.js';

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
  /** The replicated layer kind; absent until that slice ships. */
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
