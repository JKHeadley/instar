/**
 * Skill Learning Sentinel — the structural seam filter (spec §3.1).
 *
 * Chained AFTER the Human-as-Detector link on the Telegram and Slack `onMessageLogged` hook slots. It
 * decides, from provenance FACTS only (never meaning), whether an inbound message becomes a request row:
 *
 *   - `not-user`           — `fromUser` false (an agent/automation line; still fed to Outcomes as a reply);
 *   - `forwarded`          — platform-authenticated forwarding provenance;
 *   - `not-operator`       — Telegram: the sender is not the topic's VERIFIED operator binding
 *                            (`TopicOperatorStore.getOperator(topicId)?.uid`); Slack: the sender does not
 *                            resolve to an `admin` profile (a match is kept as `identity: 'asserted'`, counted
 *                            `slack-asserted`, support-only);
 *   - `confirmation-reply` — the topic has an outstanding PendingConfirmation (the message answers it).
 *
 * Every drop reason is counted; `filter.counters()` feeds the status route. Short questions,
 * acknowledgements and detector-classified corrections are NOT dropped — the detector category travels
 * with the row as classifier input. The row carries the message SOURCE, never its text.
 *
 * TopicMemory catch-up (`catchUp`) admits rows the seam missed as `identity: 'unverified-catchup'` —
 * recurrence support only, never a clean run (current identity never retroactively authenticates history).
 */
import crypto from 'node:crypto';
import type { LogEntry as SlackLogEntry } from '../../messaging/shared/MessageLogger.js';
import type { TopicMessage } from '../../memory/TopicMemory.js';
import type { DropReason, Identity, LedgerWriter, RequestRow, RowSource } from './types.js';

/**
 * Unique row id for every ledger row. Lives here (not in Ledger.ts) so THIS module carries no runtime
 * dependency on the SQLite cache. (server.ts also imports SkillLearningSentinel.js statically for the
 * wiring, which does reach better-sqlite3 — the same class of static import routes.ts and
 * MessageProcessingLedger.ts already make, so no new boot-failure class; this header only promises
 * that the hook-link module itself stays native-free.)
 */
export function newEventId(): string {
  return `${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`;
}

/** The Telegram adapter's `onMessageLogged` entry (structural copy of TelegramAdapter's callback type). */
export interface TelegramLoggedEntry {
  messageId: number;
  topicId: number | null;
  text: string;
  fromUser: boolean;
  timestamp: string;
  sessionName: string | null;
  senderName?: string;
  senderUsername?: string;
  telegramUserId?: number;
  forwarded?: boolean;
}

/** A normalized message the Outcomes tracker consumes (§3.6 window rules). */
export interface SeamEvent {
  kind: 'reply' | 'request';
  channel: 'telegram' | 'slack';
  topicId: string;
  source: RowSource;
  at: string;
  sessionName?: string;
  /** Present on `request` events only — the appended row. */
  row?: RequestRow;
}

export type FilterCounters = Record<DropReason | 'slack-asserted', number> & {
  observed: number;
  appended: number;
  replies: number;
  catchup: number;
  appendErrors: number;
};

export interface SeamFilterDeps {
  ledger: LedgerWriter & { requestBySource?(source: RowSource): RequestRow | null };
  machineId: string;
  /** The verified operator uid for a topic, or null when the topic has no verified binding. */
  operatorUidForTopic: (topicId: number | string) => string | null;
  /** Does this Slack platform user resolve to an `admin` profile? Absent ⇒ every Slack sender is `not-operator`. */
  slackAdminUser?: (platformUserId: string) => boolean;
  /** Slack channel id → the synthetic numeric topic id TopicMemory stores the channel under. */
  slackTopicId?: (channelId: string) => string;
  /** Does the topic have an outstanding PendingConfirmation (the message answers it)? */
  hasOutstandingConfirmation?: (topicId: string) => boolean;
  /** `HumanAsDetectorLog.getInstance().classify` — pure, no I/O; the category rides along as classifier input. */
  detector?: { classify(text: string): { category: string } | null };
  /** TopicMemory catch-up read. */
  topicMemory?: { getMessagesSince(topicId: number, sinceIso: string, limit?: number): { messages: TopicMessage[]; complete: boolean } };
  /** Outcomes sink. */
  onEvent?: (event: SeamEvent) => void;
  now?: () => number;
  logger?: (message: string) => void;
}

export class SeamFilter {
  private readonly deps: SeamFilterDeps;
  private readonly c: FilterCounters = {
    'not-user': 0, forwarded: 0, 'not-operator': 0, 'confirmation-reply': 0, 'slack-asserted': 0,
    observed: 0, appended: 0, replies: 0, catchup: 0, appendErrors: 0,
  };
  private readonly watermarks = new Map<string, string>();

  constructor(deps: SeamFilterDeps) {
    this.deps = deps;
  }

  counters(): FilterCounters {
    return { ...this.c };
  }

