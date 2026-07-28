/**
 * deliverToConversation — the outbound funnel
 * (docs/specs/durable-conversation-identity.md §5; §6.1 increments 1–2).
 *
 * A single delivery helper every follow-through consumer migrates onto. The
 * `id<0` arm is dark-gated behind `conversationIdentity.followThrough` (§9:
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
 * Increment 2 (the proof consumer) adds:
 *  - the §5.0(a) E1 ambiguous-outcome idempotency guard (durable send-intent /
 *    ambiguous-send / send-retire journal ops; retirement-based LOGICAL lane
 *    for callers with a logical send identity, WINDOW-based CONTENT-HASH lane
 *    for callers without one — R3-M1/R7-M2/R8-M1);
 *  - the §3.5.2 bind-pin overlay + record-carried `boundTuple` delivery rule
 *    with the SHARED id↔tuple coherence check (R4-M1/R5-M2/R6-M4);
 *  - the §5.1 permanent-vs-transient classification over
 *    `SlackApiError.slackError` (+ the L5 drift canary), the reachability
 *    flip/auto-clear, flap dampening, and mass-unreachable aggregation.
 *
 * Still NOT here (their §6.1 increments): the `deterministicKind` gate-exempt
 * arm (increment 3), the §5.2 P17 budgets (increment 5).
 */
import { createHash } from 'node:crypto';
import type { ConversationRegistry } from './ConversationRegistry.js';
import {
  ConversationTuple,
  idWithinCoherenceBound,
  routingKeyForTuple,
  SLACK_CHANNEL_ID_RE,
  SLACK_THREAD_TS_RE,
} from './conversationIdentity.js';

export interface DeliverOpts {
  isProxy?: boolean;
  source?: string;
  tier?: string;
  allowDuplicate?: boolean;
  messageKind?: string;
  /**
   * §5.0(a) STABLE logical send identity (`<commitmentId>:<sendSeq>` for
   * beacon sends — the §3.4 pinned encoding). A caller supplying its own
   * logicalSendId MUST also define its retirement events (R8-low-2); a caller
   * that cannot name them belongs on the content-hash window lane (omit this).
   */
  logicalSendId?: string;
  /**
   * §3.5.2 property 5: the binding record's denormalized bind-time tuple.
   * Delivery targets `resolve(boundTuple)` when present AND coherent with the
   * binding's stored id — the uniform every-machine delivery rule.
   */
  boundTuple?: { platform: string; channelId: string; threadTs: string | null };
}

export type DeliveryOutcome =
  | { delivered: true; outcome: 'delivered' }
  /** §5.0(a): DELIVERED-EQUIVALENT for sequencing (R7-M1) — the caller treats
   *  it as delivered (no re-escalation, seq advances) so suppression can never
   *  mute the beacon. */
  | { delivered: false; outcome: 'already-delivered-recently' }
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
        | 'telegram-send-failed'
        | 'conversation-unreachable'
        | 'conversation-binding-incoherent'
        | 'binding-target-unresolved';
      detail?: string;
      /** §5.1: true ONLY for the pinned permanent error set — the beacon
       *  treats it as TERMINAL (dead-letter), never an infinite retry. */
      permanent?: boolean;
      /** §5/I1 dead-letter scoping: a by-design non-owning/unresolvable
       *  refusal — the beacon STANDS DOWN (bounded ownership recheck), and this
       *  NEVER increments the dead-letter counter. */
      standDown?: boolean;
    };

/** §5.1 pinned PERMANENT `chat.postMessage` error codes — the code is
 *  `is_archived`, NOT `channel_archived` (adversarial-A2/codex-X4). DISTINCT
 *  from the adapter's token-scoped `SlackApiError.permanent` set. */
export const CONVERSATION_UNREACHABLE_ERRORS = new Set(['is_archived', 'channel_not_found', 'not_in_channel']);

/** L5 drift canary: an unrecognized permanent-SHAPED channel-state code is
 *  treated TRANSIENT (safe default — the beacon retries) + ONE deduped
 *  attention item so the pinned set can be updated. */
