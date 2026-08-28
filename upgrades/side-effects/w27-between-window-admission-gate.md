# Side-Effects Review - W27 Between-Window Admission Gate

**Version / slug:** `w27-between-window-admission-gate`
**Date:** `2026-08-25`
**Author:** `Echo`
**Second-pass reviewer:** `Poincare`

## Summary of the change

This change adds a bounded between-window admission gate for W27 charter activation. It introduces `src/core/BetweenWindowAdmissionGate.ts`, wires `instar gate between-window --package <file>` through `src/commands/gate.ts` and `src/cli.ts`, and exposes authenticated `POST /gate/between-window-admission` in `src/server/routes.ts`. The gate reads the Telegram JSONL store, verifies required observer and tenet receipt references exist, validates the expected receipt structure, refuses the four required negative controls, and requires explicit surfacing of the two known corpus mismatches.

## Decision-point inventory

- `evaluateBetweenWindowAdmission()` - add - deterministic admission authority for W27 charter activation package shape and store-backed references.
- `instar gate between-window` - add - CLI entrypoint that exits nonzero on refusal.
- `POST /gate/between-window-admission` - add - authenticated HTTP entrypoint that returns 409 on refusal and 200 on pass.

## 1. Over-block

The gate can reject a real observer receipt if the receipt uses different field names than the accepted contract, for example `source` instead of `canonicalSource`, or a bare hash without the `sha256:` prefix. That is intentional for this admission point: the charter activation package is supposed to be machine-verifiable and structurally stable. The gate can also reject a legitimate package if the local Telegram JSONL store is incomplete or if a receipt was posted in the wrong topic. That is the desired failure mode for this check, because activation must rest on store-backed evidence, not a claim that evidence existed elsewhere.

## 2. Under-block

The gate does not reconcile the two corpora, prove quote text matches the full corpus, or decide whether an observer's assessment is substantively correct. It validates existence and structure, not truth of every quoted claim. A malicious or mistaken package could still include a syntactically valid hash and stored ids that point to irrelevant text. That deeper review belongs to observer and reviewer processes; this change only prevents missing, window-only, count-only, absent-assessment, misclassified-author, missing-tenet, and hidden-mismatch admissions.

## 3. Level-of-abstraction fit

This is at the API/CLI admission boundary, which is the right layer for structural validation. The validator is pure apart from reading the store and does not spread decision logic through activation callers. The route and CLI consume the same core result, so there is one admission policy rather than parallel implementations.

## 4. Signal vs authority compliance

Required reference: `docs/signal-vs-authority.md`.

- [x] Yes - but the logic is a deterministic policy evaluator for a constrained domain.

This change holds blocking authority, but only for hard structural invariants: required fields, store-backed message ids, full-history scope, hash shape, row separation, and required mismatch disclosure. It does not perform a low-context judgment about message meaning or agent intent. The domain is constrained enough to enumerate the valid package shape, so deterministic refusal is appropriate under the hard-invariant validation exception.

## 5. Interactions

Shadowing: the new HTTP route runs as its own admission endpoint and does not shadow existing routes. Callers must invoke it as charter preflight.

Double-fire: CLI and HTTP both call the same core validator, so they can be used by different operators without producing divergent answers.

Races: the validator reads the Telegram JSONL store at evaluation time. If a receipt is posted while the gate is running, the caller can rerun the gate after the store append completes.

Feedback loops: the gate writes no state and emits no automatic message, so refusal does not feed back into observer stores.

## 6. External surfaces

Other agents and users: new shipped CLI and HTTP surfaces are visible to operators and orchestration code.

External systems: the gate depends on Telegram store material already persisted locally. It does not call Telegram or mutate external systems.

Persistent state: none written by the gate.

Timing/runtime conditions: admission depends on the current local store contents. A stale local store will refuse, which is safer than activating from missing evidence.

Operator surface: no dashboard, approval page, grant form, revoke form, or secret-drop surface is added. The operator-facing surfaces are CLI and JSON HTTP response.

## 6b. Operator-surface quality

No operator surface as defined by the gate: no dashboard renderer, approval page, grant/revoke form, or secret-drop form is touched.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design for this implementation: the validator reads the local Telegram JSONL store passed by the current agent process. That is appropriate for W27 because the activation question is whether the current lane's store-facing evidence package is present and structurally valid where Pathway will run the gate. The result emits no user-facing notice, holds no durable state, and generates no URL. In a multi-machine deployment, orchestration should run the gate on the machine whose store is authoritative for the Pathway admission package or pass an explicit merged store path with `--store`.

