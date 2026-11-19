/**
 * What a bearer caller may write into the agent's config (SEC-075).
 *
 * `PATCH /config` holds the rules for a bearer caller: only allowlisted top-level keys, only
 * `intelligence.selfActionGovernor` under `intelligence` (its disable direction needs the
 * operator PIN), never the session keys that choose which executable runs, never a reserved
 * object key, and never a raise of trust or autonomy. Any OTHER path that writes config on a
 * bearer caller's behalf (the commitment auto-correction) must hold the same rules, or it is a
 * way around them. This module states them once for a single-path write.
 */
import { configPatchRaises } from '../core/TrustRaiseGuard.js';
import type { AutonomyProfileLevel } from '../core/types.js';

export const RESERVED_CONFIG_PATH_SEGMENTS: ReadonlySet<string> = new Set(['__proto__', 'prototype', 'constructor']);

/** Turn `a.b.c` = v into `{ a: { b: { c: v } } }` (the patch PATCH /config would receive). */
export function pathToPatch(dotPath: string, value: unknown): Record<string, unknown> {
  const parts = dotPath.split('.');
  const root: Record<string, unknown> = {};
  let cur = root;
  for (let i = 0; i < parts.length - 1; i++) { const next: Record<string, unknown> = {}; cur[parts[i]] = next; cur = next; }
  cur[parts[parts.length - 1]] = value;
  return root;
}

/**
 * Null when a bearer caller may write `value` at `dotPath`; otherwise a plain reason.
 * `patchableKeys` / `operatorOnlySessionKeys` are PATCH /config's own sets (single source).
 */
export function bearerConfigWriteRefusal(
  dotPath: string,
  value: unknown,
  opts: {
    fileConfig: Record<string, unknown>;
    profile?: AutonomyProfileLevel;
    patchableKeys: ReadonlySet<string>;
    operatorOnlySessionKeys: ReadonlyArray<string>;
  },
): string | null {
  if (typeof dotPath !== 'string' || !dotPath) return 'a config path is required';
  const parts = dotPath.split('.');
  if (parts.some((p) => !p || RESERVED_CONFIG_PATH_SEGMENTS.has(p))) return `"${dotPath}" is not a valid config path`;
  const reservedInValue = findReservedKeyIn(value);
  if (reservedInValue) return `"${reservedInValue}" is not a valid config key`;
  const [top, second, third] = parts;
  if (top === 'intelligence') {
    if (second !== 'selfActionGovernor') return `${dotPath} cannot be changed with the API key`;
    if (third === undefined && (!value || typeof value !== 'object' || Array.isArray(value))) return 'intelligence.selfActionGovernor must be an object';
    if ((third === undefined && value && typeof value === 'object' && (value as Record<string, unknown>).emergencyDisable === true)
      || (third === 'emergencyDisable' && value === true)) {
      return 'switching the flood brake off needs the operator PIN';
    }
  } else if (!opts.patchableKeys.has(top)) {
    return `${top} cannot be changed with the API key`;
  }
  if (top === 'sessions') {
    const keys = second !== undefined ? [second] : (value && typeof value === 'object' ? Object.keys(value as object) : []);
    if (keys.some((k) => opts.operatorOnlySessionKeys.includes(k))) {
      return 'the settings that choose which program a session runs can only be set on the machine';
    }
  }
  if (top === 'notifications' && (second === 'selectivity' || (second === undefined && value && typeof value === 'object' && 'selectivity' in (value as object)))) {
    return 'notification selectivity has its own confirmed surface';
  }
  if (top === 'remoteDesktop') return 'remote desktop is changed through its own confirmed route';
  // Compare against exactly what the write would produce: the value deep-set into a copy of the
  // current config (a single-path write keeps sibling entries), passed as the whole top-level block.
  const after = structuredClone(opts.fileConfig) as Record<string, unknown>;
  deepSet(after, parts, value);
  const raises = configPatchRaises(opts.fileConfig as never, { [top]: after[top] } as never, opts.profile);
  if (raises.length > 0) return `this would raise trust or autonomy (${raises.join(', ')}), which needs the operator`;
  return null;
}

function deepSet(obj: Record<string, unknown>, parts: string[], value: unknown): void {
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = Object.prototype.hasOwnProperty.call(cur, parts[i]) ? cur[parts[i]] : undefined;
    if (!next || typeof next !== 'object' || Array.isArray(next)) cur[parts[i]] = {};
    cur = cur[parts[i]] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

/** The dotted path of the first reserved key anywhere in a value, or null. */
export function findReservedKeyIn(value: unknown, prefix = ''): string | null {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) { const h = findReservedKeyIn(value[i], `${prefix}[${i}]`); if (h) return h; }
    return null;
  }
  for (const key of Object.keys(value)) {
    const p = prefix ? `${prefix}.${key}` : key;
    if (RESERVED_CONFIG_PATH_SEGMENTS.has(key)) return p;
    const h = findReservedKeyIn((value as Record<string, unknown>)[key], p);
    if (h) return h;
  }
  return null;
}
