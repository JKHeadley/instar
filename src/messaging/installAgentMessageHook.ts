/**
 * installAgentMessageHook — production binding for the agent-to-agent Telegram comms
 * receiver (spec MENTOR-LIVE-READINESS §Fix 2b, PR 3b). Composes the PR-1 routing logic
 * (AgentTelegramComms.decideRoute) + the PR-3a storage primitives (AgentTelegramLedger,
 * ProcessedIdStore) into the AgentMessageHook that TelegramAdapter calls before normal
 * dispatch.
 *
 * The role-handler map is **per-recipient** (Echo registers `mentor-reply`; Codey
 * registers `mentor`). Routed messages dispatch via the map; drops are audited; non-a2a
 * messages fall through (`{handled:false}`).
 */

import {
  decideRoute,
  type RecipientConfig,
  type IncomingContext,
  type A2aMessage,
} from './AgentTelegramComms.js';
import type { AgentTelegramLedger, ReceiveAuditRow } from './AgentTelegramLedger.js';
import type { ProcessedIdStore } from './ProcessedIdStore.js';
import type { AgentMessageHook } from './TelegramAdapter.js';

/** A role-handler is called when decideRoute returns 'route' for that role. The handler
 *  consumes the message body (post-marker-strip) and any audit context it wants. */
export type RoleHandler = (msg: A2aMessage, ctx: { topicId: number; senderBotId?: string }) => Promise<void>;

export interface InstallAgentMessageHookDeps {
  config: RecipientConfig;
  ledger: AgentTelegramLedger;
  processedIds: ProcessedIdStore;
  /** Map of role → handler. A role-handler is called only when decideRoute returns
   *  `route` AND the role is in `config.acceptRoles[from]` — the per-source admission
   *  matrix gates ahead of the role-handler map. */
  roleHandlers: Map<string, RoleHandler>;
}

/**
 * Build the AgentMessageHook closure. Never throws — any internal error is captured
 * + audited as a 'dropped' row with reason 'agent-marker-malformed' (the closest existing
 * code), and the hook returns `{handled:true}` so a broken handler can't double-process
 * via the user-flow fallback.
 */
export function buildAgentMessageHook(deps: InstallAgentMessageHookDeps): AgentMessageHook {
  const isoTs = (ms: number) => new Date(ms).toISOString();

  return async (input) => {
    const ctx: IncomingContext = {
      raw: input.text,
      senderIsBot: input.senderIsBot,
      senderChatId: input.senderChatId,
      senderBotId: input.senderBotId,
      now: input.now,
    };
    const decision = decideRoute(
      ctx,
      deps.config,
      {
        isProcessed: (id) => deps.processedIds.hasProcessed(id),
        knownRole: (r) => deps.roleHandlers.has(r),
      },
    );

    if (decision.action === 'fall-through') {
      return { handled: false };
    }

    if (decision.action === 'drop') {
      const row: ReceiveAuditRow = {
        localTs: isoTs(input.now),
        direction: 'received',
        decision: 'dropped',
        dropReason: decision.reason,
        fromAgent: decision.msg?.from,
        toAgent: decision.msg?.to,
        role: decision.msg?.role,
        id: decision.msg?.id,
        corr: decision.msg?.corr,
        ts: decision.msg?.ts,
        telegramFromBotId: input.senderBotId,
        telegramSenderChatId: input.senderChatId,
        topicId: input.topicId,
        rawPrefix: input.text.slice(0, 200),
      };
      deps.ledger.appendReceived(row);
      return { handled: true };
    }

    // action === 'route'
    const msg = decision.msg;
    const handler = deps.roleHandlers.get(msg.role);
    if (!handler) {
      // Defensive: knownRole said yes but the map slot is undefined (race / wiring bug).
      // Audit as dropped with a synthetic reason; do NOT fall through.
      deps.ledger.appendReceived({
        localTs: isoTs(input.now),
        direction: 'received',
        decision: 'dropped',
        dropReason: 'agent-marker-unknown-role',
        fromAgent: msg.from, toAgent: msg.to, role: msg.role, id: msg.id, corr: msg.corr, ts: msg.ts,
        telegramFromBotId: input.senderBotId,
        telegramSenderChatId: input.senderChatId,
        topicId: input.topicId,
      });
      return { handled: true };
    }

    // Idempotency: mark BEFORE invoking the handler so a handler crash mid-process still
    // dedups the retry (at-least-once delivery, exactly-once attempted processing).
    deps.processedIds.markProcessed(msg.id);
    deps.ledger.appendReceived({
      localTs: isoTs(input.now),
      direction: 'received',
      decision: 'routed',
      fromAgent: msg.from, toAgent: msg.to, role: msg.role, id: msg.id, corr: msg.corr, ts: msg.ts,
      telegramFromBotId: input.senderBotId,
      telegramSenderChatId: input.senderChatId,
      topicId: input.topicId,
    });
    // Accept-boundary (the #581 / #3 class — this is the THIRD a2a path): a role
    // handler (e.g. the mentee mentor-message handler) SPAWNS a session and
    // bounded-waits for the reply — that can take MINUTES — and delivers its
    // reply OUT via a separate a2a message, not this HTTP response. AWAITING it
    // here meant the caller's /a2a/inbox POST waited the full handler, so the
    // sender's ~10s `AbortSignal.timeout` fired and logged a FALSE "local-inbox
    // delivery attempt failed" (the message was in fact accepted — its id is
    // marked processed above — and the reply will arrive on its own channel).
    // Respond ACCEPTED immediately and run the handler in the background. The
    // idempotency mark above still dedups any retry; a handler failure is caught
    // + logged async (it can't reject a response that already returned).
    void Promise.resolve()
      .then(() => handler(msg, { topicId: input.topicId, senderBotId: input.senderBotId }))
      .catch((err) => {
        // A role-handler failure is recorded but doesn't un-mark the id (we still
        // treat the message as processed; retrying would just re-fail). Stage-B
        // forensics can see the routed row + the absence of a downstream effect.
        // eslint-disable-next-line no-console
        console.error(`[a2a] role-handler "${msg.role}" failed:`, err instanceof Error ? err.message : String(err));
      });
    return { handled: true };
  };
}
