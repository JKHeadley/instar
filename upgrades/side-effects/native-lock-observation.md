# Side-effects review — bounded native lock observation

Date: 2026-11-17. Tier 2: instrumentation in the native safety path, under the approved/review-converged docs/specs/desktop-locked-screen.md. Parent independently concurred with the bounded actor-history design before implementation. No constitution or authority change. Dependency: human-step commits a86cd8eb4, 9b9728d1d and reviewed cue correction 91986b84a, integrated by fast-forward; guard-ack branch is not included. No push by implementer; normal commit uses the installed hooks after final checks. Final independent combined code review concurred (/root/lock_call_measurement_design, relayed by parent); the separate E2E isolation correction also received concurrence.

## Summary and proportion

One host ledger, one small Swift observation block, a strict proof validator and wiring, awareness, and focused three-tier tests. 22 files including test/artifact files. The native source remains one common file; the existing build and source-hash recipe already cover it. Two design findings led to the positive actor ledger; missing evidence was never accepted as zero. No full suite, integration config or E2E config was run locally; Local Verify owns those.

## 1. Over-block

The proof refuses unknown baseline actors, unreadable process rows, missing either server, invalid identities, extra spawn attempts, replacement, history discontinuity, missing native witnesses and missing exact child exit. It accepts only one fresh request's one guard. These conservative failures affect measurement, not production admission or relock dispatch. A known pre-baseline child must already have a positive exit. Unknown orphan actors require trusted clean setup; an empty process scan cannot erase them.

## 2. Under-block

The bounded histories cover starts from the common MacDesktopHost funnel on the two verified proof servers. They are not an OS-wide audit or malicious-user boundary. --isolated-guard-population is an explicit trusted setup assertion, not proof of absence of other authorities. Strict listener/PID/start, store hash, native attempt identity and baseline actor checks still apply. Missing initialization/overflow/emergency/kill evidence cannot become a zero. The judge recomputes structured evidence rather than trusting extra.lockCalls supplied by a driver.

## 3. Layer fit

Host observation records intent synchronously before spawn without I/O. Its lifetime cap is 128 with no eviction/reset; callback updates preserve exact-child exit. Failures mark observation incomplete while existing spawn still proceeds. Swift counts once immediately before the actual direct dispatch or fallback pair. No observer filesystem, socket, wait, retry or policy call occurs in lockNow. Existing watch/terminal store writes carry the witnesses. Normal terminal transitions immediately exit; emergency dispatch has no successful terminal witness. Safety decisions remain unchanged.

## 4. Signal versus authority

These are diagnostic facts and deterministic proof predicates. No observation grants control, cancels input, kills a guard or prevents relocking. Unknown diagnostics remain unknown. The proof's own setup/action gates keep an invalid experiment from issuing human cues; they do not become production authorization.

## 5. Interactions and failure handling

Node restart changes instance identity and invalidates the finite proof. Lost observer state does not attempt disk recovery. Overflow is sticky for that host lifetime; a fresh owner-managed lifecycle is needed for another complete measurement. No automatic restart is added. Native registration failure/emergency action leaves a recorded spawn intent with no clean seal. A guard taking over the marker cannot inherit another attempt's final witness. The minimal proof rejects multiple generations rather than storing an unbounded native history.

The protected interval ends after the observed human return. Both A+B final reads occur after that point. Sequential reads therefore cover the finite completed interval, not all future activity. Logout can kill the guard or a proof server; that case remains unmeasured. The stored positive watch checkpoint is captured before logout; the later login cue does not require that exited guard to be alive again. Fresh population validity is still required before cues/actions.

## 6. External surfaces

GET /desktop/locked/status gains read-only guardObservation and observedLoginSession. Existing authentication applies; pool status carries each peer's own instance, never a merged authority. Histories contain request/attempt identifiers, PID, fixed states and a hash of the store path, not passwords, tokens or arbitrary error text. Memory and response size remain bounded. No production Mac was installed, restarted, locked, unlocked or granted permission by this task.

## 6b. Operator surface

No product UI change. Agent awareness explains the diagnostics without claiming readiness. The proof CLI documents isolation as a setup prerequisite. Updating the common native source changes its source hash and triggers the existing helper-retention/permission workflow; do not call that an ordinary readiness flicker. Owner-managed rollout and hardware proof remain separate.

