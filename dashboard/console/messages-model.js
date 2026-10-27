// Messages to you — pure view-model (docs/specs/console-features/people-settings.md).
// Leads with replies held back from the operator; never shows a held count of zero
// when the status could not be read.

import { ago } from './home-model.js';

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
  const rows = held.map((h) => {
    const topic = h.topicId || (h.destination && h.destination.topicId);
    const since = h.heldSince || h.createdAt || h.updatedAt;
    return {
      key: h.operationId || h.originId || `${topic}:${since}`,
      main: topicNames[String(topic)] || (topic ? `Conversation ${topic}` : 'A conversation'),
      sub: holdWords(h.hold_reason || h.holdReason || h.reason),
      end: ago(since, now) || '',
      tone: 'attn', record: h, sinceTs: Date.parse(since) || 0,
      // The Attention item that announced this hold (telegram-origin-held:<topic>) lands here.
      item: topic ? `telegram-origin-held:${topic}` : null,
    };
  }).sort((a, b) => b.sinceTs - a.sinceTs);
  const counts = (s.metrics && s.metrics.counts) || {};
  const unknown = Number(counts['attempt:outcome-unknown']) || 0;
  const accepted = Number(counts['attempt:accepted']) || 0;
  const act = s.activation || {};
  const notReady = Array.isArray(act.observations) ? act.observations.filter((o) => o.state !== 'ready' && o.state !== 'not-applicable') : [];
  let headline;
  if (rows.length) headline = rows.length === 1 ? '1 reply to you is held.' : `${rows.length} replies to you are held.`;
  else if (expired) headline = `${expired} ${expired === 1 ? 'reply' : 'replies'} expired before reaching you.`;
  else headline = 'No replies are held.';
  const sub = [
    rows.length && rows[rows.length - 1].sinceTs ? `The oldest has waited ${ago(rows[rows.length - 1].sinceTs, now).replace(' ago', '')}.` : null,
    unknown && accepted ? `Of ${accepted.toLocaleString()} sends Telegram confirmed, ${unknown.toLocaleString()} more ended without a confirmation either way.` : null,
  ].filter(Boolean).join(' ');
  return {
    ok: true, rows, expired, headline, sub,
    tone: rows.length ? 'attn' : expired ? 'bad' : 'ok',
    recording: act.complete ? 'on' : 'not fully set up',
    notReady: notReady.map((o) => ({ main: String(o.obligation || '').replace(/-/g, ' '), sub: `${String(o.subject || '').replace(/-/g, ' ')} · ${o.state}${o.reason ? ' · ' + String(o.reason).replace(/-/g, ' ') : ''}`, tone: o.state === 'held' ? 'attn' : 'unknown' })),
    storage: s.storage && s.storage.store ? s.storage.store.state : null,
    facts: [
      { n: rows.length, label: 'held now', tone: rows.length ? 'attn' : null },
      { n: expired, label: 'expired undelivered', tone: expired ? 'bad' : null },
      { n: act.complete ? 'on' : 'partly', label: 'recording', tone: act.complete ? null : 'attn' },
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
