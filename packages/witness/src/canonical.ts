/**
 * Canonical JSON for signing.
 *
 * Two parties must produce the same bytes for the same record, or a valid
 * signature fails to verify. This is the RFC 8785 (JCS) form restricted to
 * the subset every language serialises identically: object keys sorted by
 * UTF-16 code unit, no whitespace, strings escaped as JSON.stringify does,
 * and numbers limited to safe integers. Floats are where implementations
 * disagree (1e21, 0.1+0.2, -0), so signed data never contains one.
 *
 * Values JSON cannot represent exactly (undefined, functions, symbols,
 * bigint, non-plain objects) are rejected instead of silently dropped —
 * a field that vanishes during signing is a field the signature never covered.
 */

export function canonicalize(value: unknown): string {
  return encode(value, '$');
}

function encode(value: unknown, at: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
        throw new TypeError(`canonicalize: only safe integers are allowed in signed data, got ${value} at ${at}`);
      }
      return String(value);
    case 'object': {
      if (Array.isArray(value)) {
        return '[' + value.map((v, i) => encode(v, `${at}[${i}]`)).join(',') + ']';
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError(`canonicalize: only plain objects are allowed at ${at}`);
      }
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).sort();
      return '{' + keys.map(k => JSON.stringify(k) + ':' + encode(obj[k], `${at}.${k}`)).join(',') + '}';
    }
    default:
      throw new TypeError(`canonicalize: unsupported ${typeof value} at ${at}`);
  }
}
