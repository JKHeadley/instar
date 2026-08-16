/**
 * handoffSentinelBootWiring — binds the outgoing planned-handoff sentinel to the
 * LIVE server components (Telegram adapter, coordinator, live-tail source, wire
 * transport). Extracted from server.ts boot so the glue — active-topic selection
 * and dependency binding — is a tested unit rather than inline boot code. This
 * mirrors handoffReceiverWiring (Testing Integrity Standard: DI components get
 * wiring-integrity tests; spec §8 G3e / §10).
 *
 * server.ts calls this once inside the live-tail block (where liveTailSource is
 * in scope) and exposes the returned `initiate` behind POST /handoff/initiate +
 * `sentinel.inProgress` as the race guard.
 */

import { createHandoffSentinelWiring, type HandoffSentinelWiring } from './handoffSentinelWiring.js';
import type { HandoffAck } from './HandoffSentinel.js';
import type { IngressPosition } from './types.js';
import type { ThreadEntry } from './handoffReceiverWiring.js';

/** The slice of the Telegram adapter the boot wiring needs. */
export interface SentinelBootTelegram {
  getIngressPosition: () => IngressPosition;
  getTopicHistory: (topic: number, limit: number) => ThreadEntry[];
  getKnownTopicIds: () => number[];
}
/** The slice of the coordinator the boot wiring needs. */
export interface SentinelBootCoordinator {
  demoteToStandby: (reason: string) => void;
}
/** The slice of the live-tail source the boot wiring drives before flushing. */
export interface SentinelBootLiveTail {
  pushTick: () => Promise<unknown>;
}
/** The slice of the wire transport the boot wiring uses (outgoing side). */
export interface SentinelBootWire {
  sendBegin: (manifest: unknown) => Promise<boolean>;
  awaitAck: (timeoutMs: number) => Promise<HandoffAck | null>;
  sendYield: () => Promise<boolean>;
}

export interface HandoffSentinelBootDeps {
  telegram: SentinelBootTelegram;
  coordinator: SentinelBootCoordinator;
  liveTailSource: SentinelBootLiveTail;
  wire: SentinelBootWire;
  handoffAckTimeoutMs: number;
  minHandoffIntervalMs: number;
  logger?: (msg: string) => void;
}

/**
 * Pick the topic to fence the handoff on: the most-recently-active one.
 * getTopicHistory returns entries in chronological order capped at the last N,
 * so the final entry is the newest. Falls back to the first known topic id.
 */
export function pickActiveTopic(
  getKnownTopicIds: () => number[],
  getTopicHistory: (topic: number, limit: number) => ThreadEntry[],
): number | undefined {
  const ids = getKnownTopicIds();
  let best: number | undefined;
  let bestTs = -Infinity;
  for (const id of ids) {
    const hist = getTopicHistory(id, 50);
    const last = hist[hist.length - 1];
    const ts = last ? Date.parse(last.timestamp) : NaN;
    if (Number.isFinite(ts) && ts > bestTs) {
      bestTs = ts;
      best = id;
    }
  }
  return best ?? ids[0];
}

export function createHandoffSentinelBootWiring(deps: HandoffSentinelBootDeps): HandoffSentinelWiring {
  // Closures preserve `this` for the adapter methods.
  const getKnownTopicIds = () => deps.telegram.getKnownTopicIds();
  const getTopicHistory = (topic: number, limit: number) => deps.telegram.getTopicHistory(topic, limit);

  return createHandoffSentinelWiring({
    pushTick: async () => { await deps.liveTailSource.pushTick(); },
    getIngressPosition: () => deps.telegram.getIngressPosition(),
    getTopicHistory,
    activeTopic: () => pickActiveTopic(getKnownTopicIds, getTopicHistory),
    postBegin: (manifest) => deps.wire.sendBegin(manifest),
    awaitAck: (timeoutMs) => deps.wire.awaitAck(timeoutMs),
    sendYield: () => deps.wire.sendYield(),
    demoteSelf: () => deps.coordinator.demoteToStandby('planned handoff: yielded to peer'),
    handoffAckTimeoutMs: deps.handoffAckTimeoutMs,
    minHandoffIntervalMs: deps.minHandoffIntervalMs,
    logger: deps.logger,
  });
}
