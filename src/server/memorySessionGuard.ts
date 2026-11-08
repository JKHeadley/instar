/**
 * memorySessionGuard — what a session inside the memory boundary may ask the
 * server. Spec: docs/specs/memory-privacy.md §5.
 *
 * Default deny: a session token reaches only the routes listed here, so a new
 * route is closed until someone decides otherwise. This is deliberately a short
 * allow-list rather than a list of memory stores, because the same facts sit in
 * logs, transcripts, session output and the file viewer. There are no history
 * routes here: a session gets its place's history in its bootstrap message, and
 * the history routes also return other places' rows and assembled memory.
 */

import type { SessionTokenRecord } from '../users/MemoryPrivacy.js';

type Limit =
  /** No further check: the route carries no remembered content. */
  | 'any'
  /** Replies and delivery: the path's place must be the session's own. */
  | 'own-place';

interface Rule {
  method: 'GET' | 'POST';
  pattern: RegExp;
  limit: Limit;
  /** Turns the captured path part into a place key. Absent means the route binds the session itself. */
  place?: (part: string) => string;
}

const slack = (id: string) => `slack:${id}`;
const imessage = (id: string) => `imessage:${id}`;
const whatsapp = (id: string) => `whatsapp:${id}`;
/** Every Telegram topic is one place, the group, unless a team shares it (see placeMatches). */
const telegram = (topicId: string) => `telegram:${topicId}`;

export const MEMORY_SESSION_ROUTES: readonly Rule[] = [
  // Replies, one per channel.
  { method: 'POST', pattern: /^\/telegram\/reply\/([^/]+)$/, limit: 'own-place', place: telegram },
  { method: 'POST', pattern: /^\/slack\/reply\/([^/]+)$/, limit: 'own-place', place: slack },
  { method: 'POST', pattern: /^\/imessage\/reply\/([^/]+)$/, limit: 'own-place', place: imessage },
  { method: 'POST', pattern: /^\/imessage\/validate-send\/([^/]+)$/, limit: 'own-place', place: imessage },
  { method: 'POST', pattern: /^\/whatsapp\/send\/([^/]+)$/, limit: 'own-place', place: whatsapp },
  { method: 'POST', pattern: /^\/slack\/session-reply$/, limit: 'any' },
  { method: 'POST', pattern: /^\/app\/session-reply$/, limit: 'any' },
  // An earlier file of this conversation: the route's own bind check holds it to the session's conversation.
  { method: 'GET', pattern: /^\/app\/media-path\/[^/]+$/, limit: 'any' },
  { method: 'POST', pattern: /^\/messaging\/preflight$/, limit: 'any' },
  { method: 'POST', pattern: /^\/events\/delivery-failed$/, limit: 'any' },
  { method: 'POST', pattern: /^\/telegram\/origins\/operations\/[^/]+\/outcome$/, limit: 'any' },
  // Hooks and session plumbing.
  { method: 'POST', pattern: /^\/hooks\/(events|native-events)$/, limit: 'any' },
  { method: 'GET', pattern: /^\/internal\/stop-gate\/hot-path$/, limit: 'any' },
  { method: 'POST', pattern: /^\/internal\/stop-gate\/evaluate$/, limit: 'any' },
  { method: 'GET', pattern: /^\/identity\/soul\/integrity$/, limit: 'any' },
  { method: 'POST', pattern: /^\/feedback$/, limit: 'any' },
  // Asking the owner for something: the requester comes from the session, and it gives nothing by itself.
  { method: 'POST', pattern: /^\/team\/proposals$/, limit: 'any' },
];

const REPLY_ROUTE = /^\/(?:(telegram|slack|imessage)\/reply\/[^/]+|(whatsapp)\/send\/[^/]+|(slack|app)\/session-reply)$/;

/** The channel when this request is a reply reaching a person, else null. Preflights and hooks are not replies. */
export function memoryReplyChannel(method: string, path: string): string | null {
  if (method !== 'POST') return null;
  const m = REPLY_ROUTE.exec(path);
  return m ? (m[1] ?? m[2] ?? m[3]) : null;
}

function placeMatches(expected: string, own: string | null): boolean {
  if (!own) return false;
  if (!expected.startsWith('telegram:')) return expected === own;
  // A topic shared with a team has its own place, and its session is held to that topic.
  const topic = /^telegram:topic:(.+)$/.exec(own);
  if (topic) return expected === `telegram:${topic[1]}`;
  return own.startsWith('telegram:');
}

/** The decision for one request. A refusal names no store, so it reveals nothing. */
export function memorySessionAllows(method: string, path: string, session: SessionTokenRecord): boolean {
  for (const rule of MEMORY_SESSION_ROUTES) {
    if (rule.method !== method) continue;
    const match = rule.pattern.exec(path);
    if (!match) continue;
    if (rule.limit === 'any') return true;
    if (rule.place) return placeMatches(rule.place(decodeURIComponent(match[1] ?? '')), session.placeKey);
    return Boolean(session.placeKey);
  }
  return false;
}
