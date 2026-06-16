/**
 * SlackLiveSender — the real Slack `SurfaceSender` for the live-test harness
 * (docs/specs/live-user-channel-proof-standard.md §5.4). It posts a message into a
 * Slack channel AS A NON-AGENT IDENTITY (a user/second-bot token, NOT Echo's own bot
 * — Echo never replies to itself) and then waits for the AGENT's reply by polling the
 * channel history for a message from the agent's bot user id.
 *
 * Parameterization is deliberate: the sender takes an already-constructed
 * `SlackApiClient` (carrying the non-Echo sender token) + the agent's bot user id. So
 * the CODE is complete and unit-testable here; the only thing that has to be provided
 * at wiring time is the sender CREDENTIAL (a user token / second-bot token in the
 * demo workspace). That credential is the one piece that may need provisioning — the
 * logic does not.
 *
 * `awaitReply` identifies the agent's reply DETERMINISTICALLY (a message strictly
 * after the sent ts whose author is the agent's bot user id), never a fuzzy guess, and
 * resolves null on timeout (the harness records that as a FAIL with reason). The
 * responder-MACHINE attribution (the cross-machine proof) is NOT done here — that is
 * the RealChannelDriver's injected placement reader; this sender only returns the
 * reply text + id.
 */

import type { SurfaceSender } from './RealChannelDriver.js';
import type { SendResult, ReplyResult } from './LiveTestHarness.js';

/** Minimal Slack client surface this sender needs (matches SlackApiClient.call). */
export interface SlackCaller {
  call(method: string, params?: Record<string, unknown>): Promise<{
    ok?: boolean;
    ts?: string;
    messages?: Array<{ ts: string; user?: string; bot_id?: string; text?: string; subtype?: string }>;
    [k: string]: unknown;
  }>;
}

export interface SlackLiveSenderDeps {
  /** A SlackApiClient constructed with the NON-AGENT sender token (the user-role identity). */
  api: SlackCaller;
  /** The agent's (Echo's) Slack bot user id — awaitReply waits for a reply authored by THIS id. */
  agentBotUserId: string;
  /** Poll cadence while awaiting a reply. Default 2000ms. */
  pollIntervalMs?: number;
  /** Injected for tests; defaults to real timers / clock. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  logger?: (m: string) => void;
}

export class SlackLiveSender implements SurfaceSender {
  private readonly d: SlackLiveSenderDeps;
  constructor(deps: SlackLiveSenderDeps) { this.d = deps; }

  private now(): number { return (this.d.now ?? Date.now)(); }
  private async sleep(ms: number): Promise<void> {
    return (this.d.sleep ?? ((m: number) => new Promise<void>((r) => setTimeout(r, m))))(ms);
  }
  private log(m: string): void { this.d.logger?.(`[slack-live-sender] ${m}`); }

  async send(channelId: string, text: string): Promise<SendResult> {
    const res = await this.d.api.call('chat.postMessage', { channel: channelId, text });
    if (!res.ts) {
      // A post with no ts is a real failure — surface it (the harness records a driver
      // error FAIL), never fabricate a messageId.
      throw new Error(`chat.postMessage returned no ts (ok=${res.ok}) — message not posted`);
    }
    return { messageId: res.ts };
  }

  async awaitReply(channelId: string, opts: { timeoutMs: number; afterMessageId?: string }): Promise<Omit<ReplyResult, 'responderMachineId'> | null> {
    const deadline = this.now() + opts.timeoutMs;
    const pollMs = this.d.pollIntervalMs ?? 2000;
    const after = opts.afterMessageId; // a Slack ts string; lexicographic compare works for ts
    // Poll at least once even if timeoutMs is ~0.
    for (let first = true; first || this.now() < deadline; first = false) {
      const reply = await this.findAgentReply(channelId, after);
      if (reply) return reply;
      if (this.now() >= deadline) break;
      await this.sleep(pollMs);
    }
    this.log(`no agent reply in ${channelId} within ${opts.timeoutMs}ms`);
    return null;
  }

  /** Find the FIRST agent-authored message strictly after `after` (oldest-first). */
  private async findAgentReply(channelId: string, after?: string): Promise<{ text: string; messageId: string } | null> {
    const res = await this.d.api.call('conversations.history', {
      channel: channelId,
      ...(after ? { oldest: after, inclusive: false } : {}),
      limit: 100,
    });
    const messages = res.messages ?? [];
    // conversations.history returns newest-first; scan oldest-first so we return the
    // EARLIEST agent reply after the prompt (deterministic).
    const oldestFirst = [...messages].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    for (const m of oldestFirst) {
      if (after && !(m.ts > after)) continue; // strictly-after guard (belt + suspenders vs `oldest`)
      if (m.user !== this.d.agentBotUserId) continue; // only the AGENT's reply
      const text = m.text ?? '';
      return { text, messageId: m.ts };
    }
    return null;
  }
}
