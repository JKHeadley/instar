/**
 * Agent-signed inbound messages — the routing-side helpers.
 *
 * An agent can SIGN a message and deliver it through a human's account (the
 * "tenet-5 channel": this agent driving the operator's logged-in Telegram).
 * Cryptographically the infrastructure already knows who wrote it — the ASP
 * classifier records the verdict at log time. But that verdict lived only in
 * a ledger: the RECEIVING session was still told the message came `from
 * <the human>`, and the topic-operator auto-bind still seated that human as
 * the topic's verified operator on the strength of a message they did not
 * write. That is the identity-bleed rule 28 (Know Your Principal) forbids.
 *
 * These helpers close it structurally, in the one place both ingress paths
 * converge. Every decision reads IN-PROCESS state (the classifier's own
 * verdict, keyed by platform message id) — never message content, so a body
 * that merely claims to be signed cannot mint the label.
 *
 * AUTHORITY BOUNDARY: the label says WHO wrote the message. It grants nothing
 * and it withholds one thing only — operator auto-bind from a message the
 * account holder did not author.
 */
import type { AspInboundClassifier } from '../../core/AspInboundClassifier.js';
import type { MessageAuthorship } from '../../core/AspAuthorshipJoin.js';

/** Agent ids are constrained by the ASP tag grammar; keep the label to that charset. */
const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function sanitizeSignedAgentId(agentId: unknown): string | null {
  return typeof agentId === 'string' && AGENT_ID_RE.test(agentId) ? agentId : null;
}

/**
 * The platform (Telegram) message id of an inbound Message, from whichever
 * ingress built it. The polling path stamps `id: "tg-<messageId>"`; the
 * lifeline-forward path carries the raw id separately in
 * `metadata.telegramMessageId` because its `id` may hold a Date.now fallback
 * that must never be read as a platform id.
 */
export function resolveInboundTelegramMessageId(msg: {
  id?: string;
  metadata?: Record<string, unknown>;
}): number | null {
  const meta = msg.metadata ?? {};
  if (meta.viaLifeline === true) {
    const raw = meta.telegramMessageId;
    const n = typeof raw === 'number' ? raw : Number(typeof raw === 'string' ? raw : NaN);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  const m = typeof msg.id === 'string' ? /^tg-(\d+)$/.exec(msg.id) : null;
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The signing agent's id when the classifier's OWN verdict for this message is
 * `agent-verified`; null otherwise (human, rejected, unclassified, no
 * classifier). Never throws — a helper on the delivery path must not.
 */
export function resolveSignedByAgent(
  classifier: Pick<AspInboundClassifier, 'verdictFor'> | null | undefined,
  topicId: number | null | undefined,
  messageId: number | null | undefined,
): string | null {
  try {
    const verdict = classifier?.verdictFor(topicId, messageId) ?? null;
    if (!verdict || verdict.classification !== 'agent-verified') return null;
    return sanitizeSignedAgentId(verdict.agentId);
  } catch {
    /* @silent-fallback-ok: a labelling helper must never break delivery; an
       unlabelled message is today's behaviour, a dropped one is a regression. */
    return null;
  }
}

/**
 * Operator auto-bind is refused for an agent-signed message: the account holder
 * did not author it, so it is not evidence that they are present, let alone
 * that they are the operator. Everything else keeps today's behaviour.
 */
export function operatorAutoBindPermitted(signedByAgent: string | null | undefined): boolean {
  return !signedByAgent;
}

/**
 * The sender label a thread-history line shows. Reads the read-time authorship
 * join (the durable ledger's verdict), so a fresh session's bootstrap history
 * tells the same truth the live injection tag tells.
 */
export function historySenderLabel(m: {
  fromUser: boolean;
  senderName?: string;
  authorship?: MessageAuthorship | string;
  authorshipAgentId?: string | null;
}): string {
  if (!m.fromUser) return 'Agent';
  const human = m.senderName || 'User';
  if (m.authorship === 'agent-verified') {
    const agent = sanitizeSignedAgentId(m.authorshipAgentId) ?? 'unknown';
    return `agent ${agent} (signed, via ${human}'s account)`;
  }
  return human;
}
