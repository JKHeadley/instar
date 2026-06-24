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
import { AbsenceUnverifiableError } from './LiveTestHarness.js';
import type { SendResult, ReplyResult } from './LiveTestHarness.js';

/** History page size + the absolute ceiling on an absence-collection window. */
const HISTORY_LIMIT = 100;
const MAX_WINDOW_MS = 300_000;

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
  /**
   * OPTIONAL — the agent's Slack app `bot_id`. A message posted by the agent's BACKGROUND
   * path (incoming-webhook / app post) can carry `bot_id` with NO `user` field; matching
   * on `agentBotUserId` alone would then SKIP it → a spurious background nudge would be
   * missed by the absence proof (false PASS). When set, a message authored by EITHER the
   * agent's user id OR this bot_id counts as agent-outbound. (Lessons-review FD-3.)
   */
  agentBotId?: string;
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

  /** A message is agent-outbound if it is from the agent's user id OR its app bot_id. */
  private isAgentAuthored(m: { user?: string; bot_id?: string }): boolean {
    if (m.user === this.d.agentBotUserId) return true;
    if (this.d.agentBotId && m.bot_id === this.d.agentBotId) return true;
    return false;
  }

  /**
   * Collect EVERY agent-authored message strictly after `after`, polling across the
   * window so a nudge landing LATE (after a legitimate reply) is still seen. Returned
   * oldest-first. Backs the absence assertion over a real Slack channel.
   *
   * Soundness for an ABSENCE proof (an under-collection here is a silent false-PASS):
   * - **Failed read:** `ok === false` (auth revoked / not_in_channel) throws — never a
   *   vacuous PASS over a read that returned nothing because it FAILED.
   * - **Truncation guard:** a `next_cursor` (more pages exist) or a full page
   *   (>= HISTORY_LIMIT) means the read may be incomplete → AbsenceUnverifiableError →
   *   harness BLOCKED, never a false PASS over an unread page.
   * - **Anti-laundering:** ALL text VERSIONS per ts are kept (an edit can't launder a
   *   nudge out). **Identity:** user id OR app bot_id (a background nudge may have only
   *   bot_id). **Bounded window:** clamped to MAX_WINDOW_MS.
   */
  async collectMessages(channelId: string, opts: { windowMs: number; afterMessageId?: string }): Promise<Array<Omit<ReplyResult, 'responderMachineId'>>> {
    const after = opts.afterMessageId;
    const deadline = this.now() + Math.min(Math.max(0, opts.windowMs), MAX_WINDOW_MS);
    const pollMs = this.d.pollIntervalMs ?? 2000;
    const seen = new Map<string, Set<string>>(); // ts → every text version observed
    for (let first = true; first || this.now() < deadline; first = false) {
      const res = await this.d.api.call('conversations.history', {
        channel: channelId,
        ...(after ? { oldest: after, inclusive: false } : {}),
        limit: HISTORY_LIMIT,
      });
      if (res.ok === false) {
        throw new AbsenceUnverifiableError(`conversations.history failed for ${channelId} (ok=false) — cannot prove absence over a failed read`);
      }
      const messages = res.messages ?? [];
      const nextCursor = (res.response_metadata as { next_cursor?: string } | undefined)?.next_cursor;
      if ((nextCursor && nextCursor.length > 0) || messages.length >= HISTORY_LIMIT) {
        throw new AbsenceUnverifiableError(`${channelId} history read is paginated/truncated (cursor or full ${HISTORY_LIMIT}-page) — cannot prove completeness`);
      }
      for (const m of messages) {
        if (!m.ts) continue;                       // skip a malformed entry
        if (after && !(m.ts > after)) continue;    // strictly after the prompt
        if (!this.isAgentAuthored(m)) continue;    // agent OUTBOUND only (user id OR bot_id)
        const set = seen.get(m.ts) ?? new Set<string>();
        set.add(m.text ?? '');
        seen.set(m.ts, set);
      }
      if (this.now() >= deadline) break;
      await this.sleep(pollMs);
    }
    return [...seen.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .flatMap(([ts, texts]) => [...texts].map(text => ({ messageId: ts, text })));
  }

  /** Find the FIRST agent-authored message strictly after `after` (oldest-first). */
  private async findAgentReply(channelId: string, after?: string): Promise<{ text: string; messageId: string } | null> {
    const res = await this.d.api.call('conversations.history', {
      channel: channelId,
      ...(after ? { oldest: after, inclusive: false } : {}),
      limit: HISTORY_LIMIT,
    });
    const messages = res.messages ?? [];
    // conversations.history returns newest-first; scan oldest-first so we return the
    // EARLIEST agent reply after the prompt (deterministic).
    const oldestFirst = [...messages].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    for (const m of oldestFirst) {
      if (after && !(m.ts > after)) continue; // strictly-after guard (belt + suspenders vs `oldest`)
      if (!this.isAgentAuthored(m)) continue; // only the AGENT's reply (user id OR bot_id)
      const text = m.text ?? '';
      return { text, messageId: m.ts };
    }
    return null;
  }
}
