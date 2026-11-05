/**
 * topicRef — a Telegram topic id is never handed to a session or a notice without its name.
 *
 * Operator rule (Justin, 2026-11-02): "An Instar agent should ALWAYS have access to the topic
 * name if they have access to the topic ID. The name and ID should be inseparable."
 *
 * Live case: a peer's server told its session "the server sent it to topic 11882, the topic for
 * echo" with no name, so the session told its user "I can't see the topic name from inside this
 * session" — although the name ("🤝 echo") was in the topic registry the whole time.
 *
 * Every server-authored text that names a topic id renders it through `topicRef`:
 *
 *   topic 11882 "🤝 echo"            — the VERIFIED name from the topic registry
 *   topic 11882 (name unresolved)    — no verified name; never an invented one
 *
 * The name comes from the registry (`setTopicNameResolver`, wired at server boot to the Telegram
 * adapter's `getTopicName`, which already applies the verified-identity rule) unless the caller
 * passes one it already holds. A candidate is accepted only through `verifiedEntityName`, so a
 * placeholder such as "topic-11882" never passes as a name. Names are sanitized like the
 * `[telegram:N "name"]` injection tag (control characters, quotes, instruction framing), since a
 * topic name is user- or peer-influenced text that lands in a session prompt.
 *
 * The ratchet test `tests/unit/topic-ref-ratchet.test.ts` fails when a new server-authored
 * string renders a bare `topic ${id}`.
 */

import { verifiedEntityName } from './channelIdentity.js';
import { sanitizeTopicName } from '../../utils/sanitize.js';

export type TopicNameResolver = (topicId: number) => string | null | undefined;

let resolver: TopicNameResolver | null = null;

/** Wire the registry read (server boot). Null unwires it (tests). */
export function setTopicNameResolver(fn: TopicNameResolver | null): void {
  resolver = fn;
}

/** The text shown when no verified name exists. Never a guess. */
export const TOPIC_NAME_UNRESOLVED = 'name unresolved';

const MAX_NAME = 120;

/** The verified, sanitized name of a topic, or null. Never throws. */
export function topicNameFor(topicId: number | string | null | undefined, candidate?: string | null): string | null {
  if (topicId === null || topicId === undefined || topicId === '') return null;
  const clean = (raw: unknown): string | null => {
    const v = verifiedEntityName(String(topicId), raw);
    if (!v) return null;
    const s = sanitizeTopicName(v).trim();
    if (!s) return null;
    return s.length > MAX_NAME ? `${s.slice(0, MAX_NAME)}…` : s;
  };
  const given = clean(candidate);
  if (given) return given;
  const n = typeof topicId === 'number' ? topicId : Number(topicId);
  if (!resolver || !Number.isFinite(n)) return null;
  try {
    return clean(resolver(n));
  } catch {
    return null; // @silent-fallback-ok — an unreadable registry renders "name unresolved", never a guess
  }
}

/**
 * `topic 11882 "🤝 echo"` or `topic 11882 (name unresolved)`. A missing id renders
 * `an unknown topic`. Pass `candidate` when the caller already holds a name.
 */
export function topicRef(topicId: number | string | null | undefined, candidate?: string | null): string {
  if (topicId === null || topicId === undefined || topicId === '' || topicId === '?') return 'an unknown topic';
  const name = topicNameFor(topicId, candidate);
  return name ? `topic ${topicId} "${name}"` : `topic ${topicId} (${TOPIC_NAME_UNRESOLVED})`;
}

/** `topicRef` for the start of a sentence: `Topic 11882 "🤝 echo"`. */
export function TopicRef(topicId: number | string | null | undefined, candidate?: string | null): string {
  const r = topicRef(topicId, candidate);
  return r.charAt(0).toUpperCase() + r.slice(1);
}

/** `Telegram topic 11882 "🤝 echo"` (or `(name unresolved)`). */
export function telegramTopicRef(topicId: number | string | null | undefined, candidate?: string | null): string {
  const r = topicRef(topicId, candidate);
  return r === 'an unknown topic' ? 'an unknown Telegram topic' : `Telegram ${r}`;
}
