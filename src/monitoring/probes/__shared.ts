/**
 * Probe-source-binding shared helpers — F-8 rest of Tier-2 (A52).
 *
 * Per `docs/specs/SELF-HEALING-REMEDIATOR-V2-SPEC.md` §A40 + §A52, every probe
 * that emits a `NormalizedDegradationEvent` (provenance `'probe-id'`) MUST
 * declare a verify-scope that lists the subsystems the probe is allowed to
 * report on. The Remediator dispatcher reads the scope at runtime, verifies
 * the per-probe leaf-key signature on the emitted event, then refuses to
 * dispatch any event whose `subsystem` is outside the declared scope —
 * routing it to `audit-rejected.jsonl` instead.
 *
 * This module exposes the canonical type + a tiny helper for reading the
 * `__verifyScope` const export from a probe module. F-8-rest migrates ONE
 * example probe (`LifelineProbe`) as a smoke-test; full fleet migration is
 * Tier-3 work.
 *
 * The scope is declared as `as const` so the type-system pins each subsystem
 * tag and a `git grep` can find every consumer.
 */

export type ProbeVerifyScope = ReadonlyArray<string>;

/**
 * Type-only marker so probe modules can do
 *
 *   export const __verifyScope = ['lifeline'] as const satisfies ProbeVerifyScope;
 *
 * without us having to pin the tuple shape per call-site.
 */
export interface ProbeVerifyScopeExporter {
  readonly __verifyScope: ProbeVerifyScope;
}

/**
 * Read the declared verify-scope from a probe module. Returns an empty
 * frozen array when the module hasn't been migrated yet (Tier-3 work). The
 * Remediator treats an empty scope as "this probe has not opted-in to A52
 * enforcement" — its events fall through the legacy match path.
 *
 * Returning an empty array (not null) lets callers write
 *
 *   const scope = readVerifyScope(probeModule);
 *   if (scope.includes(event.subsystem)) { ... }
 *
 * without a null check at every site.
 */
export function readVerifyScope(
  probeModule: Partial<ProbeVerifyScopeExporter> | undefined | null,
): ProbeVerifyScope {
  if (!probeModule) return Object.freeze([]);
  const scope = probeModule.__verifyScope;
  if (!Array.isArray(scope)) return Object.freeze([]);
  // Defensive copy + freeze so callers can't mutate the export.
  return Object.freeze(scope.slice());
}

/**
 * Convenience: does the given subsystem fall inside the probe's declared
 * verify-scope? Returns `false` when the scope is empty (un-migrated probe).
 */
export function subsystemInScope(
  scope: ProbeVerifyScope,
  subsystem: string,
): boolean {
  if (scope.length === 0) return false;
  return scope.includes(subsystem);
}