## 8. Rollback cost

Rollback is a normal code revert and patch release. The change writes no durable state, performs no migration, and does not alter existing message stores. During rollback propagation, callers that already adopted the preflight endpoint would need to stop invoking it or accept a route-missing failure until the revert lands.

## Conclusion

The review found the main risk is strict structural over-block if observer package field names drift. That strictness is acceptable for a charter activation gate because the requested contract is explicit and store-backed. Second-pass review also found that the first implementation accepted any two full-history receipts without proving they came from distinct observers. The validator now requires explicit `observer-1` and `observer-2` identities, and the unit tier includes a same-observer duplicate control.

## Repair addendum - route-prefix classification

The repair change classifies the new `/gate` route prefix in `src/server/CapabilityIndex.ts`. The correct classification is `INTERNAL_PREFIXES`, not `CAPABILITY_INDEX`, because `POST /gate/between-window-admission` is operator/internal charter-opening admission machinery. It validates an evidence package for orchestration and review; it is not a general runtime capability an agent should discover and offer to users from `/capabilities`.

Side-effect review of this repair:

1. **Over-block:** the discoverability lint will now accept `/gate` without surfacing it in `/capabilities`. That is intentional only for this operator admission namespace. If a future `/gate` route becomes user or agent discoverable, this classification must be revisited in the same file.
2. **Under-block:** this repair does not add endpoint behavior or additional admission validation. It only closes the route-prefix classification gap the full suite caught.
3. **Level-of-abstraction fit:** `CapabilityIndex.ts` is the existing source of truth for both surfaced capability prefixes and internal-only prefixes, so the classification belongs there.
4. **Signal vs authority compliance:** the repair changes metadata used by a structural lint and `/capabilities` discovery. It does not introduce new blocking authority; the admission endpoint's deterministic authority is reviewed above.
5. **Interactions:** no route ordering or auth behavior changes. The only interaction is with `tests/unit/capabilities-discoverability.test.ts` and the `/capabilities` builder's shared registry.
6. **External surfaces:** `/capabilities` remains unchanged for users and agents because `/gate` stays internal. The HTTP route still exists and remains authenticated.
7. **Multi-machine posture:** classification metadata ships with code on every machine. There is no machine-local state and no replication concern.
8. **Rollback cost:** normal code revert of the single `INTERNAL_PREFIXES` entry. Reverting would restore the discoverability lint failure while leaving endpoint behavior unchanged.

## Release-workflow addendum - W27 gate history

This release is not being represented as a clean Zero-Failure certification. The real W27 workflow now required for release is:

- Two counted solo full-suite runs were recorded for the candidate lane, with terminal summaries preserved under `.instar/w27/deploy-evidence/candidate/`: `counting-full-suite.exit-summary.txt` and `counting-full-suite-rerun-20260826T0400Z.exit-summary.txt`.
- Failures from those counted runs were handled by per-failure classification instead of being ignored or averaged away. The first run's red items are classified in `.instar/w27/deploy-evidence/candidate/six-red-classification.md`; the rerun's red items are classified in `.instar/w27/deploy-evidence/candidate/rerun-red-classification.md`. Invalid listener-permission attempts are preserved only as invalid-attempt artifacts and are not used as proof.
- Three at-cause candidate fixes were made with focused proofs rather than broad exploratory repair: session spawn topic binding, scheduler live-state/job toggle behavior, and route-prefix capability classification. The focused proof files are named in the gate-three package and in this artifact's evidence pointers, including `tests/unit/session-spawn-topic-binding.test.ts`, `tests/unit/job-toggle-route-must-fail.test.ts`, `tests/integration/scheduler-live-state-lifecycle.test.ts`, and the capability-prefix repair proof.
- Gates one, two, and three passed before this release-gate attempt. Gate three included Observer 2 review, and the release package records the Observer 2 named-file confirmation for `src/server/sessionSpawnTopicBinding.ts`, `tests/unit/session-spawn-topic-binding.test.ts`, `tests/unit/job-toggle-route-must-fail.test.ts`, and `tests/integration/scheduler-live-state-lifecycle.test.ts`.
- After gate-three evidence assembly, the work gained the missing spec-write and convergence arc: `docs/specs/w27-between-window-admission-gate.md`, `docs/specs/w27-between-window-admission-gate.eli16.md`, and `docs/specs/reports/w27-between-window-admission-gate-convergence.md`. Convergence ran for three iterations and disclosed degraded external review rather than claiming external cross-model success.
- Operator approval is recorded in the spec frontmatter as adopted from the verified operator handoff: Telegram topic 36966, message row 58529, `2026-08-26T12:14:23Z`, text `Approved`. This release worker did not independently re-read that row from the local laptop store; the local store did not contain it.