## 7. Multi-machine and migration parity

Each server has its own in-memory ledger, even on the same Mac. A+B are read independently and both are mandatory; there is no fallback to whichever responds. No ledger replicates across machines or persists across server boots. The existing remoteDesktopBullet awareness is updated. PostUpdateMigrator.migrateClaudeMd already replaces that exact generated bullet when it differs (lines 9939–9946), so existing agents receive the change idempotently without a new migration.

## 8. Rollback

Revert the source change through the normal reviewed release path. No persistent ledger or new store schema requires deletion: old marker dictionaries tolerate extra observation fields. Rebuild/sign the common native helper through the owner-managed rollout; source identity and permissions must be revalidated. A running old native process does not change in place. Proof with a mixed helper/source identity must not be certified. No runtime toggle or safety weakening is introduced for rollback.

## Verification and limitations

Real Swift compilation/execution uses the exact production observation block with inert OS-dispatch doubles, including direct/fallback/no-method, overflow, invalid initialization, clean final witness and abrupt death without final seal. A full helper typecheck uses the macOS 14 deployment target; no real helper execution. Unit tests also exercise real inert child spawning/exit through MacDesktopHost, observer failure without blocking dispatch, actual combined runCase switch/logout timelines, strict malformed/extra/missing evidence, and wiring. HTTP integration and production AgentServer lifecycle tests are authored for Local Verify with inert binaries. Independent review found that post-boot substitution was too late: the new fixture now installs temporary homedir and inert binary selection before construction, explicitly disables retention, rejects access to the real desktop-helper store, asserts both controller/host roots, and waits for boot-sweep settlement before restoring mocks. A targeted unit validates this isolation with real-helper opt-in enabled; the E2E config is not run locally. Live hardware proof and full-suite acceptance are outstanding owner-controlled steps.

## Class-Closure Declaration

Defect class: `unbounded-self-action`. Closure: `guard`. Enforcement: `ratchet`. Citation: `tests/unit/self-action-convergence.test.ts`, existing `desktop-relock-guard-replacement` model. The durable maximum of three replacements settles the unchanged controller under sustained pressure. This change adds no self-action trigger or retry; observer capacity is not a safety-action brake.

This fixes the concrete absence-of-observation proof gap. It does not claim an exhaustive OS process audit or solve abruptly killed guards without witnesses. No prompt/hook/constitution defect is bundled.

## Final reviewer concurrence

The independent combined reviewer concurred with the native ledger/witness/proof dataflow and the safety fixture correction. Reviewed human cue fixes and current main are integrated through8a5204ad8 (main merge7a9fa5199) (main0a7724de4, package1.3.1885). No acceptance constraint was relaxed during integration. Common-helper rollout and permission validation remain explicit owner-managed risks.

Final precommit validation:155 targeted tests plus802 fast guards across30 files passed, each invocation at most five files. Two catches that already published sticky incomplete status received explanatory ratchet annotations; no behavior change or baseline increase. The subsequent human release-note-only followup was integrated separately and its release guard rechecked.

The first normal commit attempt passed54 lint checks and stopped at the required self-action declaration. The trace now cites the existing desktop-relock-guard-replacement convergence model: the durable three-replacement brake is unchanged. Observation introduces no trigger, retry or producer; its128-entry memory cap is not claimed as a safety-action brake. The existing registered convergence ratchet is cited; no new controller model or loop was introduced. An optional filtered model invocation queued in the suite lane and was stopped before execution, so no additional model pass is claimed. The authorized155 targeted and802 guard results remain the validation evidence. No bypass is used.

The second normal attempt required omitting an empty optional relatedPrs array from causalAutopsy; no related PR is asserted without evidence. The third normal attempt uses the corrected trace schema. Both earlier attempts passed all54 lint checks and stopped at artifact validation, with no runtime-code change or bypass.

Proportion update: three normal commit attempts passed54 lint checks but stopped at trace declarations/schema/hash validation. The third exposed that appending these notes after writing the trace changed the artifact hash. The artifact is now frozen before regenerating a fresh trace and carrying forward the validated class-closure/autopsy fields. These were gate-record corrections, not new code failures or additional design-review rounds.

The artifact-only preflight also required this exact class declaration in the human-readable mirror; it is now aligned with the trace. The bytes are frozen before final trace generation.
