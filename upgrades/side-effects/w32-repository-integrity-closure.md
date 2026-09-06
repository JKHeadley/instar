# Side-Effects Review — W32 repository-integrity closure

**Version / slug:** `w32-repository-integrity-closure`
**Date:** `2026-09-05`
**Author:** `Echo / Codex`
**Second-pass reviewer:** `Noether (/root/w32_integrity_review)`

## Summary of the change

This change closes four repository-wide integrity gates exposed by the final W32 full-suite run. `PostUpdateMigrator.ts` now includes the W32 preparation, liveness, and cadence awareness markers in the Codex/Gemini framework shadow; `WriteDomainRegistry.ts` declares W32 mutation routes machine-local; `AutonomousSessions.ts` and `WindowRunLivenessAuthority.ts` document intentional, externally visible fail-closed outcomes so the silent-fallback ratchet distinguishes them from silent degradation; and the hook-migration fixtures honestly distinguish synthetic anchor-compatible layouts from the separately exercised exact historical stock bytes. It adds no new runtime action or endpoint. The work is in the isolated `w32-integration` worktree, remote `JKHeadley/instar`, based on current `origin/main` `12e08c639`, package `1.3.1224`.

## Decision-point inventory

- `setAutonomousPreparationState` — pass-through/document — missing/unreadable state or an atomic write failure continues to return `false`; the change only records why this is an intentional refusal rather than a silent fallback.
- `WindowRunLivenessAuthority` recovery rebind — pass-through/document — a failed replacement-executor rebind continues to become a persisted failed recovery and loud terminal stall.
- `WriteDomainRegistry` route classification — add metadata/observability input — classifies the already-existing W32 mutation routes as machine-local/per-machine-path; the existing write-admission guard records that classification while continuing to return `proceed`.
- `PostUpdateMigrator` framework shadow markers and boundaries — modify — preserves already-installed W32 awareness sections during Codex/Gemini framework shadow migration, using line-complete nested markers and non-mirrored slice sentinels.

## 1. Over-block

No new block/allow behavior is added. The existing preparation carrier still refuses a missing, unreadable, active-incompatible, or unwritable state record by returning `false`. The liveness authority still refuses to claim recovery when executor rebinding fails. The new registry entries make both the conformance gate and existing write-admission observability recognize the correct owner; the runtime guard still records a `proceed` outcome and does not alter HTTP authorization or routing.

## 2. Under-block

The annotations do not add degradation reporting for the two refusal paths because neither path silently continues in a degraded success state: callers receive `false`, or the run persists a failed recovery and stalls. A caller that ignores the preparation carrier's `false` return remains a potential caller defect, but the current API and tests consume it as a failed transition. This change does not replicate machine-local W32 state after machine loss; doing so would be unsafe because two machines could then claim one executor history.

## 3. Level-of-abstraction fit

The write-domain declaration belongs in the single registry already used by repository conformance tests. Framework-shadow awareness belongs in the existing migrator marker list rather than in a parallel migration. The fallback annotations are attached to the exact catch blocks whose observable outcomes are already enforced. No second liveness, lifecycle, migration, or ownership authority is introduced.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change adds no semantic block/allow judgment. The two documented outcomes enforce enumerable state and persistence invariants.

The preparation path either atomically changes the requested local marker or reports `false`. The recovery path either durably rebinds the exact executor or records failure and invokes the existing terminal authority. Neither relies on text classification, similarity, or a brittle semantic detector.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point is added. Route-to-write-domain matching is an exact structural registry lookup, framework section matching uses stable shipped section markers for idempotent migration, and the two catch outcomes preserve existing hard invariants.

## 5. Interactions

- **Shadowing:** the new framework-shadow markers prevent W32 awareness from being omitted when Codex/Gemini shadow files are generated; line-complete `- **...**` markers plus `What's running` and `SessionReaper` boundary-only sentinels keep each slice exact. They do not change the primary CLAUDE migration.
- **Double-fire:** no action source, timer, retry, notification, or delivery call is added.
- **Races:** the preparation carrier retains its fsync-plus-rename write and safe best-effort removal of a non-authoritative temp file. The registry metadata does not touch runtime state.
- **Feedback loops:** none added. Failed recovery still converges through the existing one-attempt liveness state machine.

## 6. External surfaces

Existing agents updating across frameworks retain the W32 preparation/liveness/cadence awareness sections instead of receiving a shadow file that lacks them. No response schema, dashboard, operator action, Telegram message, URL, credential, database, or ledger format changes. The generated builtin manifest was refreshed locally for the test but remains a gitignored build artifact.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

**Machine-local BY DESIGN.** The W32 liveness, cadence, work-receipt, recovery, and preparation records describe one locally bound executor and live below that machine's non-replicated state directory. The new registry story makes that existing posture explicit so a future write-domain change cannot silently classify them as shared. These paths emit no new user-facing notices, create no URLs, and add no durable state. The observer machine is intended to be the sole W32 liveness authority; a second machine must not independently bind the same run. Cadence actuation has an explicit topic-ownership check, while liveness failure notification relies on that single-authority deployment invariant plus the existing tokenless Telegram transport owner, not an independent logical one-voice gate. A whole-machine loss can strand local proof, which correctly prevents an unverified peer from claiming continuity.

## 8. Rollback cost

Revert this commit and ship a patch. There is no data migration or agent-state repair because no schema or value is written. Rolling back would re-open the repository-integrity gaps: shadow awareness could become incomplete, the conformance registry would again lack W32 routes, and future test runs would flag the intentional catch paths and inaccurate historical fixtures.

## Conclusion

The first independent review found that marker substrings beginning after a bullet prefix would have malformed the shadow markdown and over-copied unrelated sections. The design now uses complete line-prefix markers, explicit non-mirrored boundaries, and a real `generateClaudeMd()` to AGENTS/GEMINI regression test. The review also corrected the fixture and write-observability descriptions. No new action authority remains. The change is clear to ship only after the reviewer concurs with this revision and the mandatory complete repository suite passes.

## Second-pass review (if required)

**Reviewer:** Noether (`/root/w32_integrity_review`)
**Independent read of the artifact:** **CONCUR after revision.** The first pass identified malformed nested-marker slicing, unrelated section over-copy, overstated historical-fixture wording, omitted write-admission observability, and an overstated logical one-voice claim. The implementation and artifact were revised. The reviewer then reproduced exact 490/1,556/759-character W32 slices from the real template, verified idempotency, confirmed the fixture and machine-local descriptions now match the code, and reported 212/212 focused tests plus a clean diff check.

## Evidence pointers

- Focused repair and migration gate: 233/233 tests.
- Expanded W32 unit/integration/E2E gate: 595/595 tests, including the 316-second real production lifecycle.
- `npx tsc --noEmit` — pass.
- `git diff --check` — pass.

## Class-Closure Declaration (display-only mirror)

No previously shipped agent-authored-artifact defect and no added or modified self-triggered controller — not applicable. The malformed shadow output existed only in the uncommitted first draft and was structurally caught by the required second-pass review; the final change includes a real-template regression test so that draft defect cannot land.
