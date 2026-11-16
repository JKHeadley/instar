/**
 * The account path (trust-journey decision 5): pure rules for approval codes, the server-written
 * request card and acceptance statement, and whether one platform receipt approves one request.
 *
 * Nothing here talks to a platform or a store. The holder service feeds it verified receipts and
 * records; this module only decides. Every decision is deterministic over structured data.
 */
import crypto from 'node:crypto';

// ── Codes ─────────────────────────────────────────────────────────────

/** Crockford-style base32 without I, L, O, U, so a code read aloud or typed is unambiguous. */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CODE_LENGTH = 6;

export function newApprovalCode(isTaken: (code: string) => boolean, rand: (n: number) => Buffer = crypto.randomBytes): string {
  for (let attempt = 0; attempt < 64; attempt++) {
    const bytes = rand(CODE_LENGTH);
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    if (!isTaken(code)) return code;
  }
  throw new Error('could not allocate a unique approval code');
}

/** Normalizes a typed code: case-insensitive, and the look-alike letters map to their digits. */
export function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1');
}

/**
 * The yes is the displayed command, never a reading of words (spec section 2): the whole reply,
 * trimmed, must be `approve <code>`. Returns the normalized code, or null for any other reply.
 */
export function parseApproveCommand(text: string): string | null {
  const m = /^\s*approve\s+([0-9A-Za-z]{6})\s*$/i.exec(text ?? '');
  return m ? normalizeCode(m[1]) : null;
}

// ── Server-written text ───────────────────────────────────────────────

export const DISCLOSURE = 'approved from your account, which your agent can also use; this does not prove who approved';

export type AdapterKind = 'telegram' | 'slack';

export function acceptanceStatement(p: { adapter: AdapterKind; accountId: string; installationId: string }): string {
  const service = p.adapter === 'telegram' ? 'Telegram' : 'Slack';
  return `I accept that my replies from ${service} account ${p.accountId} count as my approval for Instar installation ${p.installationId}, even though my agent can also use this account. I can withdraw this at any time.`;
}

/** Whitespace-insensitive exact match: the person sends the statement back unchanged. */
export function isAcceptanceReply(reply: string, statement: string): boolean {
  const norm = (s: string) => (s ?? '').replace(/\s+/g, ' ').trim();
  return norm(reply) === norm(statement);
}

export interface ChangeSummary {
  /** One plain sentence per effect, written by the server from structured data. */
  lines: string[];
}

export function renderRequestCard(p: { summary: ChangeSummary; code: string; expiresAt: string; record?: string }): string {
  const expires = new Date(p.expiresAt);
  const day = expires.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  return [
    'Your agent is asking to change what it may do without asking you:',
    ...p.summary.lines.map((l) => `• ${l}`),
    ...(p.record ? ['', p.record] : []),
    '',
    `To approve, reply to this message with: approve ${p.code}`,
    `Any other reply approves nothing. This request expires ${day}.`,
    `An approval here is ${DISCLOSURE}.`,
  ].join('\n');
}

// ── Does this receipt approve this request? ───────────────────────────

/** A platform receipt, written only by the adapter's own inbound path on the receiving machine. */
export interface Receipt {
  receiptId: string;
  adapter: AdapterKind;
  /** The sender's platform id (Telegram user id, Slack user id). */
  senderId: string;
  /** Telegram: the private chat id; Slack: the DM channel id. */
  chatId: string;
  /** Telegram chat type, or Slack channel type ('im' for a DM). */
  chatType: string;
  messageId: string;
  replyToMessageId?: string;
  text: string;
  senderIsBot: boolean;
  forwarded: boolean;
  /** Telegram update_id, or Slack `${channel}:${ts}`: the single-use key. */
  uniqueKey: string;
  receivedAt: string;
  /** The machine that wrote the receipt (from the journal envelope origin, never a header). */
  receivedBy: string;
}

export interface RequestRecord {
  requestId: string;
  code: string;
  proposalHash: string;
  principal: string;
  adapter: AdapterKind;
  /** The person's platform id for that adapter, from unwritable config. */
  approverPlatformId: string;
  /** The message id of the card the server sent into the person's direct chat. */
  cardMessageId: string;
  cardChatId: string;
  expiresAt: string;
  status: 'open' | 'consumed' | 'expired' | 'superseded' | 'withdrawn';
}

export interface AcceptanceRecord {
  acceptanceId: string;
  principal: string;
  adapter: AdapterKind;
  accountId: string;
  acceptedAt: string;
  withdrawnAt?: string;
}

export type ReceiptVerdict =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Whether one receipt approves one request (decision 5, "What counts" and "Ingress"). The caller
 * has already established that the receipt came from the adapter's own platform path.
 */
export function receiptApproves(r: Receipt, req: RequestRecord, acceptance: AcceptanceRecord | null, now: Date, consumedKeys: (k: string) => boolean): ReceiptVerdict {
  if (req.status !== 'open') return { ok: false, reason: `request-${req.status}` };
  if (new Date(req.expiresAt).getTime() <= now.getTime()) return { ok: false, reason: 'request-expired' };
  if (r.adapter !== req.adapter) return { ok: false, reason: 'wrong-adapter' };
  if (r.senderIsBot) return { ok: false, reason: 'sender-is-bot' };
  if (r.forwarded) return { ok: false, reason: 'forwarded-message' };
  if (r.senderId !== req.approverPlatformId) return { ok: false, reason: 'not-the-approver' };
  if (r.adapter === 'telegram') {
    // A Telegram private chat's id equals the person's user id; a topic or group never counts.
    if (r.chatType !== 'private' || r.chatId !== r.senderId) return { ok: false, reason: 'not-a-direct-chat' };
  } else if (r.chatType !== 'im') {
    return { ok: false, reason: 'not-a-direct-chat' };
  }
  if (r.chatId !== req.cardChatId) return { ok: false, reason: 'different-chat' };
  if (!r.replyToMessageId || r.replyToMessageId !== req.cardMessageId) return { ok: false, reason: 'not-a-reply-to-the-card' };
  if (consumedKeys(r.uniqueKey)) return { ok: false, reason: 'receipt-already-used' };
  const code = parseApproveCommand(r.text);
  if (!code) return { ok: false, reason: 'not-the-approve-command' };
  if (code !== normalizeCode(req.code)) return { ok: false, reason: 'wrong-code' };
  if (!acceptance || acceptance.withdrawnAt || acceptance.principal !== req.principal || acceptance.adapter !== req.adapter
    || acceptance.accountId !== req.approverPlatformId) {
    return { ok: false, reason: 'no-current-acceptance' };
  }
  return { ok: true };
}