  /** `filtered` in the shape `SkillLearningStatus.filtered` wants. */
  filtered(): Record<DropReason | 'slack-asserted', number> {
    return {
      'not-user': this.c['not-user'], forwarded: this.c.forwarded, 'not-operator': this.c['not-operator'],
      'confirmation-reply': this.c['confirmation-reply'], 'slack-asserted': this.c['slack-asserted'],
    };
  }

  catchUpWatermarks(): Record<string, string> {
    return Object.fromEntries(this.watermarks);
  }

  // ─── Live seams ──────────────────────────────────────────────────────

  observeTelegram(entry: TelegramLoggedEntry): RequestRow | null {
    if (entry.topicId == null) return null;
    const topicId = String(entry.topicId);
    const source: RowSource = { channel: 'telegram', chatId: topicId, messageId: String(entry.messageId) };
    this.c.observed++;
    if (!entry.fromUser) return this.reply('telegram', topicId, source, entry.timestamp, entry.sessionName);
    if (entry.forwarded === true) { this.c.forwarded++; return null; }
    const operator = this.deps.operatorUidForTopic(entry.topicId);
    if (!operator || entry.telegramUserId === undefined || String(entry.telegramUserId) !== operator) { this.c['not-operator']++; return null; }
    if (this.deps.hasOutstandingConfirmation?.(topicId)) { this.c['confirmation-reply']++; return null; }
    return this.admit({ channel: 'telegram', topicId, source, at: entry.timestamp, sessionName: entry.sessionName, text: entry.text, identity: 'verified' });
  }

  observeSlack(entry: SlackLogEntry): RequestRow | null {
    if (entry.channelId == null || entry.channelId === '') return null;
    const channelId = String(entry.channelId);
    const topicId = this.deps.slackTopicId ? this.deps.slackTopicId(channelId) : channelId;
    const source: RowSource = { channel: 'slack', chatId: channelId, messageId: String(entry.messageId) };
    this.c.observed++;
    if (!entry.fromUser) return this.reply('slack', topicId, source, entry.timestamp, entry.sessionName);
    if (entry.forwarded === true) { this.c.forwarded++; return null; }
    const uid = entry.platformUserId == null ? '' : String(entry.platformUserId);
    if (!uid || !this.deps.slackAdminUser || !this.deps.slackAdminUser(uid)) { this.c['not-operator']++; return null; }
    if (this.deps.hasOutstandingConfirmation?.(topicId)) { this.c['confirmation-reply']++; return null; }
    this.c['slack-asserted']++;
    return this.admit({ channel: 'slack', topicId, source, at: entry.timestamp, sessionName: entry.sessionName, text: entry.text, identity: 'asserted' });
  }

  // ─── Catch-up ────────────────────────────────────────────────────────

  /**
   * Admit rows TopicMemory holds for a topic since `sinceIso` that the seam never saw. The SAME
   * structural filter as the live link applies (`fromUser && !forwarded && telegramUserId === the
   * topic's verified operator uid`) and a failing row is counted under the same drop reason and never
   * admitted — text from an unbound sender must never reach the classifier prompt. A row that passes
   * is still only `unverified-catchup` (support-only): the stored row carries the facts, not the
   * authenticated inbound path. Returns the admitted count and whether the read was complete.
   */
  catchUp(topicId: number, sinceIso: string, limit = 500): { admitted: number; complete: boolean } {
    const tm = this.deps.topicMemory;
    if (!tm) return { admitted: 0, complete: false };
    const since = this.watermarks.get(String(topicId)) && this.watermarks.get(String(topicId))! > sinceIso ? this.watermarks.get(String(topicId))! : sinceIso;
    const { messages, complete } = tm.getMessagesSince(topicId, since, limit);
    const operator = this.deps.operatorUidForTopic(topicId);
    let admitted = 0;
    let newest = since;
    for (const m of messages) {
      if (m.timestamp > newest) newest = m.timestamp;
      if (!m.messageId) continue;
      if (!m.fromUser) { this.c['not-user']++; continue; }
      if (m.forwarded === true) { this.c.forwarded++; continue; }
      if (!operator || m.telegramUserId === undefined || String(m.telegramUserId) !== operator) { this.c['not-operator']++; continue; }
      const source: RowSource = { channel: 'telegram', chatId: String(topicId), messageId: String(m.messageId) };
      if (this.deps.ledger.requestBySource?.(source)) continue;
      const row = this.admit({ channel: 'telegram', topicId: String(topicId), source, at: m.timestamp, sessionName: m.sessionName, text: m.text, identity: 'unverified-catchup' });
      if (row) { admitted++; this.c.catchup++; }
    }
    this.watermarks.set(String(topicId), newest);
    return { admitted, complete };
  }

  // ─── Internals ───────────────────────────────────────────────────────

  private reply(channel: 'telegram' | 'slack', topicId: string, source: RowSource, at: string, sessionName: string | null): null {
    this.c['not-user']++;
    this.c.replies++;
    this.deps.onEvent?.({ kind: 'reply', channel, topicId, source, at, ...(sessionName ? { sessionName } : {}) });
    return null;
  }

