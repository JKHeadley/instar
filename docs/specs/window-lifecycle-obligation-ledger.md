---
slug: window-lifecycle-obligation-ledger
parent-principle: "Structure beats Willpower"
approved: true
eli16-overview: window-lifecycle-obligation-ledger.eli16.md
review-convergence: "2026-08-28T16:40:09.586Z"
review-iterations: 3
review-completed-at: "2026-08-28T16:40:09.586Z"
review-report: "docs/specs/reports/window-lifecycle-obligation-ledger-convergence.md"
cross-model-review: "unavailable"
cross-model-review-reason: "outside-pipeline-no-external-review"
single-run-completable: true
frontloaded-decisions: 5
cheap-to-change-tags: 0
contested-then-cleared: 0
---
# Window Lifecycle State Machine + Executable Obligation Ledger

Status: CONVERGED — APPROVED BY OPERATOR. Justin, topic 36966, 2026-08-28 09:32 PDT: "perfect, yes approved" (verified operator uid 7812716706; approval given on the package at private view 11b0a5d6-62f4-4e24-8122-7430bfcd4a76, which carried this spec, the ELI16 companion, and the full review trail).  
Scope at approval: the approval green-lights BUILDING this spec under full instar-dev discipline. The build itself remains governed by that discipline (spec-converge tag, review, tests, gates) — approval of the spec is not approval of any shortcut past them.

## 1. Decision Summary

This candidate retains r2's content-dependent compiler, first-class Tenet 9 duties, strict state machine, cadence duties, authority classes, and Echo-only scope, and makes five binding corrections:

1. The shipped between-window gate remains a structural, local-store-presence preflight behind a versioned adapter. The ledger never calls its result semantic or authenticated proof.
2. Evidence authority is earned by binding/re-query verification, never by assigning a strong label to a local row.
3. Only the locally auth-bound verified operator can grant a payload-bound waiver, and core duties cannot be waived.
4. Every obligation has a duty-kind-appropriate executor proof at admission and throughout its lifetime: pending executable duties have a live future execution path, already-satisfied one-shots have durable completion evidence, and future-phase duties have an enabled owner/trigger and eligible-time schedule. Registration alone is never execution, and no pending duty may be silently ownerless.
5. No closed state is reachable until every compiled obligation instance has a terminal, permitted disposition and no `open-unexecuted` instance exists.

There are no implementation-choice open questions. The decisions above and below are normative.

## 2. Scope and Non-Leakage

- `agentId` is exactly `echo`; `scope` is exactly `echo-window-lifecycle`.
- State and flags live only under Echo's agent home.
- Every entry point rejects another agent/scope before reading or mutating ledger state.
- No templates, scaffold defaults, migrations, hooks, or fleet defaults are changed.
- Tests prove Codey/other-scope records are ignored and Echo rollback cannot affect another agent.

## 3. Content-Dependent Compilation

The compiler reads the complete current `.instar/TENETS.md` and active charter bytes, records SHA-256, byte length, byte/line spans, heading/list AST, extracted facts, and source authority, and compiles every operative duty into a stable obligation id. A read receipt or byte-exact recitation is necessary where required but never proves ingestion.

Compilation fails with `uncompiled-operative-duty` when any operative requirement, prohibition, phase duty, cadence, deadline, actor, evidence rule, or failure rule has no source-spanned obligation. Start challenges are derived from the loaded bytes, including the current Telegram profile/fingerprint, Pathway start date, reaffirmation phases, canonical plan id, cadence intervals, and charter expiry. Hard-coded stale answers fail after source mutation.

Required negative: add a new operative tenet to a fixture, provide a full-read receipt and byte-exact reaffirmation, run the old/static compiler, and prove admission refuses it. Mutation coverage includes `must`, `required`, `cannot`, and deadline/cadence forms.

## 4. Obligation Schema

Every obligation instance contains:

