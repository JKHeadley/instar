/**
 * claudeKeyRecovery — what a conversation restarted after a dead sign-in key is told, and how we
 * check it really answered (spec cloud-key-internal-calls §recovery reply).
 *
 * The 2026-11-04 nimbus drill: the restarted sessions got a bare prompt with no reply command and
 * no copy of the held messages. Both posted their channel id as the reply; one person's messages
 * were never answered while the restart reported success. So the prompt now carries the held
 * messages and the exact reply command, and success means an answer seen in the conversation.
 *
 * Pure: no I/O, so both platforms and both sides of every decision are unit-tested.
 */

/** One message from a conversation, platform-neutral. */
export interface ConversationLine {
  /** Milliseconds since epoch. */
  at: number;
  /** True when the agent (this bot) wrote it. */
  fromAgent: boolean;
  /** Display name or id of the person; ignored for agent lines. */
  who: string;
  text: string;
}

export interface HeldMessage { who: string; text: string; at: number }

/** A Slack id the agent printed instead of a reply. Never counts as an answer. */
const BARE_CHANNEL_ID = /^\s*[CDG](?=[A-Z0-9]*[0-9])[A-Z0-9]{8,11}\s*$/;

function isFixedNotice(text: string, fixedTexts: readonly string[]): boolean {
  const t = text.trim();
  return fixedTexts.some((f) => f.trim() === t || t.startsWith(f.trim()));
}

/** An agent line that is a real reply: not one of the server's fixed notices, not a bare id. */
function isRealAgentReply(line: ConversationLine, fixedTexts: readonly string[]): boolean {
  return line.fromAgent && line.text.trim().length > 0 && !BARE_CHANNEL_ID.test(line.text) && !isFixedNotice(line.text, fixedTexts);
}

/**
 * Messages from people after the agent's last real reply. The server's own key notices don't
 * count as replies: they say the agent can't answer, so what came before them is still held.
 */
export function heldMessages(lines: readonly ConversationLine[], fixedTexts: readonly string[]): HeldMessage[] {
  const sorted = [...lines].sort((a, b) => a.at - b.at);
  let lastReply = -1;
  sorted.forEach((line, i) => { if (isRealAgentReply(line, fixedTexts)) lastReply = i; });
  return sorted.slice(lastReply + 1)
    .filter((l) => !l.fromAgent && l.text.trim().length > 0)
    .map((l) => ({ who: l.who, text: l.text, at: l.at }));
}

/** True once the agent wrote a real reply after `sinceMs`. */
export function answeredSince(lines: readonly ConversationLine[], sinceMs: number, fixedTexts: readonly string[]): boolean {
  return lines.some((l) => l.at >= sinceMs && isRealAgentReply(l, fixedTexts));
}

/** A Slack message as the adapter holds it (the fields used here). */
export interface SlackLineInput { ts: string; user?: string; text?: string; bot_id?: string; subtype?: string; unaddressed?: boolean }

/**
 * A Slack conversation as lines. Only this agent's bot user is the agent (another bot answering is
 * not a reply), and of its posts only a session's count: the server's own (standby notes,
 * notices) come from the same bot user and are nobody answering. Only the agent's authorized
 * people are waiting. Everything else is left out.
 */
export function slackConversationLines(
  messages: readonly SlackLineInput[],
  opts: { botUserId: string | null; isPerson: (userId: string) => boolean; isServerPost: (ts: string) => boolean },
): ConversationLine[] {
  const lines: ConversationLine[] = [];
  for (const m of messages) {
    if (m.unaddressed) continue;
    if (m.subtype && !['thread_broadcast', 'file_share', 'bot_message'].includes(m.subtype)) continue;
    const at = Math.round(parseFloat(m.ts) * 1000);
    if (!Number.isFinite(at)) continue;
    const fromAgent = opts.botUserId !== null ? m.user === opts.botUserId : Boolean(m.bot_id);
    if (fromAgent) {
      if (!opts.isServerPost(m.ts)) lines.push({ at, fromAgent: true, who: 'agent', text: m.text ?? '' });
      continue;
    }
    if (!m.bot_id && m.user && opts.isPerson(m.user)) lines.push({ at, fromAgent: false, who: m.user, text: m.text ?? '' });
  }
  return lines;
}

export type RecoveryChannel =
  | { platform: 'slack'; channelId: string; threadTs?: string }
  | { platform: 'telegram'; topicId: number };

/** The reply command for this conversation, exactly as the agent should run it. */
export function replyCommand(channel: RecoveryChannel): string[] {
  if (channel.platform === 'slack') {
    // A bound Slack session's binding picks the destination: no channel argument.
    return ["cat <<'EOF' | .instar/scripts/slack-reply.sh", 'Your reply here', 'EOF'];
  }
  return [`cat <<'EOF' | .instar/scripts/telegram-reply.sh ${channel.topicId}`, 'Your reply here', 'EOF'];
}

const MAX_HELD = 20;
const MAX_HELD_CHARS = 2000;

