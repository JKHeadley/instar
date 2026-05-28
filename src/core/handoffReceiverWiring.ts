/**
 * handoffReceiverWiring — the incoming-machine binding for the planned handoff
 * (spec §8 G3d/G3e). Extracted from server.ts so the wiring is a tested unit
 * (Testing Integrity Standard: DI components get wiring-integrity tests) rather
 * than inline closures in the boot path.
 *
 * It composes a HandoffReceiver with ops bound to the live components:
 *   - begin route → onBegin(manifest, from): stores the outgoing's flush manifest
 *     and drives receiver.onBeginHandoff (build + send the caught-up ack).
 *   - buildAck: echoes the manifest's tailSeq + ingressPosition and RECOMPUTES the
 *     thread-history hash from THIS machine's own synced state — it matches the
 *     outgoing's only if the live-tail kept us caught up. Never trusts the
 *     manifest's own hash blindly.
 *   - yield route → yieldHandler(): receiver.onYield → acquireLeaseOnConsent. The
 *     lease CAS is attempted ONLY here, never on the ack (closes the two-holders
 *     race, spec §8 G3e).
 *
 * The hash is computed with the SAME canonical formatting LiveTailSource uses for
 * the tail content, so both machines hash identical bytes for the same history.
 */

import { createHash } from 'node:crypto';
import { HandoffReceiver } from './HandoffReceiver.js';
import type { HandoffAck } from './HandoffSentinel.js';
import type { IngressPosition } from './types.js';

/** A thread entry as LiveTailSource formats it (timestamp + text). */
export interface ThreadEntry {
  timestamp: string;
  text: string;
}

/**
 * Canonical thread-history hash — identical on both machines for the same
 * history. Exported so the OUTGOING flush (HandoffSentinel) hashes the same way.
 */
export function hashTopicHistory(
  getTopicHistory: (topic: number, limit: number) => ThreadEntry[],
  topic: number | undefined,
): string {
  const h = createHash('sha256');
  if (topic != null && Number.isFinite(Number(topic))) {
    const entries = getTopicHistory(Number(topic), 500);
    h.update(entries.map((e) => `[${e.timestamp}] ${e.text}`).join('\n') + (entries.length ? '\n' : ''));
  }
  return h.digest('hex');
}

export interface HandoffBeginManifest {
  tailSeq: number;
  ingressPosition: IngressPosition;
  threadHistoryHash: string;
  topic?: number;
}

export interface HandoffReceiverWiringDeps {
  /** Push the caught-up ack to the outgoing machine (HandoffWireTransport.sendAck). */
  sendAck: (ack: HandoffAck) => Promise<boolean>;
  /** Acquire the lease on the verified yield (coordinator.acquireLeaseOnConsent). */
  acquireLeaseOnConsent: (fromMachineId: string) => Promise<boolean>;
  /** Thread history for the hash (telegram.getTopicHistory). */
  getTopicHistory: (topic: number, limit: number) => ThreadEntry[];
  logger?: (msg: string) => void;
}

export interface HandoffReceiverWiring {
  receiver: HandoffReceiver;
  /** Bind to the /api/handoff/begin route (AgentServer onHandoffBegin). */
  onBegin: (manifest: unknown, fromMachineId: string) => void;
  /** Register on the HandoffWireTransport so a yield drives the lease CAS. */
  yieldHandler: () => void;
}

export function createHandoffReceiverWiring(deps: HandoffReceiverWiringDeps): HandoffReceiverWiring {
  let pendingManifest: HandoffBeginManifest | null = null;
  let pendingFrom: string | null = null;

  const receiver = new HandoffReceiver(
    {
      buildAck: async (): Promise<HandoffAck> => {
        const m = pendingManifest;
        if (!m) throw new Error('no pending handoff manifest');
        return {
          tailSeq: m.tailSeq,
          ingressPosition: m.ingressPosition,
          threadHistoryHash: hashTopicHistory(deps.getTopicHistory, m.topic),
        };
      },
      sendAck: (ack) => deps.sendAck(ack),
      acquireOnYield: () => deps.acquireLeaseOnConsent(pendingFrom ?? ''),
    },
    {
      logger: deps.logger,
      onTerminal: (s, detail) => deps.logger?.(`[handoff-recv] ${s}: ${detail}`),
    },
  );

  return {
    receiver,
    onBegin: (manifest, from) => {
      pendingManifest = manifest as HandoffBeginManifest;
      pendingFrom = from;
      void receiver.onBeginHandoff();
    },
    yieldHandler: () => { void receiver.onYield(); },
  };
}
