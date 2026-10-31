// IDs belong in links and diagnostic details. They never stand in for names.
export function verifiedDisplayName(value, id = null) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name === String(id ?? '')) return null;
  if (/^\d+$/.test(name)) return null;
  if (/^(?:\[deleted\]\s*)?(?:telegram\s+)?topic[-\s#]*\d+$/i.test(name)) return null;
  if (/^[a-f0-9]{8,}(?:…|\.\.\.)?$/i.test(name) || /^m_[a-z0-9]{12,}$/i.test(name)) return null;
  if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(name)) return null;
  if (/^a2aproof-\d+$/i.test(name) || /^[CGD][A-Z0-9]{8,}$/.test(name)) return null;
  if (/^(?:conversation|channel|agent|machine|account|session|topic) name unavailable$/i.test(name) || /^(?:an? )?unnamed (?:agent|machine|account|session|feature|person|part)$/i.test(name) || /^checking (?:conversation|channel) name/i.test(name)) return null;
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
