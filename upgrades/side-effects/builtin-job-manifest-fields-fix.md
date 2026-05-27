# Side-Effects Review — Built-in job manifest missing required fields (fleet-wide fix)

**Spec:** `docs/specs/BUILTIN-JOB-MANIFEST-FIELDS-FIX.md` (converged 2 iters, approved by Justin)
**Change:** Fixes the fleet-wide job-load failure (`jobCount=0` since ~2026-05-20): both manifest
producers (`InstallBuiltinJobs`, `jobMigrate`) omitted `priority`/`expectedDurationMinutes`/`model` +
pass-throughs that the loader's `PerSlugManifest` requires. Introduces a single typed
`buildPerSlugManifest(): PerSlugManifest` used by both, a producer-side `validateManifest` self-check,
and `coerceDurationMinutes`/`coerceBool` helpers.
**Files:** `src/scheduler/buildPerSlugManifest.ts` (new), `src/scheduler/InstallBuiltinJobs.ts`,
`src/commands/jobMigrate.ts`, `src/scheduler/AgentMdJobLoader.ts` (add `disabledAtBodyHash?` to the
`PerSlugManifest` interface), `tests/unit/scheduler/InstallBuiltinJobs.test.ts`.

## Principle check (Phase 1)

Decision point? The loader's `validateManifest` is a correctness gate — this change does NOT loosen
it. It strengthens the PRODUCERS to honor the contract and adds a producer-side LOUD self-check. No
runtime agent-behavior gate is added or relaxed. (Consumer-leniency was explicitly rejected at
converge — fail-loud preserved.)

## The seven questions

1. **Over-block.** `InstallBuiltinJobs` now fails loud (records an error, skips) when a template's
   `expectedDurationMinutes` is missing/invalid — correct (shipped templates always have it; a
   malformed one SHOULD be caught, not silently written). Could reject a hand-broken template — but
   that's the intended loud signal.
2. **Under-block.** The producer self-check round-trips each manifest through the loader's
   `validateManifest` before writing — so a producer that drops any required field fails at
   generation, not silently at load. The unit test round-trips producer→validator (the assertion
   that actually prevents recurrence).
3. **Level-of-abstraction fit.** One shared typed constructor returning `PerSlugManifest` — a dropped
   required field is now a `tsc` error, converting the bug class from runtime-fleet-wide to
   compile-time. Both producers use it (the root structural cause: two hand-rolled producers drifted).
4. **Signal vs authority.** Compliant + strengthened. The validator keeps its blocking authority; we
   added a producer-side loud self-check; no silent defaulting in the consumer.
5. **Interactions.** `InstallBuiltinJobs` preserves `enabled` + `disabledAtBodyHash` exactly as
   before; the new fields are additive. `jobMigrate` now DEFAULTS legacy-missing `priority`→'medium'
   and `expectedDurationMinutes`→5 (build-time refinement: legacy jobs.json entries predate these
   fields, so migration supplies sensible defaults to keep the job loadable rather than aborting —
   distinct from `InstallBuiltinJobs`'s fail-loud, since the migration source is legacy data, not a
   complete shipped template). Lockfile unaffected (hashes `.md`, not the manifest — verified).
6. **External surfaces.** No new routes/config. The generated manifest JSON gains the required fields
   (+ pass-throughs). Self-heals all broken built-in manifests on the next update via
   `PostUpdateMigrator.migrateBuiltinJobs` → `installBuiltinJobs` always-overwrite. User manifests
   self-heal on the legacy-jobs migration path (the `jobMigrate` fix).
7. **Rollback cost.** Low — revert restores the bug. The added manifest fields are harmless to any
   reader. No data migration beyond the additive regeneration.

## Phase 5 — second-pass

Not required as a separate spawn: the spec already passed a 3-reviewer (lessons-aware + integration +
adversarial) 2-round convergence — the multi-angle audit Phase 5 exists to provide — and this is a
data-shape producer fix + a typed helper, with no block/allow/session/sentinel/gate surface. The
consumer's gate is untouched (not loosened).

## Build-time refinements beyond the spec

- `jobMigrate` DEFAULTS legacy-missing `priority`/`expectedDurationMinutes` (migration leniency for
  legacy data) rather than the spec's fail-loud (which applies to shipped templates). Surfaced by an
  existing jobMigrate idempotency test whose fixtures are minimal legacy entries — the correct
  behavior for the migration path.
- Added `disabledAtBodyHash?` to the `PerSlugManifest` interface (it was always written by
  InstallBuiltinJobs but unmodeled — now the typed helper can carry it).

## Testing

- Unit (InstallBuiltinJobs, +4): **round-trip** (producer output PASSES `validateManifest`); carries
  priority/duration(number)/model + pass-throughs (unrestrictedTools/tags); **FAILS LOUD** (error +
  no manifest) on missing/invalid duration; **EVERY real shipped template** produces a loader-valid
  manifest (`installed >= 10`, all pass `validateManifest`).
- Unit (jobMigrate): existing suite green with the shared helper (legacy-defaults verified by the
  idempotency + skip tests).
- Affected push-config suite: 3745 tests green vs canonical main.
- **Live evidence (test-as-self, after publish):** restart Echo onto the fixed version and capture
  `GET /jobs` jobCount 0 → ≥(shipped count) + no new `manifest-invalid` lines — the reproduce→verify
  the bug-fix evidence bar requires, on the live system that's failing this way now.
