# Side-Effects Review — Migration-consumer completeness

**Version / slug:** `migration-consumer-completeness`
**Date:** `2026-07-19`
**Author:** `Instar Agent (instar-codey)`
**Second-pass reviewer:** independent sub-agent review — concurred after two correction rounds

## Summary of the change

This change registers Migration-Consumer Completeness in `docs/STANDARDS-REGISTRY.md`, adds the machine-readable contract registry at `docs/canonical-migration-contracts.json`, and adds `scripts/lint-migration-consumer-completeness.js` to normal lint, staged commit, and pull-request-diff gates. The existing Threadline canonical-store migration is enrolled as the first contract. It also closes two real compatibility consumers: reply authorization already accepts legacy-plus-ThreadLog evidence, and reap recovery now accepts the same union, resolving inline bodies directly and store-backed bodies only after MessageStore identity and content-digest verification.

## Decision-point inventory

- Migration lockstep gate — added hard structural invariant — a changed canonical producer or consumer requires a revision bump acknowledged by every declared producer, consumer, and validator in the same diff.
- Contract completeness review — passed through — the lint reports declared structure; independent review remains semantic authority over whether the declaration includes every real consumer.
- Reap recovery authority — changed from legacy-inbox-only to the canonical legacy-plus-ThreadLog union; modern store references resolve through MessageStore and fail closed on absence, identity mismatch, or digest mismatch.

## 1. Over-block

A producer or consumer file changed for a reason unrelated to its canonical authority still requires a contract revision and an explicit marker acknowledgement across the declared boundary. This is deliberate conservative friction at an authority boundary, but it makes the review event visible rather than pretending that a same-diff touch proves semantic behavior. The contract can be narrowed later by extracting the authority into smaller dedicated modules; there is no bypass flag.

## 2. Under-block

The lint cannot infer an undeclared semantic consumer. A developer could omit a consumer from both the manifest and markers and still pass the mechanical gate. The registry and marker set make that omission visible to review, but semantic completeness remains an independent-review responsibility. Revision acknowledgement also does not prove that a changed validator meaningfully exercises the behavior; test review and CI remain responsible for that. Store-backed recovery intentionally remains unavailable when MessageStore evidence is missing, corrupt, identity-inconsistent, or digest-inconsistent; the resume item stays retryable rather than executing unverified content.

## 3. Level-of-abstraction fit

The manifest is the right deterministic layer for dependency declaration, and the lint is the right layer for path, marker, and diff invariants. A static parser is not promoted into semantic authority: it never guesses which files are consumers. Review judges the declaration; the gate enforces the declared contract.

## 4. Signal vs authority compliance

Per `docs/signal-vs-authority.md`, the hard block is a fully enumerable repository invariant: declared paths and markers either exist and move together or they do not. The non-enumerable question—whether the declaration covers every semantic consumer—remains with contextual review. No brittle keyword detector decides semantic completeness.

## 4b. Judgment-point check

No static heuristic is added at a competing-signals decision point. Lockstep membership is an invariant over an explicit contract. Semantic consumer discovery remains a judgment candidate owned by review rather than this lint.

## 5. Interactions

- **Shadowing:** normal `npm run lint` checks registry integrity before CI; the staged and PR-diff invocations add lockstep evidence. They are complementary rather than shadowing.
- **Double-fire:** a malformed registry may be reported by both local lint and the staged invocation. Both are read-only and deterministic; duplicate diagnostics have no side effect.
- **Races:** the lint reads immutable checkout/staging state and writes nothing. Recovery continues to use the existing durable reply-claim ledger; MessageStore resolution occurs before the claim, then the existing claim/transfer/release sequence prevents double execution.
- **Feedback loops:** none. It does not mutate contracts or source markers.

## 6. External surfaces

Instar developers see actionable commit/CI failures when a canonical producer or consumer moves without its declared dependency set. At runtime, an interrupted modern Threadline inbound can now be redriven even when the legacy inbox has no copy. No new external service, credential, operator action, or URL is introduced; recovery reads only local canonical ThreadLog and MessageStore state.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

Replicated through git: the standard, manifest, markers, and lint are repository artifacts and therefore identical in every worktree and CI runner. Threadline evidence remains machine-local under the existing single-holder model; recovery reads the local ThreadLog and MessageStore associated with the interrupted worker and does not invent cross-machine lookup or replication. The change adds no user-facing notice or URL.

## 8. Rollback cost

Revert the policy/guard and recovery union, then ship a patch. No data migration or agent-state repair is required because the runtime change is read-only over existing ThreadLog/MessageStore records and writes only through the pre-existing reply-claim and router paths. Rolling back restores legacy-only reap recovery and therefore reopens the modern-only stranded-work defect.

## Conclusion

The original #1523 CLASS review named Migration-Consumer Completeness but did not add it to the constitution or enforce it structurally. This change closes that meta-gap with an explicit standard and a real lockstep guard, while preserving review as the semantic authority. Independent review is required because the change adds a blocking repository guard.

## Second-pass review

**Reviewer:** `/root/migration_guard_review`
**Independent read:** Concurred. The first pass required enrollment of the real append/recovery consumers, revision-based acknowledgements, root/removal guards, and honest runtime documentation. The second pass found role-member removal and store-backed recovery bypasses. Final review verified both adversarial closures, MessageStore identity/digest binding, production wiring, retry posture, and the updated side-effects analysis; no merge blocker remains.

## Evidence pointers

- `tests/unit/migration-consumer-completeness-lint.test.ts`
- `tests/unit/threadline/ThreadlineReplyValidation.test.ts`
- `tests/integration/threadline-relay-send-priority.test.ts`
- `tests/integration/threadline-reap-recovery-wiring.test.ts`
- `tests/integration/threadline/canonical-history-wiring.test.ts`
- `tests/e2e/threadline-reap-mid-processing.test.ts`
- PR #1523

## Class-Closure Declaration (display-only mirror)

`defectClass: claim-vs-evidence`, `closure: guard`, `guardEvidence: { enforcementType: lint, citation: scripts/lint-migration-consumer-completeness.js#auditMigrationConsumerCompleteness, howCaught: a canonical migration producer cannot substantiate completeness without registered consumer and validator paths, matching role markers, and same-diff lockstep evidence }`.
