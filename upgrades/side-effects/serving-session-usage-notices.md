# Side-Effects Review — Serving-session usage notices

Date: 2026-11-05. Author: Echo. Reviewer: diagnosis_review.

## Summary of the change
Tier 1, reversible repair of usage evidence and warning idempotency. Runtime changes are in StuckSignatureClassifier, rateLimitDetection, PresenceProxy, SessionManager and server wiring; the convergence model and regression tests accompany them. One review round; gate attempts and final size are recorded in the PR.

## Decision-point inventory
Modified limit evidence: raw parent-banner signal plus exact-session structured API error corroboration. Modified warning delivery: reserve one durable notice per topic and provider UUID before sending. Modified watch replacement: cancel old state and prohibit old cleanup/persistence against newer watches. Recovery authority is unchanged.

## 1. Over-block
An unknown, missing, partial or unreadable transcript cannot authorize an explicit limit warning. This may omit a valid warning for an unsupported provider/schema; ordinary standby monitoring continues. A failed or uncertain courtesy delivery retains its reservation, favoring no duplicates over retrying an ambiguous send. User messages are never blocked.

## 2. Under-block
The original historical pane is unavailable; helper attribution is independently reproduced rather than asserted as the sole historical cause. Tests cover helpers, prose, reset hints, stale banners with one line of later work, exact parent errors and both tier paths. No additional known warning cause remains in these paths.

## 3. Level-of-abstraction fit
Pane matching is a signal. Exact main-transcript error metadata supplies serving-session provenance rather than account-wide quota or another helper's state. Transport-level reservation handles identical episode delivery independently of tier wording. Existing recovery services keep authority over account moves and retries.

## 4. Signal vs authority compliance
Reference: [signal-vs-authority](../../docs/signal-vs-authority.md). No new action blocker or semantic message filter. This changes detector signals and transport idempotency. A provider-owned structured error and a topic/session identity are enumerable evidence, not a judgment that arbitrary prose means the parent is blocked.

## 4b. Judgment-point check
No new static heuristic at a competing-signals decision point. Main error provenance and one-send bookkeeping are mechanical invariants. No session lifecycle authority is added.

## 5. Interactions
All warning tiers use the same evidence predicate and durable claim. Claims precede awaits; old inbound watches are cancelled; persistence and cleanup compare state identity. Failed transport acknowledgement retains the claim. Existing recovery ownership and speaker election remain ahead of delivery. A serving reply alone can clear the claim; helper or stale-session replies cannot clear it.

## 6. External surfaces
Users receive fewer incorrect and repeated standby warnings. No new endpoints, operator actions, credentials, or URLs. Existing claims are tiny topic-scoped files. No operator-facing actions.

## 6b. Operator-surface quality
No operator surface — not applicable.

## 7. Multi-machine posture
Replicated through the existing WorkingSetManifest `<topic>.` convention carrier: autonomous/<topic>.usage-limit-notice.json follows topic transfer. Serving replies write a carried clear record so a returning topic also overwrites an old owner’s stale reservation. Existing speaker election selects the sole sending owner. Provider corroboration is machine-local BY DESIGN because each process has its own transcript/account home; no guessed peer evidence is used. No /status, /health, /capabilities or /channels answers change. No generated URLs. The lifecycle test verifies carrier nomination and suppression after copy to the next owner.

## 8. Rollback cost
Revert and ship a patch. No data migration. The tiny reservations may remain harmlessly on disk if reverted; no live agent repair or session restart is needed.

## Class-Closure Declaration
Defect class: unbounded-self-action. Closure: guard. Ratchet: tests/unit/self-action-convergence.test.ts, controller presence-usage-limit-notice in src/testing/selfActionRegistry.ts. Control edge: repeated tier checks to notify; steady-state bound is one attempt per topic/provider UUID, independent of ticks and restart. Settling brake is the durable pre-send claim, retained under ambiguous failure. Concrete runtime regression and transfer lifecycle tests additionally exercise the real component. No agent-authored prompt/hook defect is changed.

## Second-pass review
Concur with the review — diagnosis_review independently checked the artifact, runtime diff and three regression layers, including captured provider metadata, durable claims, transfer nomination and state identity guards. No remaining blocking concern identified.

## Current-main repair — 2026-11-06
Tier 1 reversible repair in a fresh isolated origin/main clone (main d1de939e5, package 1.3.1693); the original worktree metadata is sandbox read-only. Rebase preserved both profile-reconciliation and presence-notice convergence controllers. Restored the captured Claude connector banner as a signal, retaining exact-session transcript proof. Tier 1 now always preserves warning identity through final revalidation; disappearing proof cannot downgrade a usage warning to ordinary text. AI summary instructions reserve usage diagnoses for the verified path rather than making a semantic regex into blocking authority.

The two disappearing-proof race tests failed before repair and passed afterward. Targeted verification: 704 unit tests, 10 exact-session integration tests, 5 usage/rescue lifecycle tests. No over-block, under-block, rollback, external-action, or cross-machine posture change beyond the evidence safeguards already reviewed above. Full-suite verification remains required before merge. Repair size and commit/gate attempts are recorded in the PR.

Second-pass repair review: review_usage_fix — Concur with the review. Independently checked both Tier 1 paths, disappearing-evidence regressions, captured banner support, summary ownership guidance, and both convergence controllers. No remaining blocking concern identified.

The full-source silent-fallback ratchet reproduced 495 catches against its 494 ceiling. The added transcript parse catch now explicitly documents its intentional unknown-evidence result; no threshold was raised and no runtime behavior changed.

Blocking CI repair: documented the existing promise-review job in the jobs reference and evolution guide. Job coverage was 83% against the unchanged 85% floor; documenting its actual schedule, proof checks, gate and no-message behavior clears that floor. Documentation-only; no runtime or operator-action changes.
