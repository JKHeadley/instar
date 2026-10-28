/**
 * stableJson — deterministic JSON: object keys sorted recursively, arrays kept in
 * order, `undefined` object members dropped (as JSON.stringify drops them). Two
 * structurally equal values always serialize to the same string, whatever order
 * their keys were built in, so the string can be hashed into a content fingerprint.
 */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const s = JSON.stringify(value);
    return s === undefined ? 'null' : s;
  }
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableJson(obj[k])).join(',') + '}';
}
