/**
 * ScopeAccretionRatifier — the conversational ratification path
 * (proposal → server-authored enumeration → confirmation), consumed ONLY at
 * the server's live Telegram receive path (R45).
 *
 * Spec: docs/specs/autonomous-scope-accretion-completion.md §2.6
 * (R23/R37/R38/R45). Both the defer-vocabulary trigger detection AND the
 * confirmation matching run as each inbound topic message passes through the
 * server's own Telegram receive handling — the on-disk history JSONL is NOT
 * part of the mechanism (a message the server did not itself receive from
 * Telegram can never trigger or confirm). Matched events persist as
 * server-owned records in the run record.
 *
 * Display integrity (Agent Proposes, Operator Approves): the operator approves
 * a SERVER-authored statement whose displayed set is byte-identical to what
 * executes — the enumeration is composed here, sent under the server's own bot
 * credentials, and its message id recorded; a confirmation binds exactly the
 * enumerated set via the message-id chain.
 */

import { createHash } from 'crypto';
import type { AutonomousRunStore, AutonomousRunRecord } from './AutonomousRunStore.js';
import { hashPathSet } from './AutonomousRunStore.js';

/** Frontloaded defer-intent vocabulary (§2.6 trigger list). */
const DEFER_VOCABULARY = [
  'defer',
  'later session',
  "don't build",
  'dont build',
  'skip building',
  'leave for a future',
  'ratify deferral',
] as const;

const AFFIRMATIVES = ['yes', 'approve', 'confirm', 'approved', 'confirmed', '\u{1F44D}'] as const;

/** Enumeration clamp (§2.6): 50 paths + "and N more". */
const ENUMERATION_CLAMP = 50;

export interface InboundReceiveEvent {
  topicId: number;
  text: string;
  /** The AUTHENTICATED platform sender id (Know Your Principal). */
  senderUid: string;
  messageId: number;
  replyToMessageId?: number;
  /** Message date (ms epoch). */
  at: number;
}

/**
 * Parse a RAW Telegram receive-path message object (the `update.message` /
 * Bot-API `result` shape, as JSON text) into the InboundReceiveEvent fields
 * the ratification matchers consume. Registered parser (Scrape/Parser Fixture
 * Realness) — fed byte-for-byte captured REAL Telegram message objects in
 * tests/fixtures/captured/scope-accretion-telegram-receive/. Returns null on
 * anything that is not a well-formed text message object.
 */
export function parseReceivePathMessage(rawJson: string): InboundReceiveEvent | null {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(rawJson) as Record<string, unknown>;
  } catch {
    /* @silent-fallback-ok — a malformed receive-path payload matches NOTHING:
       fail-closed for ratification (the one path that pushes toward exit). */
    return null;
  }
  if (!msg || typeof msg !== 'object') return null;
  const text = typeof msg.text === 'string' ? msg.text : '';
  const messageId = typeof msg.message_id === 'number' ? msg.message_id : NaN;
  if (!text || !Number.isFinite(messageId)) return null;
  const from = (msg.from ?? {}) as Record<string, unknown>;
  const reply = (msg.reply_to_message ?? null) as Record<string, unknown> | null;
  const threadId = typeof msg.message_thread_id === 'number' ? msg.message_thread_id : 1;
  const date = typeof msg.date === 'number' ? msg.date * 1000 : Date.now();
  return {
    topicId: threadId,
    text,
    senderUid: from && typeof from.id === 'number' ? String(from.id) : '',
    messageId,
    replyToMessageId: reply && typeof reply.message_id === 'number' ? reply.message_id : undefined,
    at: date,
  };
}

/**
 * Deterministic defer-intent trigger match (registered parser — fed captured
 * Telegram receive-path payloads in tests/fixtures/captured/). Returns the
 * matched phrase or null.
 */
export function parseDeferTrigger(text: string): string | null {
  const lc = (text || '').toLowerCase();
  for (const phrase of DEFER_VOCABULARY) {
    if (lc.includes(phrase)) return phrase;
  }
  return null;
}

export interface ConfirmationMatch {
  /** The enumeration the confirmation binds (message-id chain), or null. */
  boundSetHash: string | null;
  affirmative: boolean;
  replyAnchored: boolean;
  ratifyToken: boolean;
}