const PERMANENT_SHAPED_RE = /archiv|not_found|not_in_|restricted|access_denied/;

/** Network failures that are positive PRE-ACCEPT evidence (never posted). */
const CLEAN_NETWORK_RE = /\b(ECONNREFUSED|ENOTFOUND|EAI_AGAIN)\b/;

/** Content-hash lane length gate — mirrors the Telegram exact-duplicate
 *  dedup's `minLength` (brief acks are never suppressed). */
export const CONTENT_HASH_MIN_LENGTH = 40;

/** §5.1 R2-lessons-2/P17 pinned emitter coalescing window (mass-unreachable). */
export const UNREACHABLE_COALESCING_WINDOW_MS = 60000;

export type SlackSendErrorClass =
  | { kind: 'permanent'; code: string }
  | { kind: 'permanent-shaped-unknown'; code: string }
  | { kind: 'clean-transient'; detail: string }
  | { kind: 'ambiguous'; detail: string };

/**
 * Classify a Slack-arm send failure (§5.1 + §5.0(a) R2-security-NEW-3).
 * A `SlackApiError` means Slack ANSWERED `ok:false` — positive evidence the
 * message did NOT post (clean), further split permanent/canary/transient.
 * A pre-accept network refusal is clean. Everything else (timeout, reset,
 * unknown) is AMBIGUOUS — the message may actually have posted, so the E1
 * suppressor IS recorded (only a CLEAN failure forbids recording).
 */
export function classifySlackSendError(err: unknown): SlackSendErrorClass {
  const anyErr = err as { slackError?: unknown } | null;
  const slackError = anyErr && typeof anyErr.slackError === 'string' ? anyErr.slackError : null;
  if (slackError) {
    if (CONVERSATION_UNREACHABLE_ERRORS.has(slackError)) return { kind: 'permanent', code: slackError };
    if (PERMANENT_SHAPED_RE.test(slackError)) return { kind: 'permanent-shaped-unknown', code: slackError };
    return { kind: 'clean-transient', detail: slackError };
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (CLEAN_NETWORK_RE.test(msg)) return { kind: 'clean-transient', detail: msg };
  return { kind: 'ambiguous', detail: msg };
}

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
  /** ONE deduped attention item per episode (incoherent binding, pin redirect,
   *  drift canary, mass-unreachable summary, non-owning heal paths). */
  onAttention?: (dedupeKey: string, title: string, body: string) => void;
  log?: (line: string) => void;
  /** Test override for the mass-unreachable coalescing window. */
  coalescingWindowMs?: number;
}

export type DeliverToConversation = (id: number, text: string, opts?: DeliverOpts) => Promise<DeliveryOutcome>;

/** Shape-clamp a caller-supplied boundTuple (§3.5.2: a malformed/forged tuple
 *  falls back to `resolve(id)` — never a crash, never an unclamped tuple applied). */
function clampBoundTuple(raw: DeliverOpts['boundTuple']): ConversationTuple | null {
  if (!raw || raw.platform !== 'slack' || typeof raw.channelId !== 'string') return null;
  if (!SLACK_CHANNEL_ID_RE.test(raw.channelId)) return null;
  const threadTs = raw.threadTs ?? null;
  if (threadTs !== null && (typeof threadTs !== 'string' || !SLACK_THREAD_TS_RE.test(threadTs))) return null;
  return { platform: 'slack', channelId: raw.channelId, threadTs };
}

