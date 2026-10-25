/**
 * relayAckNode — one agent's relay `gate-passed` consumer, built from the SAME
 * production pieces `handleGatePassedRelayMessage` in src/commands/server.ts
 * composes, in the same order:
 *
 *   runRelayInboundWithLedger → isAutoAckInbound → runRelayAckStage
 *     → recordInboundAck → evaluateAndRecordInbound → router
 *     → relayAck.settle(outcome)
 *
 * ACT-091: our own ack is deferred for every inbound and settled with the
 * routing outcome — `no-reply` when the warrants gate suppresses, otherwise the
 * router's delivered report (`routerDelivers`, default true: a session got it).
 *
 * The server.ts handler itself is a closure inside the server boot (it cannot be
 * imported); tests/unit/threadline/ack-stage-wiring.test.ts pins that the real
 * handler keeps this order. `legacy: true` reproduces the handler as it was
 * BEFORE docs/specs/a2a-ack-never-acked.md (an older peer): the ack is a plain
 * `chat` message, text recognition only spares the reply waiter, and the ack is
 * acked and routed like any other message.
 */

import { runRelayInboundWithLedger, type RelayGatePassedDecision } from '../../src/threadline/inboundIdLedgerWiring.js';
import { InboundMessageGate } from '../../src/threadline/InboundMessageGate.js';
import { InboundIdLedger } from '../../src/threadline/InboundIdLedger.js';
import { A2ADeliveryTracker } from '../../src/threadline/A2ADeliveryTracker.js';
import { recordInboundAck } from '../../src/threadline/recordInboundAck.js';
import { ConversationStore } from '../../src/threadline/ConversationStore.js';
import { WarrantsReplyGate, evaluateAndRecordInbound } from '../../src/threadline/WarrantsReplyGate.js';
import {
  DEFAULT_AUTO_ACK_MESSAGE,
  createAckRateLimiter,
  isAutoAckInbound,
  runRelayAckStage,
  createRelayAckSettler,
  type RelayAckSettler,
} from '../../src/threadline/autoAck.js';

/** The slice of ThreadlineClient the handler uses to answer. */
export interface AckWire {
  sendAck(recipient: string, text: string, threadId?: string): unknown;
  sendPlaintext(recipient: string, text: string, threadId?: string): unknown;
}

export interface RelayAckNode {
  /** Feed one `gate-passed` decision (resolves when handling finished). */
  handle(decision: RelayGatePassedDecision & { trustLevel?: string }): Promise<void>;
  /** Acks THIS node put on the wire. */
  acksSent: Array<{ to: string; threadId?: string }>;
  /** The text of each ack in `acksSent`, in order. */
  ackTexts: string[];
  /** Messages that reached the router (each one is a session spawn/resume). */
  routed: Array<{ from: string; text: string; threadId?: string }>;
  /** Messages that reached the warrants-a-reply gate. */
  gated: Array<{ text: string; suppressed: boolean; signal: string }>;
  ledger: InboundIdLedger;
  tracker: A2ADeliveryTracker;
  store: ConversationStore;
  close(): void;
}

export function createRelayAckNode(opts: {
  stateDir: string;
  wire: AckWire;
  legacy?: boolean;
  ackRateLimit?: number;
  autoAckMessage?: string;
  /** Did the router hand the message to a live session? Default: yes. */
  routerDelivers?: () => boolean;
}): RelayAckNode {
  const ledger = InboundIdLedger.openMemory();
  const tracker = A2ADeliveryTracker.openMemory();
  const store = new ConversationStore(opts.stateDir);
  const gate = new WarrantsReplyGate(); // deterministic signals only
  const isAckRateLimited = createAckRateLimiter(opts.ackRateLimit ?? 5, 60_000);
  const node: RelayAckNode = {
    acksSent: [], ackTexts: [], routed: [], gated: [], ledger, tracker, store,
    close: () => { ledger.close(); tracker.close(); },
    handle: async (decision) => {
      await runRelayInboundWithLedger(
        decision,
        {
          ledger: () => ledger,
          tracker: () => tracker,
          extractMessageId: (m) => InboundMessageGate.extractMessageId(m as never),
        },
        async (ticket) => {
          const msg = decision.message!;
          const senderFingerprint = msg.from;
          const senderName = senderFingerprint.slice(0, 8);
          const trustLevel = decision.trustLevel ?? 'untrusted';
          const c = msg.content as Record<string, unknown> | string;
          const textContent = typeof c === 'string' ? c : String(c.content ?? c.text ?? JSON.stringify(c));
          const msgType = typeof c === 'object' && c !== null ? c.type : undefined;
          const recordDelivery = () => recordInboundAck(
            { a2aDeliveryTracker: tracker },
            { threadId: msg.threadId, senderFingerprint, senderName },
          );

          let relayAck: RelayAckSettler | null = null;
          if (opts.legacy) {
            // The handler before the fix: every non-status message is acked as `chat`.
            if (trustLevel !== 'untrusted' && msgType !== 'status' && !isAckRateLimited(senderFingerprint)) {
              opts.wire.sendPlaintext(senderFingerprint, opts.autoAckMessage ?? DEFAULT_AUTO_ACK_MESSAGE, msg.threadId);
              node.acksSent.push({ to: senderFingerprint, threadId: msg.threadId });
              node.ackTexts.push(opts.autoAckMessage ?? DEFAULT_AUTO_ACK_MESSAGE);
            }
          } else {
            const ackDeps = {
              autoAckEnabled: true,
              autoAckMessage: opts.autoAckMessage,
              isAckRateLimited,
              sendAck: (to: string, text: string, threadId?: string) => {
                opts.wire.sendAck(to, text, threadId);
                node.acksSent.push({ to, threadId });
                node.ackTexts.push(text);
              },
              recordDelivery,
            };
            const ackInput = {
              isAutoAck: isAutoAckInbound({ type: msgType, text: textContent }),
              trustLevel, msgType, senderFingerprint, threadId: msg.threadId, ticket,
              deferSend: true,
            };
            relayAck = createRelayAckSettler(ackDeps, ackInput);
            const stage = runRelayAckStage(ackDeps, ackInput);
            if (stage === 'ack-consumed') return;
          }

          recordDelivery();
          const verdict = await evaluateAndRecordInbound(gate, store, {
            threadId: msg.threadId ?? `auto-${senderFingerprint}`,
            text: textContent,
            senderFingerprint,
            senderName,
            trustLevel,
            humanInLoop: false,
          });
          node.gated.push({ text: textContent, suppressed: verdict.suppress, signal: verdict.verdict.signal });
          if (verdict.suppress) { ticket?.recordNoReply(); relayAck?.settle('no-reply'); return; }
          node.routed.push({ from: senderFingerprint, text: textContent, threadId: msg.threadId });
          const delivered = opts.routerDelivers ? opts.routerDelivers() : true;
          if (delivered) ticket?.recordHandoff('cold');
          relayAck?.settle(delivered ? 'router-delivered' : 'router-undelivered');
        },
      );
    },
  };
  return node;
}
