/**
 * One reference for every conversation (docs/specs/session-swap-any-conversation.md §2).
 *
 *   telegram:<topicId>                  → profile key `<topicId>`
 *   app:<uuid>                          → profile key `app:<uuid>`
 *   slack:<team>:<channel>[:<thread>]   → profile key `slack:<channel>[:<thread>]`
 *
 * A bare positive integer is read as `telegram:<n>`, so older callers keep working. Anything else
 * is refused. Telegram and Slack profile keys are the forms the store already holds.
 */
import { parseCanonicalKey } from './conversationIdentity.js';
import { APP_CONVERSATION_KEY_PATTERN } from './appConversationText.js';

export type ConversationKind = 'telegram' | 'app' | 'slack';
export interface ConversationKeys {
  kind: ConversationKind;
  /** The reference in its canonical form. */
  ref: string;
  /** Where the conversation's engine and model live (TopicProfileStore key). */
  profileKey: string;
  /** Telegram topic id, app conversation key, or Slack routing key (`<channel>[:<thread>]`). */
  id: string;
}

const TELEGRAM = /^(?:telegram:)?([1-9][0-9]{0,15})$/;
const APP = new RegExp(`^app:(${APP_CONVERSATION_KEY_PATTERN})$`);

export function conversationKeys(ref: unknown): ConversationKeys | null {
  if (typeof ref !== 'string' || ref.length === 0 || ref.length > 200) return null;
  const t = TELEGRAM.exec(ref);
  if (t) {
    if (!Number.isSafeInteger(Number(t[1]))) return null;
    return { kind: 'telegram', ref: `telegram:${t[1]}`, profileKey: t[1], id: t[1] };
  }
  const a = APP.exec(ref);
  if (a) return { kind: 'app', ref, profileKey: ref, id: a[1] };
  const s = parseCanonicalKey(ref);
  if (s) {
    const routing = s.tuple.threadTs ? `${s.tuple.channelId}:${s.tuple.threadTs}` : s.tuple.channelId;
    return { kind: 'slack', ref, profileKey: `slack:${routing}`, id: routing };
  }
  return null;
}

/** The kind behind a profile key: `<n>` Telegram, `app:<uuid>` app, `slack:<channel>[:<thread>]` Slack. */
export function profileKeyKind(profileKey: string): ConversationKind | null {
  if (/^[1-9][0-9]{0,15}$/.test(profileKey)) return 'telegram';
  if (new RegExp(`^app:${APP_CONVERSATION_KEY_PATTERN}$`).test(profileKey)) return 'app';
  if (/^slack:[A-Za-z0-9._-]{1,64}(?::[0-9.]{1,32})?$/.test(profileKey)) return 'slack';
  return null;
}

/** The app conversation key in an `app:<uuid>` profile key, or null. */
export function appKeyOf(profileKey: string): string | null {
  const m = new RegExp(`^app:(${APP_CONVERSATION_KEY_PATTERN})$`).exec(profileKey);
  return m ? m[1] : null;
}

/** The Slack routing key (`<channel>[:<thread>]`) in a `slack:` profile key, or null. */
export function slackRoutingKeyOf(profileKey: string): string | null {
  return profileKey.startsWith('slack:') && profileKeyKind(profileKey) === 'slack' ? profileKey.slice('slack:'.length) : null;
}

/** What `tokenMayWriteConversation` needs to know about one conversation. */
export interface ConversationWriteFacts {
  app: (conversationKey: string) => { known: boolean; servedHere: boolean; ownersOwn: boolean };
  slack: (routingKey: string) => { connected: boolean; known: boolean };
}

/**
 * May a token write (the owner's dashboard, or the owner's phone through Face ID) change this app or
 * Slack conversation's engine (spec §3.4)? App: this machine serves it and it is the owner's own (a
 * support person's conversation is theirs). Slack: this machine holds the Slack connection and knows
 * the conversation. Each refusal says what to do, in plain words.
 */
export function tokenMayWriteConversation(profileKey: string, facts: ConversationWriteFacts): { ok: true } | { ok: false; reply: string } {
  const app = appKeyOf(profileKey);
  if (app) {
    const f = facts.app(app);
    if (!f.known) return { ok: false, reply: 'This conversation isn\'t on this agent any more, so it can\'t be switched.' };
    if (!f.ownersOwn) return { ok: false, reply: 'This conversation belongs to someone you share the agent with. It can be switched from their side.' };
    if (!f.servedHere) return { ok: false, reply: 'Another of your machines runs this conversation right now. Switch it there, or try again in a moment.' };
    return { ok: true };
  }
  const slack = slackRoutingKeyOf(profileKey);
  if (slack) {
    const f = facts.slack(slack);
    if (!f.connected) return { ok: false, reply: 'This machine isn\'t connected to Slack, so it can\'t switch a Slack conversation. Switch it on the machine that is.' };
    if (!f.known) return { ok: false, reply: 'This Slack conversation isn\'t known on this machine yet. Send it a message first, then switch.' };
    return { ok: true };
  }
  return { ok: false, reply: 'This conversation can\'t be switched from here.' };
}