export function createConversationDelivery(deps: ConversationDeliveryDeps): DeliverToConversation {
  const attention = (dedupeKey: string, title: string, body: string): void => {
    try {
      deps.onAttention?.(dedupeKey, title, body);
    } catch {
      /* @silent-fallback-ok — attention is observability; a failed raise never gates delivery */
    }
  };

  // ── §5.1 mass-unreachable aggregation (R2-lessons-2/P17): terminal
  // dead-letters within one coalescing window collapse into ONE summary item —
  // a bot-removed-from-workspace event yields ONE item, not N. ──
  const windowMs = deps.coalescingWindowMs ?? UNREACHABLE_COALESCING_WINDOW_MS;
  let unreachableBatch: Array<{ id: number; channelId: string }> = [];
  let unreachableTimer: NodeJS.Timeout | null = null;
  const flushUnreachable = (): void => {
    const batch = unreachableBatch;
    unreachableBatch = [];
    unreachableTimer = null;
    if (batch.length === 0) return;
    const list = batch.map((b) => `${b.id} (${b.channelId})`).join(', ');
    attention(
      batch.length === 1 ? `conversation-unreachable:${batch[0].id}` : 'conversation-unreachable:mass',
      `${batch.length} conversation(s) became unreachable`,
      `Permanent Slack delivery errors flipped reachability to 'unreachable' for: ${list}. Bot removed from the workspace/channel, or the channel was archived? Reachability auto-clears on the next successful delivery or authenticated inbound (§5.1).`,
    );
  };
  const reportUnreachable = (entryId: number, channelId: string, dampened: boolean): void => {
    if (dampened) {
      // R3-minor flap dampening: ONE per-window flap item instead of a fresh
      // cross-window dead-letter per archived↔unarchived bounce episode.
      attention(
        `conversation-reachability-flap:${entryId}`,
        'Conversation reachability is flapping',
        `Conversation ${entryId} (${channelId}) flipped between reachable/unreachable more than the flap threshold within 24h. Further flips this window update state silently.`,
      );
      return;
    }
    unreachableBatch.push({ id: entryId, channelId });
    if (!unreachableTimer) {
      unreachableTimer = setTimeout(flushUnreachable, windowMs);
      unreachableTimer.unref?.();
    }
  };

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

    // ── id < 0 → minted conversation. Resolve the delivery TARGET through the
    // §3.5.2 overlay FIRST (record-carried boundTuple, then the local
    // journaled pin), so the dark/dry audit line names the real target. ──
    const boundTuple = clampBoundTuple(opts?.boundTuple);
    let overlayTuple: ConversationTuple | null = null;
    if (boundTuple) {
      // Delivery-time id↔tuple coherence (R5-M2, SHARED predicate — the same
      // implementation the §3.5 ingest check uses). Coherence-STABILITY holds
      // for every legitimate flow, so an incoherent pair affirmatively proves
      // corruption: typed refusal, NEVER a delivery on either field (R6-M4).
      if (!idWithinCoherenceBound(id, boundTuple)) {
        attention(
          `conversation-binding-incoherent:${id}`,
          'Durable binding failed the id↔tuple coherence check',
          `A binding stored topicId ${id} beside boundTuple ${routingKeyForTuple(boundTuple)}, but the id is not within MAX_PROBE_DISTANCE of the tuple's candidate (§3.5.2 R5-M2). This proves corruption of one field; delivery is refused on BOTH (typed conversation-binding-incoherent — the beacon re-arms, the N-fail dead-letter escalates).`,
        );
        return {
          delivered: false,
          outcome: 'not-delivered',
          reason: 'conversation-binding-incoherent',
          detail: `stored id ${id} incoherent with boundTuple ${routingKeyForTuple(boundTuple)}`,
        };
      }
      overlayTuple = boundTuple;
    } else {
      overlayTuple = deps.registry.getBindPinTuple(id);
    }

    let resolved: ReturnType<ConversationRegistry['resolve']>;
    if (overlayTuple) {
      // §3.5.2 property 3/5: the target is the pin's tuple at its CURRENT
      // assignment — resolve(tuple), not resolve(id).
      resolved = deps.registry.resolveByKey(routingKeyForTuple(overlayTuple));
      if (!resolved || resolved.platform !== 'slack') {
        // Pin-tuple pending-mint degradation (§3.5.2): typed non-delivery +
        // one deduped attention — the beacon retries; never a misdeliver.
        attention(
          `conversation-binding-pending:${id}`,
          'Durable binding target has no current assignment',
          `The bind-time tuple ${routingKeyForTuple(overlayTuple)} for binding id ${id} is in the pending-mint state (no current registry assignment). Delivery returns a typed non-delivery; the beacon retries.`,
        );
        return {
          delivered: false,
          outcome: 'not-delivered',
          reason: 'binding-target-unresolved',
          detail: `bound tuple ${routingKeyForTuple(overlayTuple)} has no current assignment`,
        };
      }
      if (resolved.id !== id) {
        // The first time a pin actually REDIRECTS: ONE deduped attention item
        // per pin episode (per pin, not per message) — visible, never silent.
        attention(
          `conversation-bind-redirect:${id}`,
          'A durable binding redirected through its bind-time tuple',
          `Binding id ${id} now delivers into ${routingKeyForTuple(overlayTuple)} (current assignment ${resolved.id}) — a later merge/re-mint moved the id, and the bound consumer's messages still land in the conversation the promise was made in (§3.5.2 property 3).`,
        );
      }
    } else {
      resolved = deps.registry.resolve(id);
      if (!resolved || resolved.platform !== 'slack') {
        attention(
          `conversation-non-owning:${id}`,
          'A minted-conversation delivery was requested on a machine that cannot resolve it',
          `No local registry entry resolves ${id} (never minted on this machine, or id is 0). Heal paths: deliver from the owning machine (§5.0), or enable multiMachine.stateSync.conversations (§6.1 step 9) for multi-machine Slack follow-through.`,
        );
        return {
          delivered: false,
          outcome: 'not-delivered',
          reason: 'unresolvable',
          detail: `no local registry entry resolves ${id} (never minted on this machine, or id is 0)`,
          standDown: true,
        };
      }
    }

    // KYP (§3.5/§7): delivery resolves ONLY local-origin entries. A pure
    // `replicated` entry is read-context until locally corroborated.
    if (resolved.origin === 'replicated') {
      attention(
        `conversation-non-owning:${id}`,
        'A minted-conversation delivery was requested on a non-owning machine',
        `The entry for ${id} is replicated-only (advisory) — the owning machine delivers (§5.0). Heal paths: ownership adoption on first authenticated inbound, or the §11.2 owner/lease reconciliation.`,
      );
      return {
        delivered: false,
        outcome: 'not-delivered',
        reason: 'replicated-only-origin',
        detail: `entry for ${id} is replicated-only (advisory) — the owning machine delivers (§5.0)`,
        standDown: true,
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
      attention(
        `conversation-non-owning:${id}`,
        'A minted-conversation delivery was requested with no local Slack adapter',
        `No local Slack adapter — the owning machine delivers (§5.0). Heal paths: deliver from the machine holding the Slack socket.`,
      );
      return {
        delivered: false,
        outcome: 'not-delivered',
        reason: 'no-slack-adapter',
        detail: 'no local Slack adapter — the owning machine delivers (§5.0)',
        standDown: true,
      };
    }

    // ── §5.0(a) E1 ambiguous-outcome idempotency guard (LIVE sends only) ──
    // Lane selection (R7-M2): a caller-supplied logical send identity rides the
    // retirement-based lane; everyone else rides the WINDOW-based content-hash
    // lane, length-gated exactly like the Telegram dedup (brief acks never
    // suppressed). `allowDuplicate` bypasses for a deliberate operator resend.
    const normalized = text.replace(/\s+/g, ' ').trim();
    let lane: 'logical' | 'content-hash' | null = null;
    let sendId: string | null = null;
    if (opts?.logicalSendId) {
      lane = 'logical';
      sendId = opts.logicalSendId;
    } else if (normalized.length >= CONTENT_HASH_MIN_LENGTH) {
      lane = 'content-hash';
      sendId = `sha256:${createHash('sha256').update(normalized).digest('hex').slice(0, 32)}`;
    }

    if (lane && sendId && !opts?.allowDuplicate && deps.registry.isSendSuppressed(id, sendId, lane)) {
      return { delivered: false, outcome: 'already-delivered-recently' };
    }

    // Durable SEND-INTENT (R6-M1): fsynced BEFORE the transport send — beacon
    // sends are minutes apart, so the extra fsync is off any hot path.
    if (lane && sendId) {
      try {
        deps.registry.recordSendIntent(id, sendId, lane);
      } catch {
        /* @silent-fallback-ok — a failed intent write degrades toward the
           pre-E1 posture for THIS send (delivery still proceeds; identity/
           bookkeeping never costs a message, §3.6). */
      }
    }

    try {
      // Thread-level conversations deliver IN-THREAD (§5).
      await deps.sendSlack(resolved.channelId, text, resolved.threadTs ?? undefined, opts);
      // Suppressor recorded ONLY after positive likely-posted evidence — the
      // deployed Telegram precedent (R2-security-NEW-3). Retirement (seq
      // advance + send-retire) is the CALLER's under the R5-M3 pinned order.
      if (lane && sendId) {
        try {
          deps.registry.recordLikelyPosted(id, sendId, lane);
        } catch {
          /* @silent-fallback-ok — guard bookkeeping never turns a delivered
             message into a failure (§3.6 fail-toward-delivery). */
        }
      }
      // §5.1 reachability auto-clear on the next successful delivery.
      if (resolved.reachability === 'unreachable') {
        try {
          deps.registry.setReachability(resolved.id, 'ok');
        } catch {
          /* @silent-fallback-ok — advisory metadata */
        }
      }
      return { delivered: true, outcome: 'delivered' };
    } catch (err) {
      const cls = classifySlackSendError(err);
      if (cls.kind === 'permanent') {
        // §5.1: positive not-posted evidence — resolve the intent (no
        // suppressor), flip reachability idempotently, aggregate the
        // dead-letter at the emitter.
        if (lane && sendId) {
          try {
            deps.registry.resolveSendIntent(id, sendId);
          } catch {
            /* @silent-fallback-ok — see above */
          }
        }
        try {
          const flip = deps.registry.setReachability(resolved.id, 'unreachable');
          if (flip.changed) reportUnreachable(resolved.id, resolved.channelId, flip.dampened);
        } catch {
          /* @silent-fallback-ok — advisory metadata */
        }
        return {
          delivered: false,
          outcome: 'not-delivered',
          reason: 'conversation-unreachable',
          permanent: true,
          detail: cls.code,
        };
      }
      if (cls.kind === 'permanent-shaped-unknown') {
        // L5 drift canary: NOT silently mis-bucketed — transient (safe
        // default, the beacon retries) + ONE deduped attention item.
        if (lane && sendId) {
          try {
            deps.registry.resolveSendIntent(id, sendId);
          } catch {
            /* @silent-fallback-ok */
          }
        }
        attention(
          `slack-permanent-drift:${cls.code}`,
          'Unrecognized permanent-shaped Slack error (drift canary)',
          `chat.postMessage returned "${cls.code}" — permanent-SHAPED but not in the pinned set {is_archived, channel_not_found, not_in_channel}. Treated TRANSIENT (safe default — the beacon retries). If Slack added a channel-state code, update the pinned set (§5.1 L5).`,
        );
        return { delivered: false, outcome: 'not-delivered', reason: 'send-failed', detail: cls.code };
      }
      if (cls.kind === 'clean-transient') {
        // Positive evidence the message never posted — the retry must NOT be
        // suppressed (R2-security-NEW-3): resolve the intent, record nothing.
        if (lane && sendId) {
          try {
            deps.registry.resolveSendIntent(id, sendId);
          } catch {
            /* @silent-fallback-ok */
          }
        }
        return { delivered: false, outcome: 'not-delivered', reason: 'send-failed', detail: cls.detail };
      }
      // AMBIGUOUS (timeout/reset/unknown — the message may have posted):
      // record the suppressor so the re-fire of the SAME logical send is
      // suppressed whenever it arrives (§5.0(a)).
      if (lane && sendId) {
        try {
          deps.registry.recordLikelyPosted(id, sendId, lane);
        } catch {
          /* @silent-fallback-ok */
        }
      }
      return {
        delivered: false,
        outcome: 'not-delivered',
        reason: 'send-failed',
        detail: `ambiguous: ${cls.detail}`,
      };
    }
  };
}
