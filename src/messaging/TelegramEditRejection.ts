/** Narrow evidence from the Telegram response boundary, never from error text. */
type EditRejection = 'message-missing' | 'not-modified';
interface EditTarget { method: string; accountId: string; params: Record<string, unknown>; }
interface Evidence { accountId: string; chatId: string; messageId: number; kind: EditRejection; }
const evidence = new WeakMap<Error, Readonly<Evidence>>();

function target(input: EditTarget): Omit<Evidence, 'kind'> | null {
  const { chat_id: chatId, message_id: messageId } = input.params;
  if (input.method !== 'editMessageText' || !/^\d+$/.test(input.accountId) ||
    !((typeof chatId === 'string' && /^-?\d+$/.test(chatId)) ||
      (typeof chatId === 'number' && Number.isSafeInteger(chatId))) ||
    typeof messageId !== 'number' || !Number.isSafeInteger(messageId) || messageId <= 0) return null;
  return { accountId: input.accountId, chatId: String(chatId), messageId };
}

/**
 * Only call with an actual Telegram response. Managed sends must first persist
 * the known-failed outcome. Keep the SAME error, including its origin operation.
 * Evidence stays local to this error object; serialization grants no authority.
 */
export function recordTelegramEditRejection<T extends Error>(error: T, status: number,
  body: unknown, input: EditTarget): T {
  const bound = target(input);
  if (!bound || status !== 400 || !body || typeof body !== 'object') return error;
  const reply = body as Record<string, unknown>;
  if (reply.ok !== false || reply.error_code !== 400) return error;
  let kind: EditRejection;
  if (reply.description === 'Bad Request: message to edit not found') kind = 'message-missing';
  else if (reply.description === 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message') kind = 'not-modified';
  else return error;
  evidence.set(error, Object.freeze({ ...bound, kind }));
  return error;
}

/** Consume once, only for the account/chat/message whose edit was rejected. */
export function takeTelegramEditRejection(error: unknown, input: EditTarget): EditRejection | null {
  if (!(error instanceof Error)) return null;
  const proof = evidence.get(error), expected = target(input);
  if (!proof || !expected || proof.accountId !== expected.accountId ||
    proof.chatId !== expected.chatId || proof.messageId !== expected.messageId) return null;
  evidence.delete(error);
  return proof.kind;
}
