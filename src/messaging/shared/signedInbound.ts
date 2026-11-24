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
import { aspTextHash } from '../../core/AspInboundClassifier.js';
import type { AspInboundClassifier } from '../../core/AspInboundClassifier.js';
import type { MessageAuthorship } from '../../core/AspAuthorshipJoin.js';
import { historyTextFor, stripFallbackSentences } from '../../core/inboundMedia.js';
import type { InboundMediaRef } from '../../core/inboundMedia.js';

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
 * The text the classifier was given at log time, rebuilt from what a reader
 * holds (SEC-106 decision 5a). Plain text and voice log the content as-is. A
 * message with files logs `historyTextFor(caption, media)` (the lifeline route
 * and the polling photo/document sites); the routed content is
 * `composeInboundPayload(caption, media)`, whose file sentences lead, so the
 * caption comes back with `stripFallbackSentences` (re-escaping is idempotent).
 * A parity test pins that this equals what each log site logged.
 */
export function aspClassifiedText(content: string, media?: ReadonlyArray<InboundMediaRef> | null): string {
  const text = typeof content === 'string' ? content : '';
  if (!Array.isArray(media) || media.length === 0) return text;
  return historyTextFor(stripFallbackSentences(text, media), media);
}

/**
 * The signing agent's id when the classifier's OWN verdict for THIS message's
 * text is `agent-verified`; null otherwise (human, rejected, unclassified,
 * evicted, a different message under the same key, no classifier). A
 * different text is counted (`hashMismatch`, or `hashMismatchReplay` for a
 * replay, whose label comes from the ledger copy). Never throws — a helper on
 * the delivery path must not.
 */
export function resolveSignedByAgent(
  classifier: Pick<AspInboundClassifier, 'lookupVerdict'> | null | undefined,
  topicId: number | null | undefined,
  messageId: number | null | undefined,
  classifiedText: string,
  /** `count: false` for a read that is not the ingress label read (one message counts once). */
  opts?: { replay?: boolean; count?: boolean },
): string | null {
  try {
    if (!classifier) return null;
    const r = classifier.lookupVerdict(topicId, messageId, aspTextHash(typeof classifiedText === 'string' ? classifiedText : ''));
    if (r.kind === 'hash-mismatch') {
      if (opts?.count === false) return null;
      if (opts?.replay === true) signedInboundCounters.hashMismatchReplay += 1;
      else signedInboundCounters.hashMismatch += 1;
      return null;
    }
    if (r.kind !== 'hit' || r.verdict.classification !== 'agent-verified') return null;
    return sanitizeSignedAgentId(r.verdict.agentId);
  } catch {
    /* @silent-fallback-ok: a labelling helper must never break delivery; an
       unlabelled message is today's behaviour, a dropped one is a regression. */
    return null;
  }
}

/** Shown for an envelope label that is present but not a valid agent id (display only). */
export const UNKNOWN_AGENT_LABEL = 'unknown-agent';

/**
 * The one reader of a carried label (SEC-106 decision 3). Present and valid →
 * the id. Present but invalid → `unknown-agent` (still agent-written, never
 * dropped). Absent (`undefined`, `null` or a missing key) → null.
 */
export function labelFromEnvelope(envelope: { signedByAgent?: unknown } | null | undefined): string | null {
  if (!envelope || typeof envelope !== 'object' || !('signedByAgent' in envelope)) return null;
  const raw = (envelope as { signedByAgent?: unknown }).signedByAgent;
  if (raw === undefined || raw === null) return null;
  return sanitizeSignedAgentId(raw) ?? UNKNOWN_AGENT_LABEL;
}

/** Delivery paths a carried label is framed on (decision 9). E counts under the path it re-enters. */
export type SignedLabelPath = 'live' | 'A' | 'B' | 'C' | 'D' | 'F';

export interface SignedInboundCounters {
  delivered: Record<SignedLabelPath, number>;
  invalid: number;
  disagree: number;
  hashMismatch: number;
  hashMismatchReplay: number;
}

/** In-process, since boot, per machine. Counts only — never ids or text. */
export const signedInboundCounters: SignedInboundCounters = {
  delivered: { live: 0, A: 0, B: 0, C: 0, D: 0, F: 0 },
  invalid: 0,
  disagree: 0,
  hashMismatch: 0,
  hashMismatchReplay: 0,
};

/** A copy for the authed `/health` extension. */
export function signedInboundSnapshot(): SignedInboundCounters {
  return {
    delivered: { ...signedInboundCounters.delivered },
    invalid: signedInboundCounters.invalid,
    disagree: signedInboundCounters.disagree,
    hashMismatch: signedInboundCounters.hashMismatch,
    hashMismatchReplay: signedInboundCounters.hashMismatchReplay,
  };
}

/** Test seam. */
export function resetSignedInboundCounters(): void {
  for (const k of Object.keys(signedInboundCounters.delivered) as SignedLabelPath[]) signedInboundCounters.delivered[k] = 0;
  signedInboundCounters.invalid = 0;
  signedInboundCounters.disagree = 0;
  signedInboundCounters.hashMismatch = 0;
  signedInboundCounters.hashMismatchReplay = 0;
}

/**
 * The label to FRAME a message with, from its carried envelope, counted once
 * (decision 9). Every framing site goes through this, so no path frames
 * without counting. Returns undefined when there is nothing to frame.
 */
export function framingLabel(
  envelope: { signedByAgent?: unknown } | null | undefined,
  path: SignedLabelPath,
  where?: { topicId?: number | string; messageId?: number | string },
): string | undefined {
  const label = labelFromEnvelope(envelope);
  if (!label) return undefined;
  if (label === UNKNOWN_AGENT_LABEL && sanitizeSignedAgentId((envelope as { signedByAgent?: unknown }).signedByAgent) !== UNKNOWN_AGENT_LABEL) {
    signedInboundCounters.invalid += 1;
  } else {
    signedInboundCounters.delivered[path] += 1;
  }
  console.log(`[signed-inbound] topic ${where?.topicId ?? '?'} message ${where?.messageId ?? '?'} framed agent-signed (path ${path})`);
  return label;
}

/**
 * Ingress reconciliation (decisions 6 and 10). `classifier` is the fresh,
 * text-bound verdict for the platform id; `carried` is the in-process ledger
 * copy (`ledgerSignedByAgent`, or `replaySignedByAgent` on a replay). The
 * label is applied if ANY source says agent-written — absence never wins —
 * with the classifier's id preferred; a disagreement is logged and counted.
 */
export function reconcileSignedLabel(
  classifier: string | null,
  carried: unknown,
  where?: { topicId?: number | string; messageId?: number | string },
): string | null {
  const L = carried === undefined || carried === null ? null : labelFromEnvelope({ signedByAgent: carried });
  if (classifier && L && classifier !== L) {
    signedInboundCounters.disagree += 1;
    console.log(`[signed-label-disagree] topic ${where?.topicId ?? '?'} message ${where?.messageId ?? '?'} classifier=${classifier} carried=${L}`);
  }
  return classifier ?? L;
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
