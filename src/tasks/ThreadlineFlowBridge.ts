/**
 * ThreadlineFlowBridge — resumes TaskFlow flows waiting on
 * `kind:'cross-agent-callback'` when a matching threadline message arrives.
 *
 * Identity is taken from the verified envelope (signature-verified for
 * cross-machine, Bearer-token-verified for same-machine). The bridge runs
 * AFTER `messageRouter.relay()` accepts the envelope, so authentication has
 * already happened upstream — bridge inspection is a no-op for unverified
 * messages because they never reach this layer.
 *
 * Correlation: senders embed `correlationId` in `envelope.message.payload`
 * (preferred) or as a `[correlation:<uuid>]` token in the message body
 * (fallback for plaintext-only channels).
 *
 * See docs/specs/OPENCLAW-IMPORT-TASKFLOW-SPEC.md § Architecture for the
 * design and § Threat Model for the spoof / replay defenses.
 */

import { TaskFlowRegistry } from './TaskFlowRegistry.js';
import { TaskFlowError } from './task-flow-types.js';
import type { MessageEnvelope } from '../messaging/types.js';

const CORRELATION_BODY_RE = /\[correlation:([0-9a-f][0-9a-f-]{8,63})\]/i;

export interface BridgeResult {
  /** true when at least one waiting flow was resumed by this message. */
  resumed: boolean;
  /** flowIds resumed by this call. */
  flowIds: string[];
  /** Why the bridge did NOT resume — present iff `resumed===false`. */
  reason?:
    | 'no-correlation-id'
    | 'no-thread-id'
    | 'no-matching-flow'
    | 'thread-id-mismatch'
    | 'agent-id-mismatch'
    | 'already-consumed'
    | 'resume-failed';
  /** Optional detail for debugging. */
  detail?: Record<string, unknown>;
}

export interface ThreadlineFlowBridgeOptions {
  registry: TaskFlowRegistry;
  /** Identifier passed to the registry as the system-waker principal. */
  wakerId?: string;
}

export class ThreadlineFlowBridge {
  private readonly registry: TaskFlowRegistry;
  private readonly wakerId: string;

  constructor(opts: ThreadlineFlowBridgeOptions) {
    this.registry = opts.registry;
    this.wakerId = opts.wakerId ?? 'ThreadlineFlowBridge';
  }

  /**
   * Inspect an inbound (already-verified) envelope and resume any TaskFlow
   * flow whose `cross-agent-callback` wait it satisfies. Returns a structured
   * result; never throws on routing/auth mismatches — those return
   * `resumed:false` with a `reason`. Throws only on unexpected internal errors.
   */
  async consumeInbound(envelope: MessageEnvelope): Promise<BridgeResult> {
    const correlationId = this.extractCorrelationId(envelope);
    if (!correlationId) {
      return { resumed: false, flowIds: [], reason: 'no-correlation-id' };
    }
    const threadId = envelope.message.threadId;
    if (!threadId) {
      return { resumed: false, flowIds: [], reason: 'no-thread-id' };
    }

    const matches = this.registry.findWaitingByCorrelation({
      waitKind: 'cross-agent-callback',
      correlationId,
    });
    if (matches.length === 0) {
      return { resumed: false, flowIds: [], reason: 'no-matching-flow' };
    }

    const senderAgent = envelope.message.from.agent;
    const resumed: string[] = [];
    let lastReason: BridgeResult['reason'] = undefined;
    let lastDetail: Record<string, unknown> | undefined;

    for (const m of matches) {
      const wait = m.waitJson;
      if (wait.kind !== 'cross-agent-callback') continue; // shape guard
      if (wait.threadId !== threadId) {
        lastReason = 'thread-id-mismatch';
        lastDetail = { flowId: m.flowId, expected: wait.threadId, actual: threadId };
        continue;
      }
      if (wait.expectedAgentId !== senderAgent) {
        lastReason = 'agent-id-mismatch';
        lastDetail = { flowId: m.flowId, expected: wait.expectedAgentId, actual: senderAgent };
        continue;
      }
      try {
        await this.registry.resumeFlow({
          flowId: m.flowId,
          expectedRevision: m.revision,
          waitInstanceId: m.waitInstanceId,
          principal: { scope: 'system-waker', wakerId: this.wakerId },
        });
        resumed.push(m.flowId);
        // Notify the owning controller so it can fetch the inbound message
        // from the messaging store and advance its step. We pass the
        // correlationId + threadId in the event so controllers don't have
        // to re-derive them from the flow row.
        this.registry.emit('taskflow:wait-fired', {
          flowId: m.flowId,
          controllerId: m.controllerId,
          waitKind: 'cross-agent-callback',
          correlationId,
          threadId,
          messageId: envelope.message.id,
        });
      } catch (err) {
        if (err instanceof TaskFlowError) {
          if (err.code === 'already_consumed') {
            lastReason = 'already-consumed';
            lastDetail = { flowId: m.flowId };
            continue;
          }
          if (err.code === 'revision_conflict' || err.code === 'already_terminal') {
            // The flow advanced or terminated between our find and our resume.
            // Skip — not an error worth surfacing to the caller.
            continue;
          }
        }
        lastReason = 'resume-failed';
        lastDetail = {
          flowId: m.flowId,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    if (resumed.length === 0) {
      return { resumed: false, flowIds: [], reason: lastReason, detail: lastDetail };
    }
    return { resumed: true, flowIds: resumed };
  }

  /**
   * Extract a correlationId. Preferred location is `payload.correlationId`;
   * fallback is the `[correlation:<id>]` body token, which lets agents reply
   * via plaintext-only channels (e.g., a Telegraph relay) without losing the
   * correlation key.
   */
  private extractCorrelationId(envelope: MessageEnvelope): string | undefined {
    const payload = envelope.message.payload;
    if (payload && typeof payload.correlationId === 'string' && payload.correlationId.length >= 16) {
      return payload.correlationId;
    }
    const body = envelope.message.body ?? '';
    const m = CORRELATION_BODY_RE.exec(body);
    return m ? m[1] : undefined;
  }

}
