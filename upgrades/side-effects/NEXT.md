# Side-effects review — correction class review and Verify Before Done

## 1. Over-block

The correction correspondence gate applies only to Actions and Commitments explicitly derived from a correction. In dry-run it records a would-refuse signal and allows the write; fleet default is dark. A dead-lettered review fails open while creating one durable agent-owned retry. Verify Before Done is advisory and cannot block, rewrite, delay, or suppress a response. The principal residual over-block risk is an incorrectly stamped correction origin, bounded by exact correction-id/class-review correspondence and deterministic tests.

## 2. Under-block

Untagged work is intentionally outside the instance-fix gate, so an integration that fails to stamp correction provenance could bypass it. Creation paths owned by this feature stamp the fields automatically, and integration tests cover both Action and Commitment admission. Provider outage and invalid output are bounded-retry, fail-open cases; they remain visible as pending/dead-lettered reviews rather than being reported as resolved. Verify Before Done may miss claims outside its closed action vocabulary or when structural evidence is unavailable; v1 measures these misses and grants no enforcement authority.

## 3. Level-of-abstraction fit

The change fixes the class rather than the founding instance. Every recorded correction gets a durable record-time standards/process review before downstream correction-derived work, independently of recurrence scoring. A shared clause-level arbiter classifies mixed future and completion clauses once, then preserves the established Action-Claim path and adds advisory completion verification. The garbage-correction path closes explicitly as not-applicable with no Initiative or Action.

## 4. Signal vs authority compliance

Model output is proposal and signal only. It cannot ratify or relax a standard, close an operator decision, authorize autonomous execution, or block outbound messaging. Standards outcomes require the operator PIN; local operator lifecycle writes are authoritative, while replicated terminal state is advisory. The completion detector writes content-bounded observations and metrics only. Its boot canary reports parser drift but never turns that signal into authority.

## 5. Interactions

Correction recurrence analysis remains independent and correction status is unchanged. The shared Action-Claim sentinel keeps exact legacy behavior while completion verification is disabled, dry-run, uncertain, or unavailable; in live posture the shared arbitration prevents duplicate future commitments. Deferrals create tracked Commitments, recurrence may reopen a retained review, and supersession is explicit and audited. Backup includes the class-review database/WAL plus bounded completion audit and statistics files. Existing hooks are migrated idempotently and remain installed on rollback, where disabled routes make them quiet no-ops.

The structural self-action model now reloads its open-artifact identities from durable fixture state during restart storms. This mirrors the production SQLite-backed cap: reconstruction cannot mint a fresh allowance or exceed the shared 50-open-artifact bound under unchanged pressure.

The coherence advert contract includes `class-review-record` explicitly, so peers discover the replicated stream from an empty journal instead of relying on incidental later writes; the exact-kind regression expectation guards this wire-level surface.

The final structural census now accounts for every surface introduced by the feature: both model-attribution components are categorized, carry intentional nature-B entries in the human routing registry, are explicitly queued for Wave-3 benchmark authoring, declare untrusted/injection-bearing input shapes, name their claim-judging and parser-contract posture, and are wired into the decision-provenance meter with bounded per-day volume valves and identity-only context. Every new mutating route has an explicit write-domain convergence story, `ClassReviewStore` is enrolled in the process-lifetime SQLite shutdown registry, and the new CLAUDE.md section is tracked by the feature-delivery guard. Conservative error paths carry explicit bounded-fallback annotations, holding the no-silent-fallback ratchet at its existing baseline rather than weakening it. The hand-audited dark-gate line map was re-attributed after the new config blocks shifted source positions; its 25-path semantic set is unchanged.

## 6. External surfaces

New authenticated surfaces are the class-review list/detail/backfill/lifecycle routes, completion observe/audit routes, feature metrics, and the existing Preferences dashboard sections. The completion hook submits only a closed structural evidence vocabulary and a scrubbed bounded message; commands, raw tool inputs/results, transcript paths, and correction learning are excluded. Class-review intelligence receives only scrubbed summaries and bounded standard titles. Pool reads use credential-safe peer allowlisting and clamp proxied fields before returning them.

## 6b. Operator-surface quality

The existing Preferences tab remains a read-first surface, so its primary action is understanding current state rather than mutating it. The new sections lead with the review outcome and advisory completion verdict, and each card expands in place for lifecycle/action detail rather than ending at a dead-end summary. Closed display-label maps humanize every known backend enum; unknown values fail to a safe plain-language label instead of exposing a new slug. Raw dedupe keys, model prompts, transcript paths, tool payloads, auth details, and configuration keys are not primary content. This slice adds no destructive dashboard control, and the PIN-bound lifecycle mutations remain API-only rather than being placed beside the read view. Labels use short phrases, vertically stacked expandable cards, and the existing responsive tab layout so the content remains readable at phone width without requiring a wide table or horizontal comparison.

## 7. Multi-machine posture

Class reviews are unified by the machine-independent correction dedupe key through the registered coherence store. Shell creation and observations merge monotonically; filled state never regresses; local lifecycle transitions remain single-writer; remote terminal outcomes are labeled advisory. Retained rows keep the correspondence predicate resolvable without tombstones. Completion evidence is machine-local by hardware-bound-resource justification because the transcript belongs to the executing machine, with a redacted proxied-on-read pool view. Retry counters and feature metrics remain machine-local operational bookkeeping.

## 8. Rollback cost

Rollback is a reversible configuration change: disable both development gates or return them to dry-run. Fleet is already dark by default. Existing correction capture, recurrence processing, Action-Claim routing, and outbound messaging continue on their prior paths. Durable class-review and completion-audit evidence remains inert and readable rather than being deleted; this consumes bounded disk for completion logs and retained SQLite space for correspondence rows. No irreversible external action, data migration, or user-visible enforcement is introduced.

## Class-Closure Declaration (display-only mirror)

`defectClass: unbounded-self-action`, `closure: guard`, `guardEvidence: { enforcementType: ratchet, citation: tests/unit/self-action-convergence.test.ts, howCaught: correction-review retries and open artifacts are durably bounded across reconstruction; the registered controller convergence ratchet proves sustained pressure settles without restart-minted allowance }`.

Independent second-pass review: Concur with the review. The completion arbiter publishes suppression authority only after authoritative classification and downstream clause routing complete; all pending, failure, callback-error, and hook-order races preserve the legacy Action-Claim path without waiting.

Operator-surface second-pass review: Concur. All known outcomes, verdicts, and actions have closed plain-language mappings with non-leaking fallbacks; expandable cards provide the next detail layer; and the adversarial renderer regression proves raw enum slugs are absent.

Restart-model second-pass review: Concur. The durable fixture reload accurately mirrors the production open-artifact cap and introduces no unreviewed side effect.

Coherence-advert second-pass review: Concur. The test now matches the already-emitted replicated kind and closes the exact wire-contract omission.

Structural-census second-pass review: Concur after repair. The detached completion callback is invoked at most once; a callback failure leaves suppression authority unpublished, decrements queue state in `finally`, and cannot escape as an unhandled rejection. The regression covers those four properties, and the attribution, write-domain, SQLite, feature-section, fallback, and dark-gate census repairs accurately preserve their existing structural ratchets.
