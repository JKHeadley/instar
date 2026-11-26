# Failure-callout process — side-effects review

## Summary of the change

Tier 2: shared durable evidence, authenticated endpoints and replicated continuity. The previous session's uncommitted draft was reviewed against the entire topic and the source messages for group setup, the locked-screen claim and the false review request. The implementation extends CorrectionLedger; it creates no second bug queue. Build origin: fresh clone of origin/main bc4355b8 (1.3.1683), with Echo commit identity; shared Git metadata was outside the writable sandbox. The original checkout remains untouched. Proportion: the scope grew to include default-on failure-only activation, lossless history, existing-journal replication and a durable pre-spawn admission brake because review found those necessary for an honest every-agent process. Review rounds and gate attempts are recorded in the convergence report and build summary.

## Decision-point inventory

- Semantic severity — modified distillation signal, never outbound permission authority.
- Default capture versus preference opt-in — added explicit independent configuration invariants.
- Constitution/enforcement diagnosis — investigator judgment against evidence; constitution amendments remain proposals.
- Evidence closure — mechanical completeness, implemented fix, passing receipts and CAS invariants.
- Peer admission — existing authenticated registered-peer transport, new origin-bound chunk schema and complete snapshot validation.
- Investigation admission — durable attempts before model launch, backoff and a hard per-occurrence breaker, evidence-only explicit resume.

## 1. Over-block

No new semantic block/allow surface on user messages. Incomplete context, lost evidence, missing failing reply, unimplemented repair, stale versions and failed/missing replay outcomes are deliberately refused at case verification. Legitimate missing credentials/approval remain allowed by the unchanged outbound authority. Failure opt-out refuses new forensic context; historical evidence remains readable. Paused investigations stay unresolved and visible rather than falsely verified.

## 2. Under-block

Receipts are agent-reported references; the API does not execute tests or authenticate the truth of every claim. The investigator must actually perform the original scenario, paraphrase and allowed case. Existing detection/provider availability still determines which messages are distilled. The process does not claim to repair every founding incident or make existing advisories non-overridable. Explicit transport opt-outs and holders without a complete copy remain visibly unknown.

## 3. Level-of-abstraction fit

The existing correction ledger owns capture and lifecycle; its additive episode/admission tables hold chronology and resource state. The existing journal owns replicated evidence transport, the existing scheduler owns session execution, and the existing feedback/action surfaces own product repairs. Echo's intake topics stay local. There is no parallel outbound judge or new generic incident service.

## 4. Signal vs authority compliance

Reference: [signal-vs-authority](../../docs/signal-vs-authority.md). Severity and diagnosis are context-backed judgments. Mechanical admission/closure checks enforce enumerable evidence and resource contracts. The existing outbound authority and tone prompt are unchanged. No brittle keyword detector gains blocking power.

## 4b. Judgment-point check

Severity and diagnosis are judgment candidates with existing signal admission and governing standards as floors. CAS, schema bounds, explicit configuration, attempt caps, sender identity and digest completeness are invariants. No new static heuristic chooses among conflicting user permissions or replaces a semantic authority.

## 5. Interactions

Failure state remains separate from preference recurrence and class-review proposal lifecycle. The default ledger does not enable preference analysis. Context changes invalidate diagnosis/verification; unchanged progress may touch an existing diagnosis without resetting admission. New occurrences archive and reopen. Claims increment version so a concurrent closure rereads. Gates reserve before model launch and never retry uncertain writes. Canonical routing binds home/port/state. Pending receipts survive capacity queuing, are authenticated against the current origin token, expire after 30 minutes without refund, and are serialized per slug. Consumption must persist before launch; only confirmed pre-session failure restores a batch; per-machine-independent scheduling prevents a later global job claim from discarding another machine's valid reservation. Existing role/runtime admission still applies. Resource admission survives process restart and ordinary context changes. Chunk reconciliation emits changed/missing immutable records only; default implicit transport accepts only the failure kind, preserving session/placement activation.

## 6. External surfaces

