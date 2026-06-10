<!-- bump: patch -->
<!-- audience: agent-only -->

## What Changed

The feedback-migration **cutover-readiness door** can now resolve its **integrity** leg. A new trigger — `POST /cutover-readiness/integrity-pass` — runs the REAL pre-click integrity pass and records the verdict to the canonical integrity path.

Previously the door's formula (`ready = integrity.passed && parity.cleared && !parity.stale`) was unsatisfiable: the parity leg worked (#1007), but `recordIntegrityReport` had **zero callers** — nothing ever ran a real import and wrote the report, so `integrity.passed` could never become true and the door could never open. The import-dryrun route is deliberately walled off from the integrity path (its report can never green the gate), so it couldn't fill the gap either.

The new pass: live read-only fetch → AS-IS import into a **persisted shadow** (`PersistedShadowImportTarget`, a throwaway JSONL copy — never canonical) → the full integrity gate over the readback → `recordIntegrityReport`. A passing report greens the leg; a failing one flips it closed (the door always reflects the latest real verdict). The heavy 145K-row pass runs OFF the event loop in a child process (`integrityPassRunner`) — the same event-loop-contention lesson that drove the parity fix (#948) — sharing `CutoverReadiness`'s single-flight guard and max-hold backstop.

## What to Tell Your User

Internal migration infrastructure — nothing to configure. This wires the last piece needed for the cutover-readiness door to go fully green ahead of the operator-gated cutover click. Building or deploying it does NOT green the door — that requires explicitly running the integrity pass, and the cutover flip itself remains the operator's manual click.

## Summary of New Capabilities

| Capability | How to use |
|-----------|-----------|
| Run the REAL pre-click integrity pass + record the canonical verdict | `POST /cutover-readiness/integrity-pass` (Bearer-gated; 409 when no `feedbackMigration.paritySource` is configured) |
| Durable AS-IS import shadow for verification | `new PersistedShadowImportTarget(dir)` — JSONL-backed, dup-PK refusing, `dispose()`-able; never canonical |

## Evidence

Unit `tests/unit/cutover-readiness.test.ts` (28, incl. 7 new `runIntegrityPass`: greens-on-pass → door ready with parity / flips-closed-on-fail / no-record-on-abort / no-record-on-fetch-fail / unconfigured-refuse / single-flight-guard) + `tests/unit/feedback-factory/persisted-shadow-import-target.test.ts` (5 new). Integration `tests/integration/cutover-readiness-routes.test.ts` (14, incl. 4 new integrity-pass route). E2E `tests/e2e/cutover-readiness-lifecycle.test.ts` (5, incl. 1 new feature-alive on the real AgentServer init path). All green; `tsc --noEmit` clean. The integrity substance was independently proven over the live 145K-row corpus (0 issues). Earned from topic 12476 (feedback-process migration, Phase-2 / cutover-readiness integrity leg).
