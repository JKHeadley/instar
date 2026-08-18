# Side-Effects Review — renderer-independent structured test observation

**Version / slug:** `w36-structured-test-observation`
**Date:** `2026-08-18`
**Author:** `Instar Agent (instar-codey)`
**Independent judgement:** pending

## Summary of the change

The standards enforcement measurement stops scraping Node's human test-renderer output. A verifier-owned child runner consumes `node:test` `TestsStream` events and returns an exact-schema summary over IPC. The existing H1 receipts still authenticate each completed child exit, and the existing three-workspace clean/mutated/pristine-confirmation boundary still decides discrimination.

## Decision-point inventory

- `standards-enforcement-node-test-runner.mjs` — add — turns structured `test:pass`/`test:fail` events and error causes into a machine-readable observation.
- `runObserver` — modify — invokes the pinned runner, captures exactly one IPC observation, and refuses missing or malformed structure.
- `artifactFor` — modify — records event counts, assertion count, and structured deciding message instead of parsed TAP summaries.
- `verifyProtectedExecutionProof` — modify — derives pass/fail/assertion gates only from structured observations.
- protected execution plan — modify — replaces `node-test-tap-v1` with `node-test-events-v1` and names the real runner entry path.

---

## 1. Over-block

Observers that do not use Node's test runner, produce only suites or skipped/todo tests, cannot send the structured summary, or run on a Node version without the supported `node:test.run()` event contract receive no credit. Missing structure is UNKNOWN rather than guessed. The repository engine floor is newer than the TestsStream API used here.

---

## 2. Under-block

The runner counts all non-suite, non-skipped pass/fail events; it does not judge whether every nested test is semantically relevant. Semantic adequacy of the protected subject and mutation remains an independent-review obligation. A candidate can edit the measurement implementation in its own change, so branch protection and independent judgement still matter; this change does not claim self-authentication of arbitrary future verifier edits.

---

## 3. Level-of-abstraction fit

Node explicitly exposes `TestsStream` for programmatic access because built-in reporter text can change. Consuming those events in a separate verifier-owned child is the narrowest source substitution: it preserves the existing process/authentication/workspace design and removes only the renderer-dependent inference.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] Hard invariant over enumerable structure.

The boundary validates exact keys, schema, source identity, observer identity, nonnegative integer counts, arithmetic consistency, and assertion-count bounds. Human output is retained only as non-authoritative diagnostic bytes. Ambiguity returns UNKNOWN and cannot raise strength.

---

## 4b. Judgment-point check

No heuristic interprets prose or decoration. Assertion classification follows the structured error/cause chain for `ERR_ASSERTION` or `AssertionError`; other failures do not earn the assertion direction. Semantic relevance remains outside this mechanical boundary.

---

## 5. Interactions

- **Authentication:** H1 receipts still bind the exact runner child PID, argv, exit code, and post-exit timing. The artifact records the regular non-symlink runner's SHA-256 plus the structured observation.
- **Timeout:** the existing isolated process-group kill and inherited-pipe severing remain unchanged. A timed-out child sends no usable observation or artifact.
- **Candidate continuity:** protected observer, subject, and declared helpers remain byte-bound before execution.
- **Renderer injection:** observer stdout can contain fake TAP, spec, dot, or glyph summaries without affecting counts or failure kind.
- **Adjacent lanes:** no fourth-guard harness file, shared verifier core, W4 entry comparison, CI configuration, or authentication primitive is modified.

---

## 6. External surfaces

The protected ledger runner name and argv contract change from the non-pinned TAP claim to the real event-runner entry. Protected main contains no schema-v3 execution plans, so no persisted record requires migration. Coverage JSON adds `observationSource` when an execution artifact exists. No user, network, database, operator, or deployment surface changes.

---

## 6b. Operator-surface quality

No operator surface — not applicable.

---

## 7. Multi-machine posture

**Machine-local BY DESIGN:** each machine runs the protected observer and creates its own ephemeral event summary and receipt. The structured source removes the demonstrated Node-version renderer divergence while allowing receipt nonces, PIDs, timestamps, and artifact hashes to remain machine-local.

---

## 8. Rollback cost

Rollback is a code revert with no data migration. It would restore the known supported-runtime defect where Node 25 refuses all completed observers because human summary text no longer matches the TAP parser.

---

## Conclusion

The exact judge runtime changes from 11/15 to 15/15, and the genuine observer reaches proven ratchet while fake rendered counts are ignored. The cost is one small verifier-owned runner process layer using a stable Node API already below the repository's engine floor. Independent judgement remains pending; the state is BUILT WITH HAND EVIDENCE, not machine-verified.

---

## Evidence pointers

- `scratchpad/phaseB/REPORT-W36.md`
- `tests/unit/standards-enforcement-measurement.test.ts`
- `tests/unit/standards-coverage-ratchet.test.ts`

---

## Class-Closure Declaration (display-only mirror)

`defectClass: claim-vs-evidence`, `closure: guard`, `guardEvidence: { enforcementType: ratchet, citation: tests/unit/standards-enforcement-measurement.test.ts, howCaught: the exact Node 25.6.1 control injects contradictory old and new renderer summaries, yet TestsStream reports one real clean, mutated, and confirmation test; only the genuine structured assertion direction reaches ratchet }`.
