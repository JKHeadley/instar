// "Watch the session" on a conversation's page: the session answering this conversation, one tap
// away, like the app's Open session button (Justin, topic 140618, 2026-11-14: the dashboard's
// conversation page should match the app, starting with a jump to the session). Pure: it reads
// the same GET /sessions?scope=pool answer the Sessions page lists, so the link always lands on
// a row that page shows.
import { sessionKey, spanWords } from './sessions-model.js';
import { verifiedDisplayName } from './display-identity.js';

const isActive = (s) => s && (s.status === 'running' || s.status === 'starting');

/** The conversation a session answers, in the `telegram:<topic>` / `app:<key>` form. */
export function sessionConversationRef(s) {
  if (!s) return null;
  if (typeof s.conversationRef === 'string' && s.conversationRef) return s.conversationRef;
  const topic = Number(s.telegramTopicId ?? (s.platform === 'telegram' ? s.platformId : NaN));
  return Number.isSafeInteger(topic) && topic > 0 ? `telegram:${topic}` : null;
}

function machineWords(s, pool) {
  const named = verifiedDisplayName(s.machineNickname, s.machineId);
  if (named) return named;
  if (s.remote) {
    const m = (Array.isArray(pool.machines) ? pool.machines : []).find((x) => x && x.machineId === s.machineId);
    return verifiedDisplayName(m && m.nickname, s.machineId) || 'another machine';
  }
  return verifiedDisplayName(pool.selfMachineNickname) || 'this machine';
}

/**
 * What the page shows for `sourceKey` (from make-card.js sourceKeyFor; null = a conversation
 * that has no sessions of its own here, so nothing is shown). `sessionsRes` is `{ ok, data }`.
 * Answers { state: 'running' | 'none' | 'unknown', words, href?, label? }.
 */
export function conversationSession(sessionsRes, sourceKey, now = Date.now()) {
  if (!sourceKey) return null;
  const data = sessionsRes && sessionsRes.ok ? sessionsRes.data : null;
  if (!data || !Array.isArray(data.sessions)) {
    return { state: 'unknown', words: 'Couldn’t check whether a session is running for this conversation. Try again in a moment.' };
  }
  const pool = data.pool || {};
  const matches = data.sessions.filter((s) => isActive(s) && sessionConversationRef(s) === sourceKey);
  if (!matches.length) {
    return { state: 'none', words: 'No session is running for this conversation right now. The next message in it starts one.' };
  }
  // This machine's session first, then the newest: the one most likely answering right now.
  const started = (s) => { const t = Date.parse(s.startedAt); return Number.isFinite(t) ? t : 0; };
  matches.sort((a, b) => (a.remote === true) - (b.remote === true) || started(b) - started(a));
  const s = matches[0];
  const span = s.startedAt ? spanWords(now - started(s)) : null;
  const since = span === 'now' ? ', started just now' : span ? `, started ${span} ago` : '';
  const machines = new Set(matches.map((m) => (m.remote === true ? `r:${m.machineId}` : 'self')));
  const twice = machines.size > 1 ? ' It is also running on another machine at the same time.' : '';
  return {
    state: 'running',
    label: 'Watch the session',
    href: `#/work/sessions?s=${encodeURIComponent(sessionKey(s))}`,
    words: `Running on ${machineWords(s, pool)}${since}.${twice}`,
  };
}