```json
{
  "id": "cadence.report.3h@2026-08-28T06:00:00Z",
  "agentId": "echo",
  "scope": "echo-window-lifecycle",
  "windowId": "w28",
  "sourceSpans": [],
  "statement": "Send the operator a high-level synthesis report",
  "phase": "cadence",
  "coreDuty": true,
  "waiverPolicy": "non-waivable",
  "responsibleRole": "observer-2",
  "deadline": { "dueAt": "...", "graceMs": 0 },
  "predicate": {},
  "evidencePolicy": {},
  "executorBinding": {},
  "failureAction": {},
  "status": "pending",
  "evidence": [],
  "lastEvaluatedAt": null
}
```

Allowed statuses are `pending`, `satisfied`, `failed`, `blocked`, `expired`, `open-unexecuted`, `waived-for-debt`, and `waived-for-phase-transition`. `unknown`, `pending`, and `open-unexecuted` never count as success.

## 5. Evidence Authority

Evidence records bind `agentId`, `scope`, `windowId`, obligation instance id, source hashes, producer, timestamp, evaluation nonce, native source coordinates, canonical payload hash, and verifier result.

Authority levels:

- `native-local-store-presence`: a row exists in the selected local JSONL store. This is exactly what the shipped admission gate can establish.
- `content-bound-store-row`: canonical receipt payload is bound to the referenced stored message text and digest recomputation passes.
- `live-requeried-message`: the message is independently fetched from the live topic and actor/provenance verification passes.
- `replicated-export`: independently replicated source with topic offsets and integrity proof.
- `verified-operator-approval`: the locally auth-bound operator affirmatively approved the exact canonical waiver payload digest after it was created.
- `runtime-registry-proof`: live process/job/run identity plus fresh lease/heartbeat and configuration snapshot.
- `deterministic-replay`: hashed complete inputs, expected transitions, actual transitions, and reasons.

A local row, receipt JSON, arbitrary hash-shaped string, agent assertion, or gate pass cannot be promoted to a stronger class. User-visible delivery, semantic ingestion, and waivers require their specified stronger verifier. Vanished or unbound evidence is `unknown`. Evidence/waiver nonces are single-use; wrong-window or replayed evidence is rejected.

## 6. Real Admission-Gate Adapter

The required native implementation is the shipped `BetweenWindowAdmissionGate` contract at commit/version `76bc93c3d` or a later explicitly compatible version. If the running/installed evaluator is absent or incompatible, admission blocks; no local lookalike substitutes for it.

The adapter constructs the native package exactly:

- `fullHistoryReceipts`: observer-1 and observer-2 entries, each pointing to topic `43003`, with native nested fields `historyScope`, `canonicalSource`, `canonicalStore`, `dateSpan`, `population`, `extractionContract.rule`, `dedupeContract.rule`, `semanticAuthorArtifact`, format-valid `corpusHash`, non-empty `quotes`, `assessment`, and `storedMessageIds`;
- `tenetReaffirmationReceipts`: native start/middle/end entries with topic/message ids, string-valued `canonicalStore`/`store`, and format-valid corpus/text hash;
- `knownCorpusMismatches` (or native alias): both exact required mismatch records.

The adapter calls `evaluateBetweenWindowAdmission({ stateDir, package, storePath? })`. HTTP use is bound to the server's local `<stateDir>/telegram-messages.jsonl`; a selected alternate store requires the evaluator/CLI override on the machine that can read it.

The ledger durably stores the exact native input bytes/hash, adapter mapping from native fields to ledger evidence ids, selected store path/identity/hash, evaluator version/commit, exact `{ admitted, issues, checked, corpusMismatches }` output, time, and nonce. This durable wrapper is lifecycle evidence; it is not falsely attributed to the native evaluator, which writes no state.

Native `admitted: true` satisfies only `preground.native-structural-preflight`. All semantic, authenticity, visible-discussion, disagreement, combined-recommendation, and source-ingestion predicates run separately against stronger evidence. Native refusal blocks. A refusal involving a core duty is non-waivable.

## 7. Compiled Duties

The minimum source-spanned set is:

- Pre-start: both observers' complete Pathway reread from July 25 focused on Justin; both observers' complete Observer-1-topic reread; two independent assessments created before reconciliation; both assessments discussed visibly in Observer 2 topic; unresolved disagreements visibly shown to Justin or proven absent after reconciliation; combined recommendation; native structural preflight.
- Start: source ingestion; compilation coverage/challenges; byte-exact beginning reaffirmation; canonical private-plan input with current node and leaf-to-root placement; named worker lanes; orchestrator-majority boundary; intended both-machine/multiple-Codey distribution or named blocker; 3-hour report cadence; 30-minute stall cadence; charter expiry/backstop precedence; executor liveness for every compiled duty.
- Continuous/cadence: Telegram path classification, `justin-telegram` profile, Echo signature verification and never-act-as-Justin guard; per-interval all-session stall checks; 3-hour synthesis delivery; visible observer coordination; evidence-derived counts; save-before-words; high-level goal tie; 80/20; scope drift; periodic executor-liveness sweep.
- Mid: byte-exact middle reaffirmation; plan position; every lane status; cadence health; source challenge refresh; executor inventory/liveness.
- Close/post-live: honest expiry; byte-exact end reaffirmation; canonical-plan semantic outcome diff and staleness guard; consumer proof; deterministic/real post-live pass; named debt; no completion claim without landed effect; complete terminal-disposition census.

Each compiled duty has its own deterministic predicate, authority threshold, role, deadline/grace, waiver policy, executor binding, and concrete failure action. Omission gets a negative test.

## 8. Executor-Liveness Invariant

Registration proves intent, not execution. Every obligation—including one-shot, continuous, cadence, and close duties—must have exactly one applicable executor class at each evaluation. Classification is deterministic from the duty's compiled phase, eligibility time, status, and evidence policy; an implementation cannot select a weaker class to avoid a failed predicate. The classes are mutually exclusive:

1. `pending-executable`: the duty is pending and eligible now or before its next required deadline. It requires a live future execution path.
2. `completed-one-shot`: the non-recurring duty is already satisfied. It requires durable completion evidence and does not require a still-running process or future attempt.
3. `future-phase`: the duty is not yet eligible because its compiled phase or eligible time has not arrived. It requires an enabled trigger and explicit owner now, plus a schedule that will make the duty eligible early enough to meet its deadline; it does not require a process to be running before eligibility.

An executor binding names the class, executor kind/id, explicit owner, registry/store coordinates, enabled/dry-run state where applicable, trigger and eligibility schedule where applicable, deadline/grace, and last successful comparable execution when applicable. It also names lease/heartbeat, delivery sink/path, suppression policy, fallback executor, and client-side driver/marker only when the bound executor kind depends on those facilities. Omitted inapplicable fields are recorded as `not-applicable` with the executor-kind rule that justifies omission; they are never fabricated merely to pass evaluation.

The predicates are:

- `executor.pendingExecutable` passes only when the real runtime registry explicitly assigns the instance to an enabled, non-dry-run executor; the owning process/job/run is running with a fresh duty-specific lease/heartbeat; and its next attempt is scheduled before the deadline plus grace. If that executor kind delivers output, its sink/path must be reachable and enabled and suppression cannot swallow execution. If that executor kind depends on a client-side autonomous-run driver, the driver/marker/state must exist, parse, match topic/window, and correspond to the live registered run. A fallback counts only if it satisfies the same applicable conditions and deadline. An observer of the same commitment cannot be double-claimed as its executor.
- `executor.completedOneShot` passes only when durable, instance-bound completion evidence meets the duty's authority threshold, predicate, source hashes, and nonce/replay rules and the ledger status is `satisfied`. A live executor, registration, heartbeat, or scheduled retry without that completion evidence cannot pass it.
- `executor.futurePhase` passes only when the real registry explicitly assigns the instance to an enabled owner and enabled phase/time trigger, the trigger's eligible-time schedule precedes the deadline plus grace, and the trigger has durable configuration/state sufficient to enqueue or invoke the duty at eligibility. Sink, suppression, lease/heartbeat, running-process, and driver conditions apply only if the trigger executor kind actually uses them before eligibility. On eligibility the instance must atomically reclassify to `pending-executable`; failure to do so creates `open-unexecuted`.

Duty-kind applicability is exhaustive for the Section 7 compiled set:

