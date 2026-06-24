/**
 * TelegramLiveSender — the real Telegram `SurfaceSender` for the live-test harness
 * (docs/specs/live-user-channel-proof-standard.md §5.4). It posts a message into a
 * Telegram forum topic AS A NON-AGENT IDENTITY (a DEMO bot / second account in a demo
 * group — NOT the agent's own bot, which the agent would not treat as inbound), then
 * waits for the AGENT's reply by polling the topic history for the next agent-authored
 * message.
 *
 * Same shape as SlackLiveSender: the send transport (the demo-bot post) and the
 * history read are INJECTED, so the CODE is complete + unit-testable here and the only
 * wiring-time dependency is the demo-bot CREDENTIAL + a demo group/topic (provisioning).
 *
 * The agent's reply is identified DETERMINISTICALLY: the earliest history entry with
 * `fromUser === false` (an agent outbound) whose messageId is strictly after the one we
 * sent. Null on timeout. The responder-MACHINE attribution (the cross-machine proof) is
 * the RealChannelDriver's injected placement reader, not this sender.
 */

import type { SurfaceSender } from './RealChannelDriver.js';
import { AbsenceUnverifiableError } from './LiveTestHarness.js';
import type { SendResult, ReplyResult } from './LiveTestHarness.js';

/** History page size + the absolute ceiling on an absence-collection window. */
const HISTORY_LIMIT = 100;
const MAX_WINDOW_MS = 300_000;

/** The subset of TelegramAdapter.getTopicHistory's LogEntry this sender reads. */
export interface TelegramHistoryEntry {
  messageId: number;
  text: string;
  /** true = inbound user message; false = an agent (bot) outbound — the reply we wait for. */
  fromUser: boolean;
}

export interface TelegramLiveSenderDeps {
  /** Post a message into the topic AS THE DEMO identity (demo-bot token). Returns the new message id. */
  postAsDemoUser: (topicId: number, text: string) => Promise<{ messageId: number }>;
  /** Read recent topic history (Echo's getTopicHistory), newest-or-oldest order tolerated. */
  getHistory: (topicId: number, limit?: number) => TelegramHistoryEntry[] | Promise<TelegramHistoryEntry[]>;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  logger?: (m: string) => void;
}

export class TelegramLiveSender implements SurfaceSender {
  private readonly d: TelegramLiveSenderDeps;
  constructor(deps: TelegramLiveSenderDeps) { this.d = deps; }

  private now(): number { return (this.d.now ?? Date.now)(); }
  private async sleep(ms: number): Promise<void> {
    return (this.d.sleep ?? ((m: number) => new Promise<void>((r) => setTimeout(r, m))))(ms);
  }
  private log(m: string): void { this.d.logger?.(`[telegram-live-sender] ${m}`); }

  private topicNum(channelId: string): number {
    const n = Number(channelId);
    if (!Number.isFinite(n)) throw new Error(`telegram channelId "${channelId}" is not a numeric topic id`);
    return n;
  }

  async send(channelId: string, text: string): Promise<SendResult> {
    const res = await this.d.postAsDemoUser(this.topicNum(channelId), text);
    if (!Number.isFinite(res?.messageId)) {
      throw new Error(`postAsDemoUser returned no messageId — message not posted`);
    }
    return { messageId: String(res.messageId) };
  }

  async awaitReply(channelId: string, opts: { timeoutMs: number; afterMessageId?: string }): Promise<Omit<ReplyResult, 'responderMachineId'> | null> {
    const topic = this.topicNum(channelId);
    const afterId = opts.afterMessageId != null ? Number(opts.afterMessageId) : -Infinity;
    const deadline = this.now() + opts.timeoutMs;
    const pollMs = this.d.pollIntervalMs ?? 2000;
    for (let first = true; first || this.now() < deadline; first = false) {
      const reply = await this.findAgentReply(topic, afterId);
      if (reply) return reply;
      if (this.now() >= deadline) break;
      await this.sleep(pollMs);
    }
    this.log(`no agent reply in topic ${topic} within ${opts.timeoutMs}ms`);
    return null;
  }