Authenticated detail and history endpoints expose bounded, scrubbed forensic evidence; broad summaries omit conversation and admission tokens/evidence references. Ordinary correction records retain no conversation, although the existing bounded pre-distillation candidate backlog can temporarily hold scrubbed excerpts under capacity pressure until its TTL/drain. Context and diagnosis bounds carry explicit loss markers; verification cannot silently accept truncated evidence. Full prior revisions remain in the ledger and replicate incrementally. One stalled attention item uses the existing calm health lane after the third admission; no new notification topic or operator chore is added. No payment, group creation, real user send or constitution change is performed by tests.

## 6b. Operator-surface quality

No dashboard renderer/form is added. The only notice uses plain language and asks the person for no setup work. Cases remain agent-owned; constitution proposals follow the existing phone-completable ratification surface. There is no new API-only human approval action.

## 7. Multi-machine posture

Replicated: failureCallout records and immutable episodes use the existing authenticated coherence journal and peer streams, split below the 80 KiB entry cap and assembled only with complete matching version/digest/origin. Inner origin must match the authenticated first-hop sender; live dropped-origin filtering honors rollback. Proxied current reads and writes route by machineId; complete offline copies are explicitly stale/read-only and cannot authorize closure or new attempts. Unknown holders remain unknown in coverage. Default transport activates only failure evidence when otherwise implicit; explicit transport/store/feature opt-outs win. The originating ledger remains the sole CAS/admission writer. The one-time notice is emitted by that singular admission and existing delivery owns one-voice behavior. No generated URLs or new status/health/capabilities verdicts are introduced.

## 8. Rollback cost

Revert code/templates and disable the job through its existing schedule manifest. Older SQLite readers ignore the additive columns/tables. No deletion migration is required; durable evidence remains intact. Drop-origin rollback immediately removes that origin's replicated evidence from read surfaces. No credential replication or outside-service change is required.

## Class-Closure Declaration (display-only mirror)

`defectClass: unbounded-self-action`, `closure: guard`, `guardEvidence: { enforcementType: ratchet, citation: tests/unit/self-action-convergence.test.ts, howCaught: The failure-callout-investigation registry entry uses the production admission decision and durable state. Unchanged pressure admits at most three attempts across longer horizons and restart, with 30-minute/one-hour delays and a hard pause. The real SQLite reconstruction test in tests/unit/failure-investigation-admission.test.ts proves the same bound. Only a new occurrence or an explicit previously-unused recorded evidence reference rearms it. }`

## Second-pass review

Correctness, integration/security and lessons reviewers independently identified and drove fixes for default-off activation, pool ownership, incomplete closure, early diagnosis, truncation, historical deletion, offline continuity, inner-origin spoofing, dropped-origin rollback, metadata leakage and unbounded repeated investigation. Final independent correctness and integration reads concurred with this design; subsequent gate-handoff review corrected capacity retry/consumption/opt-out edges, now covered by real scheduler and script tests. Actual test receipts are recorded in the convergence report; no unavailable model replay is presented as a pass.

## Current-main repair — 2026-11-06

Rebased from current main d1de939e (v1.3.1693) in a fresh isolated clone because
the shared worktree git directory is read-only in this session. Both main's
notification imports and self-action controllers survive alongside the callout
controller. The repair adds the missing POST correction write-domain declaration,
removes the now-classified analyzer from the shrinking inventory, makes fully-off
test fixtures explicitly disable both independent features, and documents the
shipped jobs. Correction analysis writes the local ledger and journal-backed
preferences; investigation mutations remain origin-only. No new block/allow
rule, transport, replication path, notification or lifecycle action is added.
Over-block: no new rejection. Under-block: existing diagnosis/evidence limits
remain. Layer: existing registry and real API fixtures. Signal/authority: no
semantic detector gains authority (docs/signal-vs-authority.md). Interactions:
default-on coverage remains in correctionLearningMode and callout lifecycle tests.
External surface: accurate feature and job documentation. Multi-machine: existing
origin-writer/proxied-read design. Rollback: revert this additive repair.
Repair tier 1; one independent review plus focused unit/integration checks and
full peer verification before merge. The underlying PR remains tier 2.

Independent repair reviewer: Concur with the review. Actual request paths reach
WriteAdmission, so a literal parameter prefix would miss runtime writes. The
broad POST declaration honestly covers the existing analyzer; baseline shrink is
correct. Documentation, feature-off fixtures, main imports and controllers are
consistent. No remaining blocking concern.
