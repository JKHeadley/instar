/**
 * handoffSentinelWiring — the outgoing-machine binding for the planned handoff
 * (spec §8 G3e). Counterpart to handoffReceiverWiring; extracted from server.ts
 * so the lease-yield orchestration is a tested unit, not inline boot code.
 *
 * Composes a HandoffSentinel whose ops are bound to the live components:
 *   - flush(): drive the live-tail so the standby is current, then POST the begin
 *     manifest to the peer. The manifest's threadHistoryHash is computed with the
 *     SAME canonical hash the incoming uses (handoffReceiverWiring.hashTopicHistory),
 *     so the incoming's recomputed echo can verify.
 *   - awaitAck(): the HandoffWireTransport's pending-ack promise.
 *   - validate(): Tier-1 readiness. v1 is deterministic (the sentinel's own
 *     ackMatches echo-verification is the substantive gate); a Haiku-class
 *     validator is the spec's upgrade path (tracked).
 *   - sendYield(): the explicit yield — the ONLY trigger for the incoming CAS.
 *   - demoteSelf(): step down to standby after the yield.
 *
 * The CRITICAL invariant (spec §8 G3e) lives in HandoffSentinel.initiate: the
 * outgoing NEVER yields unless the ack is verified AND validation passes; on any
 * failure it aborts and stays awake. This wiring only supplies the ops.
 */

import { HandoffSentinel } from './HandoffSentinel.js';
import type { FlushManifest, HandoffAck, HandoffOutcome } from './HandoffSentinel.js';
import type { IngressPosition } from './types.js';
import { hashTopicHistory, type ThreadEntry } from './handoffReceiverWiring.js';

export interface HandoffSentinelWiringDeps {
  /** Push the live tail so the standby's buffer is current before we flush. */
  pushTick: () => Promise<void>;
  /** This machine's current ingress position (telegram.getIngressPosition). */
  getIngressPosition: () => IngressPosition;
  /** Thread history for the hash (telegram.getTopicHistory) — same fn the receiver uses. */
  getTopicHistory: (topic: number, limit: number) => ThreadEntry[];
  /** The conversation topic to fence on (most-recently-active). undefined → empty hash. */
  activeTopic: () => number | undefined;
  /** Best-effort live-tail sequence echoed in the manifest (hash is the real check). */
  lastTailSeq?: () => number;
  /** POST the begin manifest to the peer (HandoffWireTransport.sendBegin). */
  postBegin: (manifest: FlushManifest & { topic?: number }) => Promise<boolean>;
  /** Await the incoming's ack (HandoffWireTransport.awaitAck). */
  awaitAck: (timeoutMs: number) => Promise<HandoffAck | null>;
  /** Send the explicit yield (HandoffWireTransport.sendYield). */
  sendYield: () => Promise<boolean>;
  /** Demote self to standby (coordinator.demoteToStandby). */
  demoteSelf: () => void | Promise<void>;
  /** Optional Tier-1 validator; default → deterministic pass (ackMatches is the gate). */
  validate?: (ack: HandoffAck, manifest: FlushManifest) => Promise<boolean>;
  handoffAckTimeoutMs: number;
  minHandoffIntervalMs: number;
  logger?: (msg: string) => void;
  onTerminal?: (outcome: HandoffOutcome, detail: string) => void;
}

export interface HandoffSentinelWiring {
  sentinel: HandoffSentinel;
  /** Run a planned handoff to completion (operator/test trigger). */
  initiate: () => Promise<HandoffOutcome>;
}

export function createHandoffSentinelWiring(deps: HandoffSentinelWiringDeps): HandoffSentinelWiring {
  const sentinel = new HandoffSentinel(
    {
      flush: async (): Promise<FlushManifest> => {
        await deps.pushTick();
        const topic = deps.activeTopic();
        const manifest: FlushManifest & { topic?: number } = {
          tailSeq: deps.lastTailSeq ? deps.lastTailSeq() : 0,
          ingressPosition: deps.getIngressPosition(),
          threadHistoryHash: hashTopicHistory(deps.getTopicHistory, topic),
          topic,
        };
        const posted = await deps.postBegin(manifest);
        if (!posted) throw new Error('begin POST to peer failed (no reachable peer or rejected)');
        return manifest;
      },
      awaitAck: (timeoutMs) => deps.awaitAck(timeoutMs),
      validate: deps.validate ?? (async () => true),
      sendYield: async () => {
        const ok = await deps.sendYield();
        if (!ok) throw new Error('yield POST to peer failed');
      },
      demoteSelf: async () => { await deps.demoteSelf(); },
    },
    {
      handoffAckTimeoutMs: deps.handoffAckTimeoutMs,
      minHandoffIntervalMs: deps.minHandoffIntervalMs,
      logger: deps.logger,
      onTerminal: deps.onTerminal,
    },
  );

  return {
    sentinel,
    initiate: () => sentinel.initiate(),
  };
}
