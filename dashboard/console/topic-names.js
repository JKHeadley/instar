// Telegram topic titles may be known by a different machine in the pool.
import { verifiedDisplayName } from './display-identity.js';

// Never promote a routing identifier into a user-facing title.
export function isRealTopicName(value, id = null) {
  return verifiedDisplayName(value, id) !== null;
}

export function topicNameMap(res) {
  const rows = res?.ok && Array.isArray(res.data?.topics) ? res.data.topics : [];
  const names = {};
  for (const row of rows) {
    if (Number.isSafeInteger(Number(row?.topicId)) && isRealTopicName(row?.topicName, row.topicId)) {
      names[String(row.topicId)] = row.topicName.trim();
    }
  }
  // A topic no machine can name: its bound project's title (the server sends these apart, `fallbacks`). Never over a real name.
  const fallbacks = res?.ok && Array.isArray(res.data?.fallbacks) ? res.data.fallbacks : [];
  for (const row of fallbacks) {
    const id = String(row?.topicId);
    if (Number.isSafeInteger(Number(row?.topicId)) && !names[id] && isRealTopicName(row?.title, row.topicId)) names[id] = row.title.trim();
  }
  return names;
}

export function sessionTopicName(session, names = {}) {
  const id = session?.platformId ?? (String(session?.name || '').match(/^topic-(\d+)$/i)?.[1]);
  if (id != null && names[String(id)]) return names[String(id)];
  if (isRealTopicName(session?.platformName, id)) return session.platformName.trim();
  if (session?.platform === 'telegram' || /^topic-\d+$/i.test(String(session?.name || ''))) return 'Conversation name unavailable';
  if (session?.platform === 'slack') return 'Channel name unavailable';
  return null;
}
