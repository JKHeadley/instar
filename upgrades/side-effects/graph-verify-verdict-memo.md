# Side-Effects Review — certified-union row memo (verify / fullyPersisted / descriptor hash)

**Version / slug:** `graph-verify-verdict-memo`
**Date:** `2026-11-18`
**Author:** `Echo (echo-graph-event-loop-blocks, topic 144559)`
**Second-pass reviewer:** `independent reviewer subagents, spec-converge rounds 1-5 (see the convergence report)`

## Summary of the change

Tier 2 (security-sensitive: it decides when a verification verdict may be reused). Spec `docs/specs/graph-verify-verdict-memo.md`, converged in 5 rounds. Files: `src/core/ConversationGraphReplication.ts` (memo, per-pass context, epoch bumps, accept-loop reuse, check-mode freeze and divergence counter), `src/core/ConversationGraphLocalErasure.ts` (read-only `answerSignature()`), `tests/vitest-setup.ts` (check mode on in tests, divergence asserted after each test and file), `tests/unit/conversation-graph-verdict-memo.test.ts`.

`certifiedUnion` re-verified every stored row on every call; during Accept all that is one full pass per record continued and per read-view build (1-3 s each on a loaded Studio at ~550 rows). The memo reuses a stored row's `verify(row, origin)`, `fullyPersisted(row)` and descriptor hash while every input those read is unchanged.

## Decision-point inventory

- `certifiedUnion` per-row admission — pass-through — same predicates, same answers whenever external verifier state is stable within a pass, computed less often.
- Memo hit vs miss — add — invariant: identity of every top-level row value plus equality of a per-pass context; any difference, excluded row class or unreadable context recomputes.

---

## 1. Over-block

None added. Two directions were reviewed: a stale cached refusal could keep a row blocked one pass longer only if an input that can turn FALSE into TRUE changed without changing the context; the fence (grow-only signature), `erasureProofs` and `retainPendingErasure` (epoch) are all in the context.

## 2. Under-block

The dangerous direction is a stale TRUE. Inputs that can turn a covered row's TRUE into FALSE are row content (identity fingerprint; no nested in-place edits, enforced in tests by a deep freeze and a counted divergence when a frozen value reaches the one Reflect-based mutator), `installedMembership` and witness keys (signed per pass), and `releasePendingErasure` (epoch). Rows whose checks read the clock, files or custody lineage are never memoized. Remaining honest limit: the field-read test classifies every read mechanically, but each classification's invalidation rule is a maintained assumption, backed by the divergence guard on exercised paths.

## 3. Level-of-abstraction fit

Per-row, inside `certifiedUnion`, so every caller benefits whether or not a higher view cache hits (the read-view marker is null during writes). Alternatives considered in review: write-aware view marker (still one full pass per write), immutable row replacement (larger migration).

## 4. Signal vs authority compliance

- [x] No — this change has no new block/allow surface; it changes how often existing deterministic predicates run.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point.

## 5. Interactions

PR 3350 (one read view per page read) and the read-view cache sit above; the memo makes their cache-miss rebuild cheaper. `rememberControl` runs on every write and deliberately does not bump the epoch (only excluded erasure rows read `controlTargets`); bumping there would empty the memo after every record. The other bump sites run only on erasure and member-loss paths. `readerHash` is unchanged.

## 6. External surfaces

None: no route, config, file or message change. Two environment variables: `INSTAR_GRAPH_VERDICT_MEMO=off` (kill switch, read at construction) and `INSTAR_GRAPH_VERDICT_MEMO_CHECK=1` (tests).

## 7. Multi-machine posture (Cross-Machine Coherence)

Not a state surface: derived, process-local, never persisted, replicated or served; recomputable from the machine's own rows. The graph's existing replicated posture is unchanged. No status surface.

## 8. Rollback cost

`INSTAR_GRAPH_VERDICT_MEMO=off` and a restart, or revert. No persisted state.

## Conclusion

Ship. Rig proof (memo on vs off, same snapshot, production settings) follows on the accept-all rig.

## Second-pass review (if required)

**Reviewer:** spec-converge internal reviewers (security, adversarial, scalability, integration, decision-completeness, lessons-aware) and the GPT-family external reviewer, rounds 1-5, reading the draft code from round 3 on.
**Independent read of the artifact: concur** (final round: no DESIGN findings).

## Evidence pointers

- Rig profile 2026-11-18: `certifiedUnion` 48% of `readView` and 66% of revalidation; `verify` ~50% of `certifiedUnion`.
- Tests: `tests/unit/conversation-graph-verdict-memo.test.ts`; existing graph unit suites green with check mode on.
