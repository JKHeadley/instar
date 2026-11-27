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

/**
 * SEC-151: settings under API-patchable blocks that decide where the agent is reachable or connects,
 * what a peer-started session may do, or which framework runs. Each is the operator's to set in the
 * config file; neither PATCH /config nor a bearer single-path write may change them. Same authority
 * class as the session binary fence (OPERATOR_ONLY_SESSION_KEYS) and the dispatch origin fence.
 */
export const OPERATOR_ONLY_CONFIG_PATHS: ReadonlyArray<string> = [
  // The public address: a named tunnel's token and config choose whose Cloudflare account and which
  // hostname the agent answers on; relay providers expose it through third-party relays.
  'tunnel.token', 'tunnel.configFile', 'tunnel.hostname', 'tunnel.relayProviders',
  // Where agent-to-agent traffic goes, and what a peer-started session may touch.
  'threadline.relayUrl', 'threadline.listener.relayUrl',
  'threadline.listener.pipeMode.allowedTools', 'threadline.listener.pipeMode.allowedPaths',
  'threadline.listener.pipeMode.minIqsBand', 'threadline.listener.pipeMode.model',
  // Whom the agent trusts on the agent network: switching these off sends plaintext to pinned peers,
  // accepts downgraded plaintext, or lets unknown and first-contact peers in. Read live.
  'threadline.encryptToPinned', 'threadline.refuseDowngrade', 'threadline.relayUnknownSenderTrust',
  'threadline.localRouteTrust', 'threadline.firstContactPolicy', 'threadline.warmSessionA2A.trustFloor',
  // Which framework (and so which provider and account) runs sessions and each component.
  'sessions.framework', 'sessions.componentFrameworks', 'sessions.enabledFrameworks',
  'sessions.frameworkDefaultModels', 'sessions.natureRouting',
  // Where feedback is sent, and which file the agent rewrites with it.
  'feedback.webhookUrl', 'feedback.feedbackFile',
];

/**
 * The fenced paths a PATCH /config body would change. That route merges one level deep, so a body
 * naming a second-level key replaces that whole subtree: it touches every fenced path beneath it.
 */
export function operatorOnlyPathsInPatch(patch: unknown): string[] {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return [];
  const body = patch as Record<string, unknown>;
  return OPERATOR_ONLY_CONFIG_PATHS.filter((p) => {
    const [top, second] = p.split('.');
    const block = body[top];
    if (block === undefined) return false;
    // A non-object top-level value replaces the whole block.
    if (!block || typeof block !== 'object' || Array.isArray(block)) return true;
    return Object.prototype.hasOwnProperty.call(block, second);
  });
}

/** The fenced path a single-path write at `dotPath` would change (it, an ancestor, or a descendant), or null. */
export function operatorOnlyPathForWrite(dotPath: string): string | null {
  const parts = dotPath.split('.');
  for (const p of OPERATOR_ONLY_CONFIG_PATHS) {
    const f = p.split('.');
    const n = Math.min(f.length, parts.length);
    if (f.slice(0, n).every((seg, i) => seg === parts[i])) return p;
  }
  return null;
}
/** SEC-153: `dispatches` keys that choose where remote instructions come from and who may sign them. Config file only. */
export const DISPATCH_ORIGIN_KEYS: ReadonlyArray<string> = ['dispatchUrl', 'dispatchFile', 'trustedKeys'];

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
      return 'the settings that choose which program a session runs, where Claude sessions connect and which account pays can only be set on the machine';
    }
  }
  if (top === 'dispatches') {
    const keys = second !== undefined ? [second] : (value && typeof value === 'object' ? Object.keys(value as object) : []);
    if (keys.some((k) => DISPATCH_ORIGIN_KEYS.includes(k))) {
      return 'where dispatches come from and which keys may sign them can only be set on the machine';
    }
  }
  const fenced = operatorOnlyPathForWrite(dotPath)
    ?? (parts.length === 1 ? operatorOnlyPathsInPatch({ [top]: value })[0] ?? null : null);
  if (fenced) return `${fenced} decides where the agent is reachable or connects, what a peer-started session may do, or which framework runs, so it can only be set on the machine`;
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