This addendum does not add new technical behavior. It records the release evidence standard now attached to W27 so the side-effects artifact is honest about how the candidate reached release-gate readiness.

## Rebuild addendum - candidate rebuilt on the published head, Observer 2 final ruling repairs

The reviewed package above could not be committed onto the published repository: it had been carried as whole files out of a local branch whose history could never be pushed. The release therefore continued as a REBUILD — the isolated W27 delta re-applied three-way onto the published head `e6f6babf6` (v1.3.1203), re-reviewed by Observer 2 rather than transferring the earlier review. That rebuild is what this artifact now describes.

- **Observer 2 rebuild review (changes requested, then confirmed):** four ordered repairs, all applied and each pinned by a test that fails against the unfixed code — underscore-shaped lane/orchestrator/pathway session names now require topic binding exactly like hyphenated ones; script jobs save durable job state BEFORE recording terminal run-history (charter clause 1(c)) on both success and failure; a relay "sent" needs the destination store's confirmation (a holder 2xx without `destinationStoreConfirmed` is not a send); and the Gemini live-precondition hatch is dropped entirely in favour of the head's reviewed `tests/helpers/geminiEnvRefusal.ts` (the one-line `GOOGLE_CLOUD_PROJECT_ID` billing-env addition that the port worker had kept was dropped too, per Observer 2's order for a COMPLETE Gemini scope drop — it is out of this window's scope and can return through its own reviewed change).
- **Observer 2 final ruling (2026-08-27 06:34Z, topic 43003 row 59802) — three findings, all closed here:**
  - **A — scheduler disk-authoritative reload vs. two older tests.** `triggerJob()`/`processQueue()` re-read the job set from disk at every admission (charter 1(a)/(b)). `tests/unit/scheduler/per-machine-independent.test.ts` planted jobs in memory over an empty disk file; in-memory injection is not a promised API, so the fixture now writes the jobs to disk. `tests/unit/scheduler/JobScheduler.body-drift.test.ts` expected the last validated agentmd body to survive an unreadable/malformed file; the reload was instead dropping the job. Repair: the reload is disk-authoritative for the MANIFEST only; an enabled manifest whose body fails to load is rehydrated from the current manifest plus the last validated body (`rehydrateAgentMdJobFromLastValidatedBody`, driven by the loader's new `bodyFailures` list), and a body that loaded but changed keeps the previous body in the reload so `refreshAgentMdBodyIfChanged()` owns the validated swap + the once-per-change log. Live disable/removal is unchanged (`enabled` and existence still come from disk); a never-hydrated job stays dropped; and the fallback is bound to the path the CURRENT manifest resolves to (`expectedPath` on each `bodyFailures` entry) — an origin change on the same slug with a broken new body drops the job rather than running the old origin's file (Observer 2 re-review, Q2). Seven new tests in `JobScheduler.body-drift.test.ts`. Honest accounting of what they pin, per Observer 2's re-review: of the ORIGINAL FIVE, exactly TWO are genuine regression tests that fail against the unrepaired rebuilt candidate — loader audits not re-printed per trigger (the unrepaired reload is loud on every refresh) and a prose-only body edit not rebuilding the cron tasks (the unrepaired signature includes the body). The other three are INVARIANT tests that already pass against the unrepaired candidate's disk-authoritative reload and exist so the fallback can never weaken them: disable-with-broken-body refused (`gateReason: disabled`), manifest-removal refused (`job-missing`), never-hydrated refused. Separately, the two later ordered repairs added their own tests: the origin-change fallback-refusal test (ordered repair 1) pins the path-binding guard — note it PASSES against the unrepaired candidate too, by accident, because that code dropped every body-failed job outright; and the diagnostic appear-once/clear/recur test including a legacy validation problem (ordered repair 2) pins the transition-reporting semantics.
  - **B — write-domain declaration.** `POST /gate/between-window-admission` is pure (reads stores under `stateDir`, persists nothing) and now carries the `@write-domain:none` annotation; `tests/unit/write-domain-conformance-ratchet.test.ts` passes without touching the baseline.
  - **C — verification sequencing.** The regenerable builtin manifest is not committed; the build ran BEFORE the full suite so the manifest assertion sees a fresh artifact.
- **Reload noise (found while repairing A):** re-reading the job set at every trigger re-printed the loader's boot-time audits (grounding, deprecation, agentmd problems) on every admission. `loadJobsDetailed(file, { quiet })` keeps the first load loud and later reloads silent, and returns EVERY line the loader would have printed (`diagnostics`: missing jobs file, invalid/skipped legacy entries, legacy-shadowing, grounding audit, deprecation audit, agentmd problems); the scheduler reports each one once per transition (fingerprint level|line), reports it again if it clears and recurs, and never prints a body-class agentmd problem twice (the trigger-boundary warning already covers those, deduped by disk state). No diagnostic class is silently swallowed (Observer 2 re-review, Q4).
- **Base moved to the current published head.** The rebuild worktree on the laptop sat on v1.3.1203; the same 31-path delta (sha256-verified export of the laptop tree) applied three-way onto `origin/main` at v1.3.1206 (`c0dc5a4d5`) with zero conflicts on the Mac Studio, where this commit is made. `tsc`, the 48-check lint chain, the build, and the focused suites are green on that base; the full-suite result is recorded in the evidence pointers.
- **Acceptance bar (Observer 2):** "no ESTABLISHED new failure introduced", not "one full-suite run must be green" — the published head fails a handful of tests on its own on developer hardware (eleven on the laptop, eight of which pass on the candidate), so a one-run set difference is not causality. Any remaining red is attributed against a control run of the untouched published code before it is called a candidate defect.

## Second-pass review (if required)

**Reviewer:** Poincare
**Independent read of the artifact:** concern raised, resolved; re-check concurred

Concern raised: `evaluateBetweenWindowAdmission()` only required `fullHistoryReceipts.length >= 2` and did not enforce distinct observer identities, so two receipts from the same observer could satisfy the "both observers" admission requirement.

Resolution: `src/core/BetweenWindowAdmissionGate.ts` now requires the set of full-history receipts to include both `observer-1` and `observer-2`, and `tests/unit/between-window-admission-gate.test.ts` asserts that two receipts from `observer-1` refuse with `OBSERVER_RECEIPT_MISSING`.

Re-check concurrence: the gate now requires full-history receipts from both `observer-1` and `observer-2`, and the duplicate `observer-1` unit control covers the prior bypass without introducing a new blocker.

## Evidence pointers

- `.instar/w27/deploy-evidence/item0/focused-unit.log`
- `.instar/w27/deploy-evidence/item0/focused-integration.log`
- `.instar/w27/deploy-evidence/item0/focused-e2e.log`
- `.instar/w27/deploy-evidence/item0/build.log`
- `.instar/w27/deploy-evidence/item0/full-suite-node25-home-tmp.log`
- `.instar/w27/deploy-evidence/item0/repair-focused-unit-capabilities.log`
- `.instar/w27/deploy-evidence/item0/repair-full-suite-node25-home-tmp2.log`

## Class-Closure Declaration

**Class:** `unbounded-self-action` — **closure: guard** (citation: `tests/unit/scheduler/JobScheduler.body-drift.test.ts`, enforcement: ratchet).

This change adds no new self-triggered controller. The only repeated self-emission it introduces — loader-diagnostic reporting on the quiet per-admission reloads — settles by construction: the fingerprint (level|line) transition dedup reports each diagnostic once on appearance, stays silent while it stands, and reports once again only after clear-then-recur, so steady-state emission per standing diagnostic is O(1). The appear/clear/recur test pins that brake. Session-spawn topic binding and relay destination confirmation are subtractive authorities — they REFUSE spawns / refuse a false "sent" — and retry behavior remains owned by the existing bounded DeliveryRetryManager.
