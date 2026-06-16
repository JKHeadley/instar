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
import type { SendResult, ReplyResult } from './LiveTestHarness.js';

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