  /**
   * Collect EVERY agent-authored message in the topic strictly after `afterMessageId`,
   * polling across the window so a nudge that lands LATE (after a legitimate reply) is
   * still seen. Returned oldest-first. Backs the absence assertion.
   *
   * Soundness for an ABSENCE proof (an under-collection here is a silent false-PASS):
   * - **Anti-laundering:** ALL distinct text VERSIONS of a messageId are kept (not
   *   last-write-wins), so an edit that rewrites a spurious nudge to benign text cannot
   *   launder it out of the proof — every observed version is returned and matched.
   * - **Truncation guard:** a poll returning a FULL page (>= HISTORY_LIMIT) means the
   *   read may be truncated (a nudge could be on an unread page) → AbsenceUnverifiableError
   *   → the harness records BLOCKED, never a false PASS over an incomplete read.
   * - **Bounded window:** windowMs is clamped to MAX_WINDOW_MS (caps real-API poll count).
   */
  async collectMessages(channelId: string, opts: { windowMs: number; afterMessageId?: string }): Promise<Array<Omit<ReplyResult, 'responderMachineId'>>> {
    const topic = this.topicNum(channelId);
    const afterId = opts.afterMessageId != null ? Number(opts.afterMessageId) : -Infinity;
    const deadline = this.now() + Math.min(Math.max(0, opts.windowMs), MAX_WINDOW_MS);
    const pollMs = this.d.pollIntervalMs ?? 2000;
    const seen = new Map<number, Set<string>>(); // messageId → every text version observed
    for (let first = true; first || this.now() < deadline; first = false) {
      const entries = await this.d.getHistory(topic, HISTORY_LIMIT);
      // Telegram getTopicHistory returns the most-recent HISTORY_LIMIT entries of the
      // topic's WHOLE lifetime (a tail, NOT bounded to the marker like Slack's `oldest`).
      // So a full page only means the read is TRUNCATED when its OLDEST entry is still
      // AFTER the marker — i.e. the marker scrolled off the page, so post-marker messages
      // between the marker and the page's oldest may be unread. If the oldest in-page
      // entry is <= the marker, the marker (or older) is in-page → every post-marker
      // message is present → complete, even on a long-lived demo topic with >100 lifetime
      // messages. (Round-2 review: a bare `length >= LIMIT` wrongly blocked any reused topic.)
      if (entries.length >= HISTORY_LIMIT) {
        const ids = entries.map(e => e.messageId).filter(n => Number.isFinite(n));
        const oldestInPage = ids.length ? Math.min(...ids) : -Infinity;
        if (oldestInPage > afterId) {
          throw new AbsenceUnverifiableError(`topic ${topic} full ${HISTORY_LIMIT}-entry page is entirely after the marker — the marker scrolled off, post-marker messages may be unread (cannot prove completeness)`);
        }
      }
      for (const e of entries) {
        if (!Number.isFinite(e.messageId)) continue; // skip a malformed entry, never a junk key
        if (e.messageId <= afterId) continue;        // strictly after the prompt we sent
        if (e.fromUser) continue;                    // agent OUTBOUND only (the background-nudge class)
        const set = seen.get(e.messageId) ?? new Set<string>();
        set.add(e.text ?? '');
        seen.set(e.messageId, set);
      }
      if (this.now() >= deadline) break;
      await this.sleep(pollMs);
    }
    return [...seen.entries()]
      .sort((a, b) => a[0] - b[0])
      .flatMap(([messageId, texts]) => [...texts].map(text => ({ messageId: String(messageId), text })));
  }

  private async findAgentReply(topicId: number, afterId: number): Promise<{ text: string; messageId: string } | null> {
    const entries = await this.d.getHistory(topicId, 100);
    // Oldest-first by messageId so we return the EARLIEST agent reply after the prompt.
    const oldestFirst = [...entries].sort((a, b) => a.messageId - b.messageId);
    for (const e of oldestFirst) {
      if (e.messageId <= afterId) continue;   // strictly after the prompt
      if (e.fromUser) continue;               // skip inbound user messages (incl. our own demo post)
      return { text: e.text ?? '', messageId: String(e.messageId) };
    }
    return null;
  }
}
