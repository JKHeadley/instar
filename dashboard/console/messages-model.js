// Message footer settings. Delivery holds are an internal recovery concern, not
// an operator task or a dashboard status.

export function displayModel(res) {
  if (!res || !res.ok) return { ok: false, reason: res ? res.reason : 'not read', needsUnlock: Boolean(res && res.needsUnlock) };
  const d = res.data || {};
  if (!d.defaults || typeof d.revision !== 'string') return { ok: false, reason: 'the display settings answered without their values' };
  const topics = Array.isArray(d.topics) ? d.topics.filter((t) => t && t.editable !== false) : [];
  return { ok: true, defaults: d.defaults, revision: d.revision, topics, incomplete: Boolean(d.topicsMayBeIncomplete) };
}
