/**
 * Canonical JSON for signing.
 *
 * Two parties must produce the same bytes for the same record, or a valid
 * signature fails to verify. Object keys are sorted, there is no whitespace,
 * and values JSON cannot represent exactly (undefined, NaN, Infinity,
 * functions, symbols, bigint) are rejected instead of silently dropped —
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
      if (!Number.isFinite(value)) throw new TypeError(`canonicalize: non-finite number at ${at}`);
      return JSON.stringify(value);
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
