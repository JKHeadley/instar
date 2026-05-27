/**
 * dispatch.ts — framework-agnostic port of the dispatch (guidance-out) logic.
 *
 * Ports the pure logic of `the-portal/pages/api/instar/dispatches/index.ts` out of
 * the Next.js handler: the dispatch type/priority vocab, the semver comparison used
 * for version-compat filtering (an agent only receives a dispatch whose
 * [minVersion, maxVersion] window includes the agent's version), the list query
 * filter (since/type/version), and the create-dedup title normalization. The HTTP
 * wiring + storage are excluded (the app-placement decision); this is the reusable
 * core. Reference is TypeScript, so equivalence is by faithful transcription +
 * exhaustive both-sides-of-boundary tests (not a cross-runtime parity harness).
 */

export const DISPATCH_TYPES = ['strategy', 'behavioral', 'lesson', 'configuration', 'security', 'action'] as const;
export type DispatchType = typeof DISPATCH_TYPES[number];
export const DISPATCH_PRIORITIES = ['low', 'normal', 'high', 'critical'] as const;
export type DispatchPriority = typeof DISPATCH_PRIORITIES[number];

export const SEMVER_RE = /^\d+\.\d+\.\d+(-[\w.]+)?$/;

export function isValidDispatchType(type: unknown): type is DispatchType {
  return typeof type === 'string' && (DISPATCH_TYPES as readonly string[]).includes(type);
}
export function isValidDispatchPriority(p: unknown): p is DispatchPriority {
  return typeof p === 'string' && (DISPATCH_PRIORITIES as readonly string[]).includes(p);
}

/** Port of parseVersion: leading major.minor.patch → [n,n,n]; [0,0,0] if unparseable. */
export function parseVersion(v: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!match) return [0, 0, 0];
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Port of isVersionGte: version >= min (major.minor.patch, equal counts as gte). */
export function isVersionGte(version: string, min: string): boolean {
  const v = parseVersion(version);
  const m = parseVersion(min);
  for (let i = 0; i < 3; i++) {
    if (v[i] > m[i]) return true;
    if (v[i] < m[i]) return false;
  }
  return true; // equal
}

/** Port of isVersionLte: version <= max (equal counts as lte). */
export function isVersionLte(version: string, max: string): boolean {
  const v = parseVersion(version);
  const m = parseVersion(max);
  for (let i = 0; i < 3; i++) {
    if (v[i] < m[i]) return true;
    if (v[i] > m[i]) return false;
  }
  return true; // equal
}

export interface DispatchRecord {
  dispatchId: string;
  type: string;
  title: string;
  content?: string;
  priority?: string;
  minVersion?: string | null;
  maxVersion?: string | null;
  active?: boolean;
  createdAt?: string;
  [k: string]: unknown;
}

/**
 * Port of handleList's version-compat filter: a dispatch is included only if the
 * agent's version is within its [minVersion, maxVersion] window. Mirrors the
 * reference — applied only when the agent sent a valid-semver version; otherwise
 * all candidates pass (the caller gates on SEMVER_RE before calling).
 */
export function filterDispatchesForVersion(dispatches: DispatchRecord[], version: string): DispatchRecord[] {
  return dispatches.filter((d) => {
    if (d.minVersion && !isVersionGte(version, d.minVersion)) return false;
    if (d.maxVersion && !isVersionLte(version, d.maxVersion)) return false;
    return true;
  });
}

/** Port of the create-path title normalization used for dedup: trim + cap at 500 chars. */
export function normalizeDispatchTitle(title: string): string {
  return title.trim().slice(0, 500);
}