  private admit(input: {
    channel: 'telegram' | 'slack'; topicId: string; source: RowSource; at: string; sessionName: string | null; text: string; identity: Identity;
  }): RequestRow | null {
    const eventId = newEventId();
    const row: RequestRow = {
      kind: 'request',
      eventId,
      source: input.source,
      topicId: input.topicId,
      at: input.at,
      channel: input.channel,
      identity: input.identity,
      state: 'pending',
      machineId: this.deps.machineId,
    };
    if (input.sessionName) row.sessionName = input.sessionName;
    const category = this.safeClassify(input.text);
    if (category) row.detectorCategory = category;
    // Every verified/asserted request opens a run (§3.6); a catch-up row never does.
    if (input.identity !== 'unverified-catchup') row.runId = `run-${eventId}`;
    try {
      this.deps.ledger.append(row);
    } catch (err) {
      this.c.appendErrors++;
      this.deps.logger?.(`[SkillLearning/Seam] append failed: ${(err as Error).message}`);
      return null;
    }
    this.c.appended++;
    if (row.runId) {
      this.deps.onEvent?.({ kind: 'request', channel: input.channel, topicId: input.topicId, source: input.source, at: input.at, ...(input.sessionName ? { sessionName: input.sessionName } : {}), row });
    }
    return row;
  }

  private safeClassify(text: string): string | undefined {
    try {
      return this.deps.detector?.classify(text)?.category ?? undefined;
    } catch {
      return undefined;
    }
  }
}

// ─── Hook-chain attachment (the ONLY thing server.ts calls) ─────────────

/**
 * The live filter the server links resolve at message time. The sentinel installs its filter here when
 * it is constructed (server.ts constructs nothing — it only chains the links); until then, and whenever
 * the sentinel is off, the links are counted no-ops.
 */
let liveFilter: SeamFilter | null = null;
let unlinkedMessages = 0;

export function installSkillLearningSeamFilter(filter: SeamFilter | null): void {
  liveFilter = filter;
}

export function getSkillLearningSeamFilter(): SeamFilter | null {
  return liveFilter;
}

/** Messages that reached a link while no filter was installed (visible, never silent). */
export function skillLearningUnlinkedMessages(): number {
  return unlinkedMessages;
}

let linkErrors = 0;

/** Throws inside a server link, caught and counted — never propagated to the adapter. */
export function skillLearningLinkErrors(): number {
  return linkErrors;
}

function contained(run: (f: SeamFilter) => void, enabled: boolean | undefined): void {
  if (enabled !== true) return;
  const f = liveFilter;
  if (!f) { unlinkedMessages++; return; }
  try { run(f); } catch (err) {
    linkErrors++;
    console.warn(`[SkillLearning/Seam] link error (contained): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * The server's Telegram link (called from inside the Human-as-Detector callback, after it). Gated on
 * `monitoring.skillLearning.enabled`; a no-op until the sentinel installs its filter; never throws.
 */
export function skillLearningTelegramLink(entry: TelegramLoggedEntry, enabled: boolean | undefined): void {
  contained((f) => { f.observeTelegram(entry); }, enabled);
}

/** The server's Slack link (called from inside the Slack `onMessageLogged` callback). Same contract. */
export function skillLearningSlackLink(entry: SlackLogEntry, enabled: boolean | undefined): void {
  contained((f) => { f.observeSlack(entry); }, enabled);
}

export interface AttachSeamsInput {
  telegram?: { onMessageLogged: ((entry: TelegramLoggedEntry) => void) | null } | null;
  slack?: { onMessageLogged: ((entry: SlackLogEntry) => void) | null } | null;
  /** Explicit filter (tests); default resolves the installed one per message. */
  filter?: SeamFilter | (() => SeamFilter | null);
  logger?: (message: string) => void;
}

export interface AttachedSeams {
  telegram: boolean;
  slack: boolean;
  /** Throws inside the sentinel link, caught and counted — the prior links always ran first. */
  errors(): number;
}

/**
 * Chain the sentinel link onto both adapters' `onMessageLogged` slots. The prior link always runs first
 * and a throw inside the sentinel is caught + counted, never propagated to the adapter or the links
 * ahead of it.
 */
export function attachSkillLearningSeams(input: AttachSeamsInput): AttachedSeams {
  let errors = 0;
  const note = (err: unknown) => {
    errors++;
    input.logger?.(`[SkillLearning/Seam] link error (contained): ${err instanceof Error ? err.message : String(err)}`);
  };
  const resolve = (): SeamFilter | null => {
    const f = typeof input.filter === 'function' ? input.filter() : input.filter ?? liveFilter;
    if (!f) unlinkedMessages++;
    return f;
  };
  let telegram = false;
  if (input.telegram) {
    const before = input.telegram.onMessageLogged;
    input.telegram.onMessageLogged = (entry) => {
      before?.(entry);
      try { resolve()?.observeTelegram(entry); } catch (err) { note(err); }
    };
    telegram = true;
  }
  let slack = false;
  if (input.slack) {
    const before = input.slack.onMessageLogged;
    input.slack.onMessageLogged = (entry) => {
      before?.(entry);
      try { resolve()?.observeSlack(entry); } catch (err) { note(err); }
    };
    slack = true;
  }
  return { telegram, slack, errors: () => errors };
}
