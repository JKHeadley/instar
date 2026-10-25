/**
 * Telegram topic spaces — an optional second forum group for issue topics.
 *
 * Telegram topic ids (`message_thread_id`) are only unique inside one group, while
 * everything above the Telegram edge (sessions, commitments, the relay script,
 * history) keys on one bare topic number. Topics in the configured issues group
 * therefore get an internal id of `ISSUES_TOPIC_OFFSET + threadId`. Telegram message
 * ids are signed 32-bit, so this range can never collide with a main-group topic.
 *
 * The translation happens only at the Telegram edges: `normalizeInboundThread` on
 * the way in, `toWireParams` on the way out. Both are idempotent, and both take the
 * caller's own config (no process-wide state: the origin layer can run before the
 * adapter exists).
 *
 * Spec: docs/specs/telegram-issues-group.md
 */

export const ISSUES_TOPIC_OFFSET = 10_000_000_000;
/** Telegram's General topic id. */
const GENERAL_THREAD = 1;

export interface TopicSpaceConfig {
  /** The main forum chat (messaging config `chatId`). */
  mainChatId?: string | number | null;
  /** The optional issues forum chat (messaging config `issuesChatId`). */
  issuesChatId?: string | number | null;
}

function norm(id: string | number | null | undefined): string | null {
  if (id === null || id === undefined) return null;
  const s = String(id).trim();
  return s === '' ? null : s;
}

export function isIssuesTopicId(topicId: number | string | null | undefined): boolean {
  const n = typeof topicId === 'string' ? Number(topicId) : topicId;
  return typeof n === 'number' && Number.isSafeInteger(n) && n > ISSUES_TOPIC_OFFSET;
}

export function issuesChatConfigured(cfg: TopicSpaceConfig): boolean {
  return norm(cfg.issuesChatId) !== null;
}

/** Internal topic id for a message in `chatId` with Telegram thread `threadId`. */
export function inboundTopicId(
  chatId: string | number | null | undefined,
  threadId: number | null | undefined,
  cfg: TopicSpaceConfig,
): number {
  const issues = norm(cfg.issuesChatId);
  const thread = threadId ?? GENERAL_THREAD;
  if (issues === null || norm(chatId) !== issues) return thread;
  if (thread >= ISSUES_TOPIC_OFFSET) return thread; // already internal — idempotent
  return ISSUES_TOPIC_OFFSET + thread;
}

interface InboundMessageLike {
  chat?: { id?: number | string };
  message_thread_id?: number;
}

/**
 * Rewrite `msg.message_thread_id` in place for a message from the issues chat. The
 * field is always set for such a message (the issues group's General has no thread
 * id and maps to OFFSET + 1). Messages from any other chat are untouched.
 */
export function normalizeInboundThread<T extends InboundMessageLike>(
  msg: T | null | undefined,
  cfg: TopicSpaceConfig,
): T | null | undefined {
  if (!msg) return msg;
  const issues = norm(cfg.issuesChatId);
  if (issues === null || norm(msg.chat?.id) !== issues) return msg;
  msg.message_thread_id = inboundTopicId(msg.chat?.id, msg.message_thread_id, cfg);
  return msg;
}

export class IssuesChatNotConfiguredError extends Error {
  constructor(topicId: number) {
    super(
      `issues-chat-not-configured: topic ${topicId} belongs to the issues group, but this ` +
      `process has no messaging config issuesChatId. Refusing to send it to the main group.`,
    );
    this.name = 'IssuesChatNotConfiguredError';
  }
}

/**
 * Translate an outbound Bot API parameter object. Acts only when `chat_id` is the
 * main chat (or absent) and `message_thread_id` is in the issues range; afterwards
 * `chat_id` is the issues chat, so a second pass is a no-op. Returns a new object
 * when it changes anything, the same object otherwise.
 */
export function toWireParams<P extends Record<string, unknown>>(
  params: P,
  cfg: TopicSpaceConfig,
): P {
  const thread = params.message_thread_id;
  if (!isIssuesTopicId(thread as number)) return params;
  const main = norm(cfg.mainChatId);
  const chat = norm(params.chat_id as string | number | undefined);
  const issues = norm(cfg.issuesChatId);
  if (issues !== null && chat === issues) return params; // already translated
  if (chat !== null && main !== null && chat !== main) return params; // someone else's chat
  if (issues === null) throw new IssuesChatNotConfiguredError(Number(thread));
  const out: Record<string, unknown> = { ...params, chat_id: issues };
  const real = Number(thread) - ISSUES_TOPIC_OFFSET;
  if (real <= GENERAL_THREAD) delete out.message_thread_id;
  else out.message_thread_id = real;
  if (isIssuesTopicId(out.reply_to_message_id as number)) {
    out.reply_to_message_id = Number(out.reply_to_message_id) - ISSUES_TOPIC_OFFSET;
  }
  return out as P;
}