/**
 * The prompt a restarted conversation gets, with the held messages quoted and the reply command
 * spelled out. A Slack prompt carries the `[slack:<channel>]` tag of an ordinary inbound message.
 */
export function buildKeyRecoveryPrompt(channel: RecoveryChannel, held: readonly HeldMessage[]): string {
  // The Telegram respawn tags the message itself; the Slack respawn passes it through as is.
  const tag = channel.platform === 'slack' ? `[slack:${channel.channelId}] ` : '';
  const lines: string[] = [
    `${tag}Your sign-in key stopped working for a while and has now been fixed. ` +
      'Messages sent during that time were not answered.',
    '',
  ];
  const shown = held.slice(-MAX_HELD);
  if (shown.length > 0) {
    lines.push(`Messages still waiting for your answer (${shown.length}${held.length > shown.length ? ` of ${held.length}` : ''}, oldest first):`);
    for (const m of shown) {
      const text = m.text.length > MAX_HELD_CHARS ? `${m.text.slice(0, MAX_HELD_CHARS)}…` : m.text;
      lines.push(`- ${new Date(m.at).toISOString()} ${m.who}: ${text}`);
    }
    lines.push('', 'Answer each of them now, in this conversation. One reply may cover several.');
  } else {
    lines.push('Read the conversation and answer anything still unanswered. If nothing is waiting, send nothing.');
  }
  lines.push(
    '',
    'Your reply only reaches the person through this command. Write the reply text only:',
    ...replyCommand(channel),
  );
  if (channel.platform === 'slack') {
    lines.push('Do not pass a channel id to the script: this session is already bound to the conversation.');
  }
  return lines.join('\n');
}

export interface OperatorNoticeRoutes {
  /** Telegram attention topic send, when there is one. Throws on failure. */
  telegram?: (text: string) => Promise<void>;
  slack?: {
    attentionChannel: string | null;
    /** The operators who are members of the channel. Throws when it can't be read. */
    readersOf: (channelId: string) => Promise<string[]>;
    post: (channelId: string, text: string) => Promise<void>;
    /** The operators' Slack ids (see `operatorSlackIds`). */
    people: () => string[];
    directMessage: (userId: string, text: string) => Promise<void>;
  };
  warn?: (m: string) => void;
}

/**
 * Send a fixed notice so a person can read it. True only when someone who reads it got it: the
 * Telegram attention topic, a Slack alert channel with one of the agent's people in it, or a
 * direct message. A post to an alert channel nobody is in is kept as a record but is not "told"
 * (2026-11-04 drill: the notice went to an empty channel and the person text said "My operator
 * has been told").
 */
export async function deliverOperatorNotice(routes: OperatorNoticeRoutes, text: string): Promise<boolean> {
  const warn = routes.warn ?? (() => {});
  const why = (err: unknown) => (err instanceof Error ? err.message : String(err));
  let delivered = false;
  if (routes.telegram) {
    try { await routes.telegram(text); delivered = true; }
    catch (err) { /* @silent-fallback-ok: `delivered` stays false, which drives the retry and its capped report */ warn(`Telegram notice failed: ${why(err)}`); }
  }
  const slack = routes.slack;
  if (!slack) return delivered;
  let channelRead = false;
  if (slack.attentionChannel) {
    let readers: string[] | null = null;
    try { readers = await slack.readersOf(slack.attentionChannel); }
    catch (err) { /* @silent-fallback-ok: unknown readers means the direct messages below still go */ warn(`could not read the alert channel's members: ${why(err)}`); }
    // A channel known to have none of the operators in it is skipped: a post there reaches
    // nobody, and every retry would repeat it.
    if (readers === null || readers.length > 0) {
      try {
        await slack.post(slack.attentionChannel, text);
        channelRead = readers !== null;
      } catch (err) { /* @silent-fallback-ok: `channelRead` stays false, so the direct messages below go */ warn(`Slack notice failed: ${why(err)}`); }
    }
  }
  if (channelRead) return true;
  if (delivered) return true; // Telegram reached the operator: no need to message people directly too
  for (const userId of slack.people()) {
    try { await slack.directMessage(userId, text); delivered = true; }
    catch (err) { /* @silent-fallback-ok: `delivered` stays false unless another person was reached */ warn(`direct message failed: ${why(err)}`); }
  }
  return delivered;
}

/** Above this many authorized people with no owner or admin among them, nobody is messaged directly. */
export const MAX_UNRANKED_OPERATORS = 3;

/**
 * Who the operator is on Slack: the authorized people whose user profile is an owner or admin.
 * With no ranked profile, a small authorized list (a personal agent: the operator and perhaps a
 * partner) stands in; a large one is a team, where a direct message to everyone is spam.
 */
export function operatorSlackIds(
  authorized: readonly string[],
  profiles: ReadonlyArray<{ slackUserId?: string; role: string }>,
): string[] {
  const ranked = authorized.filter((id) => profiles.some((p) => p.slackUserId === id && (p.role === 'owner' || p.role === 'admin')));
  if (ranked.length > 0) return ranked;
  return authorized.length <= MAX_UNRANKED_OPERATORS ? [...authorized] : [];
}