/**
 * Confirmation matching (R38 — strict, the one path that pushes toward exit):
 * ONLY a verified-operator message that is reply-anchored to the recorded
 * enumeration message OR contains the explicit token "ratify", with
 * affirmative content, binds — and it binds exactly the enumerated set. A bare
 * affirmative NOT reply-anchored resolves to the EMPTY set. (Registered
 * parser — captured receive-path payloads incl. reply_to_message shapes.)
 */
export function parseRatificationConfirmation(
  evtOrRaw: { text: string; replyToMessageId?: number } | string,
  enumerations: Array<{ setHash: string; messageId: number }>,
): ConfirmationMatch {
  // Accept a RAW receive-path message object (JSON text) directly — the
  // captured-fixture tests feed the real bytes; live callers pass the
  // already-derived event. An unparseable raw payload matches nothing.
  const evt = typeof evtOrRaw === 'string'
    ? (parseReceivePathMessage(evtOrRaw) ?? { text: '', replyToMessageId: undefined })
    : evtOrRaw;
  const lc = (evt.text || '').toLowerCase().trim();
  const affirmative = AFFIRMATIVES.some((a) => lc === a || lc.startsWith(`${a} `) || lc.includes(` ${a}`) || lc.includes(a === '\u{1F44D}' ? a : `${a}.`) || lc === `${a}!`);
  const ratifyToken = /\bratify\b/.test(lc);
  let anchored: { setHash: string; messageId: number } | undefined;
  if (typeof evt.replyToMessageId === 'number') {
    anchored = enumerations.find((e) => e.messageId === evt.replyToMessageId);
  }
  const replyAnchored = !!anchored;
  if (!affirmative && !ratifyToken) {
    return { boundSetHash: null, affirmative, replyAnchored, ratifyToken };
  }
  if (anchored && (affirmative || ratifyToken)) {
    return { boundSetHash: anchored.setHash, affirmative, replyAnchored, ratifyToken };
  }
  if (ratifyToken && affirmative && enumerations.length > 0) {
    // Explicit "ratify" token without a reply anchor binds the most recent
    // recorded enumeration (§2.6: "or a message containing the explicit token
    // 'ratify'"). Still bound by the message-id chain: the LAST enumeration.
    return { boundSetHash: enumerations[enumerations.length - 1].setHash, affirmative, replyAnchored, ratifyToken };
  }
  // A bare affirmative NOT reply-anchored resolves to the EMPTY set (R38).
  return { boundSetHash: null, affirmative, replyAnchored, ratifyToken };
}

export interface RatifierDeps {
  store: AutonomousRunStore;
  /** Verified operator uid for a topic (TopicOperatorStore) — null = unbound. */
  getOperatorUid: (topicId: number) => string | null;
  /** Server-credentialed send (TelegramAdapter.sendToTopic shape, R37). */
  sendToTopic: (topicId: number, text: string) => Promise<{ messageId: number }>;
  /** Dashboard deep link to the PIN-gated ratify surface (one-tap path). */
  dashboardLink?: (topicId: string) => string | null;
  recordMetric?: (outcome: 'fired' | 'noop') => void;
  log?: (msg: string) => void;
}

export class ScopeAccretionRatifier {
  constructor(private readonly deps: RatifierDeps) {}

