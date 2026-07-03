/**
 * deliverToConversation — the outbound funnel SKELETON
 * (docs/specs/durable-conversation-identity.md §5; §6.1 increment 1).
 *
 * A single delivery helper every follow-through consumer MIGRATES onto in the
 * later §6.1 increments. In increment 1 it ships with ZERO consumers and the
 * `id<0` arm dark-gated behind `conversationIdentity.followThrough` (§9:
 * `enabled` OMITTED → the developmentAgent gate resolves it — live-on-dev,
 * dark-fleet; `dryRun: true` FIRST because delivery is externally visible).
 *
 * §5.1 failure/dryRun contract: a funnel non-delivery is a TYPED,
 * NON-EXCEPTIONAL return the caller inspects — never a thrown exception, and
 * NEVER success-shaped. dryRun (and fleet-dark) return the SAME
 * `not-delivered` typed result the unresolvable path uses, plus a
 * `would-deliver` audit line — caller-visible as a non-delivery so beacon
 * retry / attention escalation keep engaging (A Refusal Stays a Refusal / P18).
 *
 * NOT in this skeleton (they land WITH their §6.1 increments, before any
 * consumer migrates onto the funnel): the §5.0(a) E1 ambiguous-outcome
 * idempotency guard + durable send-intent ops (increment 2, the proof
 * consumer), the §5 `deterministicKind` gate-exempt arm (increment 3), the
 * §5.2 P17 budgets (increment 5's attention migration), and the §5.1
 * permanent-error classification (increment 2).
 */
import type { ConversationRegistry } from './ConversationRegistry.js';

export interface DeliverOpts {
  isProxy?: boolean;
  source?: string;
  tier?: string;
  allowDuplicate?: boolean;
  messageKind?: string;
}

export type DeliveryOutcome =
  | { delivered: true; outcome: 'delivered' }
  | {
      delivered: false;
      outcome: 'not-delivered';
      reason:
        | 'follow-through-dark'
        | 'follow-through-dry-run'
        | 'unresolvable'
        | 'replicated-only-origin'
        | 'system-channel-suppressed'
        | 'no-slack-adapter'
        | 'send-failed'
        | 'telegram-send-failed';
      detail?: string;
    };

export interface ConversationDeliveryDeps {
  registry: ConversationRegistry;
  /** §9 followThrough gate state, resolved through resolveDevAgentGate at wiring. */
  followThrough: () => { enabled: boolean; dryRun: boolean };
  /** Today's Telegram path (`id > 0` arm) — queue/dedup/tone-gate untouched. */
  sendTelegram: (topicId: number, text: string, opts?: DeliverOpts) => Promise<boolean>;
  /** The local Slack adapter send (channel + thread_ts), when one exists. */
  sendSlack?: (channelId: string, text: string, threadTs?: string, opts?: DeliverOpts) => Promise<void>;
  /** §4: PresenceProxy's system-channel suppression moves INTO the funnel —
   *  standby/beacon noise never lands in dashboard/lifeline channels. */
  isSystemChannel?: (channelId: string) => boolean;
  /** `would-deliver` audit sink for dark/dry non-deliveries (§5.1). */
  auditWouldDeliver?: (line: string) => void;
  log?: (line: string) => void;
}

export type DeliverToConversation = (id: number, text: string, opts?: DeliverOpts) => Promise<DeliveryOutcome>;

export function createConversationDelivery(deps: ConversationDeliveryDeps): DeliverToConversation {
  return async (id: number, text: string, opts?: DeliverOpts): Promise<DeliveryOutcome> => {
    // id > 0 → today's Telegram path, all existing layers unchanged.
    if (id > 0) {
      try {
        const ok = await deps.sendTelegram(id, text, opts);
        return ok
          ? { delivered: true, outcome: 'delivered' }
          : { delivered: false, outcome: 'not-delivered', reason: 'telegram-send-failed' };
      } catch (err) {
        return {
          delivered: false,
          outcome: 'not-delivered',
          reason: 'telegram-send-failed',
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    }

    // id < 0 → minted conversation. Resolve FIRST so the dark/dry audit line
    // names the real target, then gate.
    const resolved = deps.registry.resolve(id);
    if (!resolved || resolved.platform !== 'slack') {
      return {
        delivered: false,
        outcome: 'not-delivered',
        reason: 'unresolvable',
        detail: `no local registry entry resolves ${id} (never minted on this machine, or id is 0)`,
      };
    }

    // KYP (§3.5/§7): delivery resolves ONLY local-origin entries. A pure
    // `replicated` entry is read-context until locally corroborated.
    if (resolved.origin === 'replicated') {
      return {
        delivered: false,
        outcome: 'not-delivered',
        reason: 'replicated-only-origin',
        detail: `entry for ${id} is replicated-only (advisory) — the owning machine delivers (§5.0)`,
      };
    }

    if (deps.isSystemChannel?.(resolved.channelId)) {
      return { delivered: false, outcome: 'not-delivered', reason: 'system-channel-suppressed' };
    }

    const gate = deps.followThrough();
    if (!gate.enabled) {
      return {
        delivered: false,
        outcome: 'not-delivered',
        reason: 'follow-through-dark',
        detail: 'conversationIdentity.followThrough is dark on this agent',
      };
    }
    if (gate.dryRun) {
      try {
        deps.auditWouldDeliver?.(
          `[conversation-delivery dryRun] would-deliver → ${resolved.channelId}${resolved.threadTs ? `:${resolved.threadTs}` : ''} (id ${id}, ${text.length} chars${opts?.source ? `, source=${opts.source}` : ''})`,
        );
      } catch {
        /* audit is observability */
      }
      return { delivered: false, outcome: 'not-delivered', reason: 'follow-through-dry-run' };
    }

    if (!deps.sendSlack) {
      return {
        delivered: false,
        outcome: 'not-delivered',
        reason: 'no-slack-adapter',
        detail: 'no local Slack adapter — the owning machine delivers (§5.0)',
      };
    }

    try {
      // Thread-level conversations deliver IN-THREAD (§5).
      await deps.sendSlack(resolved.channelId, text, resolved.threadTs ?? undefined, opts);
      return { delivered: true, outcome: 'delivered' };
    } catch (err) {
      return {
        delivered: false,
        outcome: 'not-delivered',
        reason: 'send-failed',
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  };
}