| Section 7 compiled duty kind | Executor class at evaluation | Satisfiable predicate |
| --- | --- | --- |
| Pre-start rereads, independent assessments, visible discussion/disagreement handling, combined recommendation, and native structural preflight | `completed-one-shot` when presented as satisfied for admission; otherwise `pending-executable` | Durable duty-specific evidence for completed work; otherwise a live assigned worker/evaluator path, with sink checks only for visible-delivery duties and driver checks only for autonomous-run workers |
| Start source ingestion, compilation coverage/challenges, beginning reaffirmation, private-plan input, worker/distribution declarations or blocker, orchestrator boundary, cadence installation, charter expiry/backstop precedence, and the admission executor inventory | `completed-one-shot` when presented as satisfied; otherwise `pending-executable` | Durable predicate evidence for completed setup; otherwise a live assigned compiler/evaluator/worker path, with only its actual dependencies applied |
| Eligible continuous checks and each due 30-minute or 3-hour cadence instance, including path/profile/signature/principal guards, stall checks, synthesis delivery, coordination, count derivation, save-before-words, goal tie, 80/20, scope drift, and executor sweep | `pending-executable` | Live assigned executor and timely next attempt; sink/suppression required only for duties that deliver or coordinate visibly, and driver required only for client-driven autonomous execution |
| Mid reaffirmation, plan position, lane status, cadence health, challenge refresh, and executor inventory before the mid phase is eligible | `future-phase` | Enabled mid-phase trigger/owner and eligible-time schedule; atomically becomes `pending-executable` at eligibility |
| Close/post-live expiry truth, end reaffirmation, semantic outcome diff/staleness guard, consumer proof, post-live pass, named debt, landed-effect claim guard, and terminal census before close/post-live eligibility | `future-phase` | Enabled close/post-live trigger/owner and eligible-time schedule; atomically becomes `pending-executable` at eligibility |
| Any non-recurring mid or close/post-live duty after its predicate has been satisfied | `completed-one-shot` | Durable instance-bound completion evidence; no running-process, sink, or future-attempt fiction |

Thus every Section 7 duty maps to exactly one class at a given evaluation, although a duty may transition `future-phase -> pending-executable -> completed-one-shot` as eligibility and completion occur. Continuous duties and each cadence interval remain distinct pending-executable instances until disposition. The universal invariant is that no pending duty is silently ownerless: a pending instance without an explicit applicable owner/executor, or with a failed applicable predicate, becomes `open-unexecuted` immediately.

Checks run at admission, on phase/eligibility/status/evidence/executor/config/ownership change, periodically while active, before each deadline, after a missed tick, and at close. Applicable-predicate failure creates `open-unexecuted` immediately. At pre-start it blocks admission; while active it blocks new scope and escalates; at close it blocks every closed state. A later executor recovery does not erase the missed instance; that instance needs explicit failure/debt disposition.

Required incident test: model the overnight 2026-08-28 3-hour operator-report duty as `pending-executable`, with a durable commitment present, PromiseBeacon output suppressed by quiet hours or disabled user output, check-in reminder reconciler in `dryRun`, and the topic's client-side autonomous-run driver file absent. Assert `executor.pendingExecutable = fail`, status `open-unexecuted`, admission refused, and no active/closed claim. Individually flip each apparent executor to prove no single non-executing signal passes; then supply one real non-dry-run, unsuppressed, heartbeat-fresh executor with its required driver and sink proof and assert the applicable predicate passes.

## 9. Lifecycle

States: `idle`, `pre_start_gate`, `start_blocked`, `active_start`, `active_mid_due`, `active_mid_blocked`, `active_mid_satisfied`, `close_due`, `close_blocked`, `delivered_pending_post_live`, `closed_clean`, `closed_with_operator_waiver`, `rolled_back`.

- `pre_start_gate -> active_start` requires every pre-start/start core predicate, native preflight, and every executor-liveness predicate to pass. Allowed non-core debt must be explicitly registered.
- Each cadence interval is a distinct obligation instance. A later pass cannot erase a skipped interval.
- A continuous or executor failure applies its per-duty action immediately and prevents silent progress.
- `delivered_pending_post_live` is non-final and cannot be called closed.
- Post-live fail/blocked/missing goes to `close_blocked`; pass may proceed.
- `closed_clean` requires: all compiled instances enumerated; all non-waived instances `satisfied`; no `pending`, `unknown`, `open-unexecuted`, failed core, missing executor, or unresolved post-live item; and no phase waiver.
- `closed_with_operator_waiver` requires the same complete census plus valid waivers only for explicitly phase-waivable non-core failures. It must always be reported with the full phrase “closed with operator waiver.”

