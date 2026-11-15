// IDs belong in links and diagnostic details. They never stand in for names.
export function verifiedDisplayName(value, id = null) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name === String(id ?? '')) return null;
  if (/^\d+$/.test(name)) return null;
  if (/^(?:\[deleted\]\s*)?(?:telegram\s+)?topic[-\s#]*\d+$/i.test(name)) return null;
  if (/^[a-f0-9]{8,}(?:…|\.\.\.)?$/i.test(name) || /^m_[a-z0-9]{12,}$/i.test(name)) return null;
  if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(name)) return null;
  if (/^a2aproof-\d+$/i.test(name) || /^[CGD][A-Z0-9]{8,}$/.test(name)) return null;
  if (/^(?:conversation|channel|agent|machine|account|session|topic|initiative|project|subsystem|work item) name unavailable$/i.test(name) || /^(?:an? )?unnamed (?:agent|machine|account|session|feature|person|part)$/i.test(name) || /^(?:another machine|a machine with no name yet|the account|promise details unavailable)$/i.test(name) || /^checking (?:conversation|channel) name/i.test(name)) return null;
  return name;
}

// A name alone must identify exactly one destination before it enters an action picker.
export function uniqueNamedChoices(items, idOf = (item) => item.fp, nameOf = (item) => item.name) {
  const named = items.map((item) => ({ item, name: verifiedDisplayName(nameOf(item), idOf(item)) })).filter((entry) => entry.name);
  const counts = new Map();
  for (const { name } of named) {
    const key = name.toLocaleLowerCase();
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return named.filter(({ name }) => counts.get(name.toLocaleLowerCase()) === 1).map(({ item }) => item);
}

const CODE_WORDS = { CMT: 'another promise', ACT: 'an action item', BLK: 'a blocker', EVO: 'an improvement idea' };

/**
 * A promise's words for a list row: the reference ids it carries ("fb-2ea93840-f48",
 * "thread 63567ed2", "CMT-056", "topic 1000000000143", "m_4cbc0d4a…") become plain words, with
 * a conversation's name when it is known. The full text, ids and all, stays in the details view.
 */
export function plainReferenceText(text, { topicNames = {}, machineNames = {} } = {}) {
  let t = String(text == null ? '' : text);
  if (!t) return t;
  const fb = String.raw`fb-[0-9a-f]{6,}(?:-[0-9a-z]+)*`;
  // A list of feedback ids (with or without a leading "Feedback") is a count of reports.
  t = t.replace(new RegExp(String.raw`(?:\bfeedback\s+)?\b${fb}(?:\s*(?:,|and|&)\s*(?:${fb}|fb\b…?))*(?:,?\s*…)?`, 'gi'), (m) => {
    const n = (m.match(new RegExp(fb, 'gi')) || []).length;
    return n > 1 ? `${n} feedback reports` : 'a feedback report';
  });
  // Ids inside brackets that hold nothing else go entirely: "(CMT-056)", "(ACT-12, CMT-9)".
  t = t.replace(/\s*\((?:\s*(?:CMT|ACT|BLK|EVO)-\d+\s*[,;/]?\s*)+\)/g, '');
  t = t.replace(/\b(CMT|ACT|BLK|EVO)-\d+\b/g, (_, k) => CODE_WORDS[k]);
  // Conversations: "topic 1234", "topic #1234", "Telegram topic 1234".
  t = t.replace(/\b(?:telegram\s+)?topic\s*#?(\d{3,})\b/gi, (_, id) => {
    const name = verifiedDisplayName(topicNames[id], id);
    return name ? `the “${name}” conversation` : 'a conversation';
  });
  // Agent-to-agent threads and their message ids.
  t = t.replace(/\b(?:(?:canonical|threadline|A2A)\s+)*thread[\s-]+(?:\d{10,}-[0-9a-z]+|[0-9a-f]{6,}(?:-[0-9a-f]{3,})*)\b/gi, 'an agent thread');
  t = t.replace(/\bmsg-\d{10,}-[0-9a-z]+\b/gi, 'a message');
  // Machine ids.
  t = t.replace(/\b(?:machine\s+)?m_[0-9a-f]{8,}\b/gi, (m) => { const id = m.replace(/^machine\s+/i, ''); return verifiedDisplayName(machineNames[id]) || 'another machine'; });
  // Bare long hex ids and UUIDs left over.
  t = t.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, 'a reference');
  t = t.replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{12,}\b/gi, 'a reference');
  return t.replace(/\(\s*\)/g, '').replace(/\s+([,.;:])/g, '$1').replace(/[ \t]{2,}/g, ' ').trim();
}
