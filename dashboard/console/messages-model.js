// Messages to you — pure view-model (docs/specs/console-features/people-settings.md).
// Leads with held messages, separating replies from automatic output when known;
// never shows a held count of zero
// when the status could not be read.

import { ago } from './home-model.js';
import { verifiedDisplayName } from './display-identity.js';

const HOLD_WORDS = {
  'lease-not-held': 'waiting to be routed through the machine that holds the conversation',
  'destination-not-authorized': 'addressed outside the chats this agent may write to',
  'origin-display-authority-unavailable': 'waiting for the message-recording service',
  'transport-acceptance-unknown': 'Telegram did not confirm it arrived',
  'capacity-unavailable': 'waiting for room to send',
};
export function holdWords(reason) {
  if (!reason) return 'held for an unstated reason';
  return HOLD_WORDS[reason] || String(reason).replace(/[-_]/g, ' ');
}

export function heldHeadline(count, replies, automatic, other) {
  if (!Number.isInteger(count) || count < 0) return "Can't tell how many messages are held.";
  if (!count) return 'No messages are held.';
  if ([replies, automatic, other].every(Number.isInteger) && replies + automatic + other === count && (replies || automatic)) {
    const parts = [
      replies ? `${replies} ${replies === 1 ? 'reply' : 'replies'}` : null,
      automatic ? `${automatic} automatic ${automatic === 1 ? 'message' : 'messages'}` : null,
      other ? `${other} other ${other === 1 ? 'message' : 'messages'}` : null,
    ].filter(Boolean);
    return `${parts.join(' and ')} ${count === 1 ? 'is' : 'are'} held on this machine.`;
  }
  return `${count} ${count === 1 ? 'message is' : 'messages are'} held on this machine.`;
}

export function buildMessagesPage(statusRes, healthRes, now = Date.now(), topicNames = {}) {
  if (!statusRes.ok) {
    // The held count still comes from /health when the detailed status is out of reach.
    const hf = healthRes && healthRes.ok && healthRes.data && healthRes.data.telegramOrigin && healthRes.data.telegramOrigin.heldForward;
    return { ok: false, reason: `Couldn't read message records: ${statusRes.reason}.`, needsUnlock: /PIN|unlock|403|401|operator/i.test(statusRes.reason || ''), heldForward: hf || null };
  }
  const s = statusRes.data || {};
  const held = Array.isArray(s.held) ? s.held : null;
  if (!held) return { ok: false, reason: 'The message status answered without its held list.' };
  const hf = s.heldForward || {};
  const expired = (Number(hf.expiredUnreported) || 0) + (Number(s.expiredHolds && s.expiredHolds.totalSinceBoot) || 0);
  const individual = held.map((h) => {
    const topic = h.topicId || (h.destination && h.destination.topicId);
    const since = h.heldSince || h.createdAt || h.updatedAt;
    return {
      key: h.operationId || h.originId || `${topic}:${since}`,
      main: verifiedDisplayName(topicNames[String(topic)], topic) || 'Conversation name unavailable',
      sub: holdWords(h.hold_reason || h.holdReason || h.reason),
      end: ago(since, now) || '',
      tone: 'attn', record: h, topicId: topic || null, sinceTs: Date.parse(since) || 0,
    };
  }).sort((a, b) => b.sinceTs - a.sinceTs);
  // The status route often has no topic title. Repeating "A conversation" for
  // every held send makes 24 copies of one delivery fault look like 24 tasks.
  // Keep named conversations distinct; summarize anonymous sends by cause.
  const groups = new Map();
  for (const item of individual) {
    const key = item.topicId ? `topic:${item.topicId}` : `cause:${item.sub}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const rows = [...groups.entries()].map(([key, items]) => {
    const first = items[0];
    const oldest = items.reduce((min, item) => item.sinceTs && (!min || item.sinceTs < min) ? item.sinceTs : min, 0);
    const count = items.length;
    const main = first.topicId ? first.main : count === 1 ? '1 delayed message' : `${count} delayed messages`;
    return { key, main, sub: first.sub, end: oldest ? `oldest ${ago(oldest, now)}` : '', tone: 'attn',
      records: items.map((item) => item.record), topicId: first.topicId, count, sinceTs: oldest };
  }).sort((a, b) => b.count - a.count || b.sinceTs - a.sinceTs);
  const counts = (s.metrics && s.metrics.counts) || {};
  const unknown = Number(counts['attempt:outcome-unknown']) || 0;
  const accepted = Number(counts['attempt:accepted']) || 0;
  const act = s.activation || {};
  const notReady = Array.isArray(act.observations) ? act.observations.filter((o) => o.state !== 'ready' && o.state !== 'not-applicable') : [];
  let headline;
  if (held.length) {
    const replies = held.filter(h => h.producerKind === 'session').length;
    const automatic = held.filter(h => h.producerKind === 'server-automation').length;
    headline = heldHeadline(held.length, replies, automatic, held.length - replies - automatic);
  } else if (expired) headline = `${expired} ${expired === 1 ? 'message' : 'messages'} expired before delivery.`;
  else headline = 'No messages are held.';
  const sub = [
    held.length ? 'I need to restore delivery. This is not a task for you.' : null,
    individual.length && individual[individual.length - 1].sinceTs ? `The oldest has waited ${ago(individual[individual.length - 1].sinceTs, now).replace(' ago', '')}.` : null,
    unknown && accepted ? `Of ${accepted.toLocaleString()} sends Telegram confirmed, ${unknown.toLocaleString()} more ended without a confirmation either way.` : null,
  ].filter(Boolean).join(' ');
  return {
    ok: true, rows, expired, headline, sub,
    tone: held.length ? 'attn' : expired ? 'bad' : 'ok',
    recording: act.complete ? 'on' : 'not fully set up',
    notReady: notReady.map((o) => ({ main: String(o.obligation || '').replace(/-/g, ' '), sub: `${String(o.subject || '').replace(/-/g, ' ')} · ${o.state}${o.reason ? ' · ' + String(o.reason).replace(/-/g, ' ') : ''}`, tone: o.state === 'held' ? 'attn' : 'unknown' })),
    storage: s.storage && s.storage.store ? s.storage.store.state : null,
    facts: [
      ...(expired ? [{ n: expired, label: 'lost before delivery', tone: 'bad' }] : []),
    ],
  };
}

/** The display settings in plain switches. */
export function displayModel(res) {
  if (!res || !res.ok) return { ok: false, reason: res ? res.reason : 'not read' };
  const d = res.data || {};
  if (!d.defaults || typeof d.revision !== 'string') return { ok: false, reason: 'the display settings answered without their values' };
  const topics = Array.isArray(d.topics) ? d.topics.filter((t) => t && t.editable !== false) : [];
  return { ok: true, defaults: d.defaults, revision: d.revision, topics, incomplete: Boolean(d.topicsMayBeIncomplete) };
}