  /**
   * Observe one inbound topic message from the LIVE receive path. Signal-only
   * for message delivery: never blocks, never rewrites — errors are swallowed
   * after logging (the receive path must never fail because of this observer).
   */
  async observeInbound(evt: InboundReceiveEvent): Promise<void> {
    try {
      await this.observeInboundInner(evt);
    } catch (err) {
      this.deps.log?.(`[scope-accretion] ratifier observe error (ignored): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async observeInboundInner(evt: InboundReceiveEvent): Promise<void> {
    const topicId = String(evt.topicId);
    const rec = this.deps.store.getRecord(topicId);
    if (!rec || !this.deps.store.isActive(rec, evt.at)) return;

    // Know Your Principal: only the VERIFIED operator of this topic participates
    // (TopicOperatorStore uid match on the authenticated sender id).
    const operatorUid = this.deps.getOperatorUid(evt.topicId);
    if (!operatorUid || operatorUid !== String(evt.senderUid)) return;

    // 1) Confirmation matching FIRST (an affirmative reply must not be re-read
    //    as a fresh trigger).
    const match = parseRatificationConfirmation(
      { text: evt.text, replyToMessageId: evt.replyToMessageId },
      rec.enumerations.map((e) => ({ setHash: e.setHash, messageId: e.messageId })),
    );
    if (match.boundSetHash) {
      const enumRec = rec.enumerations.find((e) => e.setHash === match.boundSetHash);
      if (enumRec && enumRec.artifacts.length > 0) {
        this.deps.store.update(topicId, rec.runId, (r) => {
          for (const p of enumRec.artifacts) {
            if (!r.ratifiedArtifacts.includes(p)) r.ratifiedArtifacts.push(p);
          }
          r.ratifications.push({
            via: 'conversation',
            at: new Date(evt.at).toISOString(),
            artifacts: [...enumRec.artifacts],
            enumerationMessageId: enumRec.messageId,
            confirmationMessageId: evt.messageId,
            verifiedOperatorUidHash: createHash('sha256').update(String(evt.senderUid)).digest('hex'),
          });
        });
        this.deps.recordMetric?.('fired');
        await this.deps.sendToTopic(
          evt.topicId,
          `Deferral ratified for ${enumRec.artifacts.length} artifact${enumRec.artifacts.length === 1 ? '' : 's'} — the completion gate no longer holds on them.`,
        ).catch(() => { /* best-effort ack */ });
        return;
      }
    }
    if (match.affirmative && !match.replyAnchored && !match.ratifyToken) {
      // R38: a busy topic's unrelated "yes" ratifies NOTHING — resolved to the
      // empty set, no record, no send.
      return;
    }

    // 2) Trigger detection — defer-intent vocabulary within the window
    //    [max(started_at, oldest unbuilt artifact ts), now] (§2.6).
    const phrase = parseDeferTrigger(evt.text);
    if (!phrase) return;
    const unbuilt = rec.lastUnbuilt ?? [];
    if (unbuilt.length === 0) {
      // A pre-accretion blanket "defer those" alone ratifies NOTHING; with no
      // computed unbuilt set there is nothing to enumerate.
      return;
    }
    const oldestUnbuiltTs = unbuilt.reduce(
      (min, u) => Math.min(min, Date.parse(u.firstSeenAt) || Infinity),
      Infinity,
    );
    const windowStart = Math.max(Date.parse(rec.startedAt) || 0, Number.isFinite(oldestUnbuiltTs) ? oldestUnbuiltTs : 0);
    if (evt.at < windowStart) return;

    // Persist the trigger record (server-owned, never re-read from any file).
    this.deps.store.update(topicId, rec.runId, (r) => {
      r.triggers.push({ at: new Date(evt.at).toISOString(), messageId: evt.messageId, phrase });
      if (r.triggers.length > 50) r.triggers = r.triggers.slice(-50);
    });

    // Server-authored enumeration (R37), deduped per unbuilt-set hash — an
    // unchanged set re-uses the recorded enumeration and never re-sends.
    const paths = unbuilt.map((u) => u.path);
    const setHash = hashPathSet(paths);
    if (rec.enumerations.some((e) => e.setHash === setHash)) return;

    const shown = paths.slice(0, ENUMERATION_CLAMP);
    const more = paths.length - shown.length;
    const link = this.deps.dashboardLink?.(topicId);
    const lines = [
      `Ratify deferring these ${paths.length} artifact${paths.length === 1 ? '' : 's'}?`,
      ...shown.map((p) => `- ${p}`),
      ...(more > 0 ? [`…and ${more} more`] : []),
      '',
      'Reply to THIS message with yes/approve, or use the dashboard.',
      ...(link ? [link] : []),
    ];
    const sent = await this.deps.sendToTopic(evt.topicId, lines.join('\n'));
    this.deps.store.update(topicId, rec.runId, (r) => {
      r.enumerations.push({ setHash, messageId: sent.messageId, at: new Date().toISOString(), artifacts: paths });
      if (r.enumerations.length > 20) r.enumerations = r.enumerations.slice(-20);
    });
    this.deps.recordMetric?.('fired');
  }
}

export type { AutonomousRunRecord };
