/** instar-telegram-origin-v1: RFC 8785 JSON with safe integer / scalar Unicode constraints. */
import { createHash } from 'node:crypto';

export type OriginJson = null | boolean | number | string | OriginJson[] | { [key: string]: OriginJson };

function scalarString(value: string): void {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('origin-canonical: lone surrogate');
    } else if (c >= 0xdc00 && c <= 0xdfff) throw new Error('origin-canonical: lone surrogate');
  }
}

export function canonicalOrigin(value: unknown): string {
  const active = new Set<object>();
  function encode(v: unknown): string {
    if (v === null) return 'null';
    if (typeof v === 'string') { scalarString(v); return JSON.stringify(v); }
    if (typeof v === 'boolean') return String(v);
    if (typeof v === 'number') {
      if (!Number.isSafeInteger(v)) throw new Error('origin-canonical: number must be a safe integer');
      return JSON.stringify(v);
    }
    if (typeof v !== 'object') throw new Error('origin-canonical: non-JSON value');
    if (active.has(v)) throw new Error('origin-canonical: cycle');
    active.add(v);
    try {
      if (Array.isArray(v)) {
        if (Object.keys(v).length !== v.length) throw new Error('origin-canonical: sparse or extended array');
        return '[' + v.map(encode).join(',') + ']';
      }
      if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) {
        throw new Error('origin-canonical: non-JSON object');
      }
      if (Object.getOwnPropertySymbols(v).length) throw new Error('origin-canonical: symbol key');
      return '{' + Object.keys(v).sort().map(key => {
        scalarString(key);
        const d = Object.getOwnPropertyDescriptor(v, key)!;
        if (!('value' in d)) throw new Error('origin-canonical: accessor');
        return JSON.stringify(key) + ':' + encode(d.value);
      }).join(',') + '}';
    } finally { active.delete(v); }
  }
  return encode(value);
}

export function originDigest(value: unknown): string {
  return createHash('sha256').update(canonicalOrigin(value), 'utf8').digest('hex');
}
export function wireDigest(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Validate duplicate names BEFORE JSON.parse erases them, at every nesting depth. */
export function parseOriginJson(input: string, maxBytes = 8 * 1024 * 1024): OriginJson {
  if (Buffer.byteLength(input) > maxBytes) throw new Error('origin-canonical: JSON too large');
  let at = 0;
  const ws = () => { while (/\s/.test(input[at] ?? '') && at < input.length) at++; };
  function stringToken(): string {
    const start = at++;
    while (at < input.length) {
      const c = input[at++];
      if (c === '\\') { at++; continue; }
      if (c === '"') return JSON.parse(input.slice(start, at)) as string;
    }
    throw new Error('origin-canonical: unterminated string');
  }
  function scan(depth: number): void {
    if (depth > 100) throw new Error('origin-canonical: excessive nesting');
    ws();
    if (input[at] === '"') { stringToken(); return; }
    if (input[at] === '{') {
      at++; ws(); const keys = new Set<string>();
      if (input[at] === '}') { at++; return; }
      for (;;) {
        ws(); if (input[at] !== '"') throw new Error('origin-canonical: invalid object');
        const key = stringToken();
        if (keys.has(key)) throw new Error('origin-canonical: duplicate JSON key');
        keys.add(key); ws();
        if (input[at++] !== ':') throw new Error('origin-canonical: missing colon');
        scan(depth + 1); ws(); const c = input[at++];
        if (c === '}') return;
        if (c !== ',') throw new Error('origin-canonical: invalid object delimiter');
      }
    }
    if (input[at] === '[') {
      at++; ws(); if (input[at] === ']') { at++; return; }
      for (;;) {
        scan(depth + 1); ws(); const c = input[at++];
        if (c === ']') return;
        if (c !== ',') throw new Error('origin-canonical: invalid array delimiter');
      }
    }
    const start = at;
    while (at < input.length && !/[\s,}\]]/.test(input[at])) at++;
    if (start === at) throw new Error('origin-canonical: missing value');
    JSON.parse(input.slice(start, at));
  }
  scan(0); ws();
  if (at !== input.length) throw new Error('origin-canonical: trailing input');
  const parsed: unknown = JSON.parse(input);
  canonicalOrigin(parsed);
  return parsed as OriginJson;
}
