// IDs belong in links and diagnostic details. They never stand in for names.
export function verifiedDisplayName(value, id = null) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name === String(id ?? '')) return null;
  if (/^(?:\[deleted\]\s*)?topic-\d+$/i.test(name)) return null;
  if (/^[a-f0-9]{8,}(?:…|\.\.\.)?$/i.test(name) || /^m_[a-z0-9]{12,}$/i.test(name)) return null;
  if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(name)) return null;
  if (/^a2aproof-\d+$/i.test(name) || /^C[A-Z0-9]{6,}$/i.test(name)) return null;
  if (/^(?:conversation|channel) name unavailable$/i.test(name) || /^checking (?:conversation|channel) name/i.test(name)) return null;
  return name;
}