## 10. Waivers

The sole waiver principal is the operator identity proven by this agent's local authentication binding. A username string, topic membership, message id alone, agent-authored row, forwarded approval, or another agent's assertion is insufficient.

A waiver contains a canonical payload with id, exact obligation instance ids (no wildcard/family/range), reason, Echo/window/phase scope, permit type, expiry, single-use nonce, non-transferability, creation time, and payload digest. After creation, the verified operator must affirmatively approve that exact digest. Verification stores the auth-bound principal id and re-queried approval coordinates.

Non-waivable: source authority/ingestion, compilation coverage, all Tenet 9 duties, all reaffirmations, never-act-as-principal guard, executor liveness, expiry truth, canonical-plan semantic output, consumer existence, complete obligation census, and honest debt. Native refusal arising from one of these cannot be bypassed.

Debt-only permission never changes phase. Phase-transition permission applies only to named non-core duties whose compiled `waiverPolicy` allows it and leads only to `closed_with_operator_waiver`, never `closed_clean`. Expired, replayed, pre-approved, cross-window, cross-agent, delegated, or overbroad waivers fail.

## 11. Failure Actions

- Pre-start missing/fail/unknown/open-unexecuted: block start.
- Mid/cadence executor or proof failure: block new scope, surface observer-visible escalation, retain the failed interval.
- Unsigned/wrong-profile/principal-risk send: block the send path; principal-risk is non-waivable.
- Invisible coordination: repost visibly before it can be evidence.
- Invented count: derive and correct before report delivery.
- Save-before-words: block completion language until artifact exists.
- 80/20 or scope drift: operator-visible scope/timebox review before continuation.
- Close proof, census, executor, or post-live failure: `close_blocked`; never ordinary closure.

## 12. Required Verification

All three implementation test tiers are required. At minimum:

- one omission/failure-action negative per compiled duty;
- stale compiler and source-fact mutation negatives;
- every Tenet 9 step independently omitted;
- native adapter contract fixture using the real package/result shapes, plus wrong topic, absent row, malformed store, mismatch omission, and incompatible evaluator tests;
- proof that native admission does not satisfy semantic/authenticity predicates;
- receipt fabrication/unrelated-row/hash-format-only attacks;
- waiver attacks: unbound message, wrong principal, pre-approval, altered digest, wildcard, replay, expiry, wrong scope, and core-duty attempt;
- skipped 30-minute interval, missing worker, and unavailable machine without blocker;
- metadata-only/wrong-node/charter-omitting plan updates;
- vanished local-only evidence becomes `unknown`;
- post-live failure cannot reach `closed_clean`;
- closure census rejects omitted, pending, and `open-unexecuted` instances;
- the complete 2026-08-28 executor-liveness incident test from Section 8;
- executor-class applicability tests prove every Section 7 duty resolves to exactly one class at each evaluation and that class transitions are only `future-phase -> pending-executable -> completed-one-shot` where applicable;
- a `pending-executable` duty with registration but no running, heartbeat-fresh, timely executor fails, while internal executors are not failed for an inapplicable sink or client-driver field;
- a `completed-one-shot` duty with a live executor and future attempt but without durable instance-bound completion evidence fails; the same duty with valid durable completion evidence does not fail merely because no process remains running;
- a `future-phase` duty with an enabled owner/trigger and eligible-time schedule does not fail merely for lacking a running process, while one with no owner, disabled trigger, or schedule after its deadline fails; failure to reclassify it at eligibility creates `open-unexecuted`;
- Echo-only/non-leakage and rollback tests;
- a live local dry run where a deliberately skipped duty is blocked with its predicate and executor reason.

## 13. Rollback

Rollback is Echo-local, reversible, audited, and preserves the ledger. It records operator evidence, reason, time, window, and scope; leaves read-only audit on when safe; and falls back to the manual ritual while explicitly reporting enforcement disabled. It never authorizes false closure or changes another agent. Re-enable only after the fault is fixed and the dry-run suite passes.

