/**
 * Small pure helpers for native app conversations (docs/specs/mobile-native-conversations.md).
 *
 * - The conversation key: a bare lowercase RFC 4122 v4 UUID (4.1). Every route, response,
 *   signed path and stored record carries it; the registry's negative id is a per-machine alias.
 * - Titles are untrusted text, cleaned exactly as Slack sender names are (4.1).
 * - Exact-format authority tokens (a pairing invite, a remote-desktop code) are REMOVED from an
 *   app message before it reaches a session; nothing else is altered (4.2 step 3).
 */
import crypto from 'node:crypto';

/** The strict lowercase RFC 4122 v4 pattern of spec 4.1 (no anchors; compose with them). */
export const APP_CONVERSATION_KEY_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
export const APP_CONVERSATION_KEY_RE = new RegExp(`^${APP_CONVERSATION_KEY_PATTERN}$`);

export function isAppConversationKey(value: unknown): value is string {
  return typeof value === 'string' && APP_CONVERSATION_KEY_RE.test(value);
}

/** A fresh conversation key (crypto.randomUUID is lowercase v4). */
export function newAppConversationKey(): string {
  return crypto.randomUUID();
}

/**
 * The canonical store/registry key for a conversation key: `app:<uuid>` for a native
 * conversation; `telegram:<topicId>` and Slack canonical keys pass through (later increments).
 */
export function canonicalConversationKey(conversationKey: string): string {
  return isAppConversationKey(conversationKey) ? `app:${conversationKey}` : conversationKey;
}

/** The app conversation key inside an `app:<uuid>` canonical key, else null. */
export function parseAppCanonicalKey(key: string): string | null {
  if (!key.startsWith('app:')) return null;
  const k = key.slice(4);
  return isAppConversationKey(k) ? k : null;
}

export const TITLE_MAX = 80;

/**
 * Clean a title exactly as Slack sender names are cleaned at the injection boundary
 * (control characters, `"`, `[`, `]`, `(`, `)` stripped, whitespace collapsed), then check
 * 1–80 characters. Returns null when nothing usable remains or it is too long.
 */
export function cleanConversationTitle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/["[\]()]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length < 1 || cleaned.length > TITLE_MAX) return null;
  return cleaned;
}

export type RemovedTokenKind = 'pairing-invite' | 'desktop-code';
const INVITE_RE = /tlinv1:[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
// A remote-desktop approval is a whole line `/desktop <id> <code>` (the Telegram path consumes
// any line that starts with /desktop, malformed included, so a typo cannot leak).
const DESKTOP_LINE_RE = /^[ \t]*\/desktop(?:[ \t][^\n]*)?$/gim;

/**
 * Replace each exact-format authority token with a fixed placeholder; return the remaining text
 * and the kinds removed. Structure alone decides (exact matches); content is never judged.
 */
export function removeAuthorityTokens(text: string): { text: string; kinds: RemovedTokenKind[] } {
  const kinds = new Set<RemovedTokenKind>();
  let out = text.replace(INVITE_RE, () => { kinds.add('pairing-invite'); return '[pairing invite removed]'; });
  out = out.replace(DESKTOP_LINE_RE, () => { kinds.add('desktop-code'); return '[desktop code removed]'; });
  return { text: out, kinds: [...kinds] };
}

/** Deterministic event id from parts (sha256, hex, 32 chars, prefixed). */
export function derivedEventId(prefix: string, ...parts: string[]): string {
  return `${prefix}-${crypto.createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32)}`;
}