## 14. Convergence Finding Dispositions

- SEC-1: resolved by Sections 5-6; native row presence is explicitly weak, and strong evidence requires binding/re-query verification.
- SEC-2: resolved by Section 10; verified local operator binding, exact post-created payload digest approval, strict reach, and no core bypass.
- INT-1: resolved by Section 6; exact native package/result/store contract is adapted and persisted without inventing native evidence ids or durability.
- INT-2: resolved by Section 8; every duty requires its applicable executor-class proof, pending executable duties require a live execution path, and registration alone cannot satisfy either requirement.
- SEM-2: resolved by Sections 8-9 and 12; `open-unexecuted` blocks admission/closure and the real overnight incident is mandatory.
- NEW-1: resolved by Sections 8 and 12; mutually exclusive duty-kind predicates require live future execution only for pending executable duties, durable completion evidence for satisfied one-shots, and enabled owner/trigger plus eligible-time scheduling for future-phase duties, with sink/driver checks limited to dependent executor kinds and no pending duty permitted to remain silently ownerless.

Advisory dispositions: SEC-3 is absorbed by scoped nonces and replay rejection; INT-3 by version/availability refusal; SEM-1 by expanded normative mutation tests; DEC-1 by the binding decisions in Sections 1, 6, 8, and 10.

## Decision points touched

- **Source-line classification — invariant.** The compiler classifies explicitly enumerated normative forms (`must`, `required`, `cannot`, prohibitions, deadlines, and cadence language). These forms are structural source facts; unknown operative forms fail coverage rather than being guessed.
- **Evidence sufficiency — invariant.** Authority ordering, binding coordinates, source hashes, nonces, and verifier results are enumerable. A weak local row cannot be promoted by judgment.
- **Executor-class selection and liveness — invariant.** Status, recurrence, phase eligibility, runtime assignment, heartbeat freshness, scheduling, sink/driver applicability, and trigger state deterministically select and evaluate exactly one class. The evaluator does not weigh competing signals.
- **Admission, lifecycle transition, closure, and waiver reach — invariant.** The permitted state graph, terminal census, core-duty floor, exact payload digest, bound operator principal, expiry, and replay rules are closed policy sets. Failure blocks at the phase specified by the obligation.
- **Semantic assessment content — judgment-candidate outside this authority.** Human/LLM assessments, reconciled disagreements, high-level synthesis quality, 80/20 judgment, and scope-drift judgment must be produced by their named contextual authorities. This ledger only verifies that the required authority supplied bound evidence; it does not replace those judgments with heuristics.

## Maturation plan

- **test-agent-live:** Run the complete compiler, admission, executor-class, closure, waiver, persistence, and rollback suites against temporary Echo-home fixtures, including the full 2026-08-28 missed-report lifecycle. A deliberately skipped duty must produce its predicate/executor reasons and block.
- **dev-agent-live:** Enable only for Echo and `echo-window-lifecycle`, beginning in dry-run against a synthetic window before applying it to the next real Echo window. Compare every would-block result to source spans, native-gate output, runtime registry state, and the named authority evidence.
- **graduation criterion:** Echo-local enforcement may replace dry-run after one complete synthetic lifecycle and one complete real-window shadow lifecycle produce zero false admission/closure passes, zero false blocks, complete obligation census, and at least one controlled omitted-duty negative that blocks for the expected reason.
- **fleet:** Prohibited by the approved scope. This is a permanently Echo-specific Window 28 control; no template, scaffold, migration, hook, default, or other-agent flag may carry it. Any fleet proposal requires a new converged and operator-approved spec.
- **dark-window:** Echo dry-run is bounded to the next complete real-window shadow lifecycle or 14 days after merge, whichever comes first. Failure to meet graduation criteria leaves enforcement disabled, preserves audit state, and requires a named operator-visible fault rather than silent darkness.

## 15. Acceptance

This candidate is ready for operator review when implementation can demonstrate all Section 12 tests against the real installed gate and runtime stores. Specification convergence does not itself claim implementation, admission, or window closure.
