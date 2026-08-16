# Cross-Model Review — GPT (iter 4)

**Document**: PROJECT-SCOPE-SPEC.md
**Iteration**: 4 (convergence check)
**Model**: gpt (gpt-5.4)
**Timestamp**: 20260511-101828
**Prior score (iter-3)**: 9/10 APPROVE with 5 clarity-grade recommendations
**Iter-4 framing**: All 5 iter-3 recs addressed (attentionReason, reparse immutability table, mid-round mutation table, GET may-mutate contract, cost-cap caveat). Identify material NEW issues.

---

## Raw Response

## 1. Overall Assessment
- **Score**: 9.5/10
- **Status**: APPROVE

This is converged and materially stronger than iter-3. The five prior clarity-grade issues appear genuinely addressed: the `attentionReason` ambiguity is functionally covered by the canonical `awaiting-user` state plus explicit surfaced reasons; reparse mutability is now explicitly tabled; mid-round mutation rules are concretized; `GET /projects/:id` may-mutate semantics are documented with a pure-read escape hatch; and the drift cost-cap caveat is now explicit about per-machine worst-case behavior. I do **not** see any new **material** issues that would block approval. What remains is mostly minor consistency polish and implementation-detail cleanup, not spec-shaping risk.

## 2. Critical Issues (Must Fix)
**None material new in iter-4.**

## 3. Strengths
- **Signal vs authority is now consistently load-bearing**: P1, Phase 1.4, and the threat model align well. This is one of the strongest parts of the spec.
- **Artifact-bound transitions are concrete and testable**: Phase 1.2 is crisp, especially the squash/rebase merge handling via `mergeCommit.oid`.
- **Concurrency story is much improved**: P4 + custom merge driver + reconciliation semantics is a strong correction over naive field-wise merge.
- **Runner chokepoint is clear**: Phase 1.5 centralizes gating correctly and avoids split-brain policy between HTTP and skill layers.
- **Multi-machine ownership is thoughtfully handled**: P5 and Phase 1.12 now describe a plausible ownership transfer protocol rather than hand-waving.
- **Read-path mutation caveat is explicitly documented**: this was important, and the `?reconcile=false` contract is the right kind of escape hatch.
- **Reparse and mid-round mutation semantics are finally explicit**: both tables remove a lot of ambiguity that would otherwise leak into implementation.
- **Threat model is unusually complete**: especially around prompt injection, path jail, conflict markers, process groups, and squash-merge correctness.
- **Success criteria are concrete and regression-oriented**: many are implementation-verifiable, not aspirational.

## 4. Gaps & Missing Elements
No major new gaps. Minor nits only:

- **Naming consistency**: the spec uses both `awaiting-user` and prose like `awaitingUser` in a few places. Not material, but normalize to one wire/storage form.
- **Drift spend filename inconsistency**: Phase 1.4 uses daily-rotated `.instar/drift-spend-YYYY-MM-DD.jsonl`, while backup/restore and one success criterion still mention `.instar/drift-spend.jsonl`. This is editorial, not architectural.
- **`fcntl flock` wording**: POSIX terminology is a bit mixed (`fcntl` vs `flock`). Implementation should pick one primitive and document it precisely.
- **DELETE semantics**: endpoint says `DELETE /projects/:id — archive`; acceptable, but slightly surprising REST-wise. Fine if intentional.

## 5. Industry Comparison
This compares well to strong internal-tools specs and is above average in operational realism. It avoids several common anti-patterns:
- avoids trusting LLM output as authority,
- avoids in-memory timers for durable workflow state,
- avoids field-wise auto-merge on OCC-governed records,
- avoids assuming PR head SHA equals landed SHA,
- avoids pretending multi-machine cost caps are globally atomic when they are not.

Relative to industry best practice, this is closest to a lightweight workflow orchestrator layered onto a git-backed metadata store. The main tradeoff versus more standard systems is that git-sync + JSON ledger is less robust than a transactional DB/event log, but for the stated scope it is a deliberate and reasonably defended choice.

## 6. Scalability Assessment
- **Phase 1 (MVP, 10-50 users)**: Yes, it should work well.
- **Phase 2 (Growth, 50-500 users)**: The git-backed shared ledger, shell-outs to `gh`, polling, and file-lock/local-lock patterns start to strain. Still workable for low write volume, but operational sharp edges increase.
- **Phase 3 (Scale, 500-5000 users)**: You likely need a real datastore, queueing for reconciliation/revalidation, and event-driven ownership/heartbeat handling instead of git-sync coordination.
- **Spike handling**: The spec has some protections—debounced lazy reconciliation, capped per-GET child revalidations, polling intervals, cache files—but dashboard polling plus read-triggered reconciliation could still create bursty `gh pr view` load. Not a blocker for current scope.

## 7. Recommendations (Prioritized)
Since no new material issues emerged, these are **polish recommendations**, not approval blockers:

1. **Normalize naming for awaiting-user state/reason fields**
   - Ensure every section uses the same canonical field/state spelling (`awaiting-user` vs `awaitingUser`) and, if a separate reason field exists, name it explicitly everywhere.

2. **Fix drift-spend file path references**
   - Update backup/restore, success criteria, and any surface tables to consistently reference the daily-rotated ledger format.

3. **Clarify file-lock primitive wording**
   - Replace `POSIX fcntl flock` with the exact mechanism the implementation will use, to avoid portability confusion.

4. **Add one sentence on GET mutation observability**
   - State whether a mutating GET increments `version` and invalidates digest cache like any other write. It is implied, but making it explicit would help clients.

5. **Tighten archive/delete wording**
   - Since `DELETE /projects/:id` archives rather than hard-deletes, explicitly call that out in the endpoint table and rollback/migration prose for consistency.

**Verdict:** **APPROVE**
**Material new issues:** **Zero**

---

## Analysis (Convergence Signal)

**Convergence verdict from GPT: REACHED.**

- **Score trajectory**: 9/10 (iter-3) → 9.5/10 (iter-4). Direction is up.
- **Verdict**: APPROVE (unchanged from iter-3).
- **Material new issues**: Explicitly **zero**.
- **All 5 prior iter-3 recommendations**: Acknowledged as "genuinely addressed."

The five remaining items GPT raised are all explicitly framed as **polish, not blockers**:

1. Naming inconsistency `awaiting-user` vs `awaitingUser` — editorial.
2. Drift-spend filename references inconsistent between Phase 1.4 (daily-rotated) and Phase 1.13/success-criterion-27 (`.instar/drift-spend.jsonl`) — editorial.
3. `fcntl` vs `flock` terminology — implementation-detail wording.
4. One sentence on whether mutating GET bumps `version` and invalidates digest cache — clarification.
5. Endpoint-table wording for `DELETE = archive` — wording.

**Material findings worth noting for the convergence report:**

- GPT independently flags the same drift-spend filename drift that Gemini may also catch — this is a real internal inconsistency in the spec (Phase 1.4 introduced daily-rotated naming but Phase 1.13 and success criterion 27 still reference the singular `.instar/drift-spend.jsonl`). Worth a one-line edit pass before approval, but does not block.
- GPT explicitly validates the iter-3 corrections rather than re-raising them — confirms convergence is real, not just iteration fatigue.
- Scalability framing (git-sync + JSON ledger trades vs DB/event-log) is acknowledged as a deliberate, defended choice — not a blocker.

**Recommended action**: This is an APPROVE with editorial polish suggestions. The spec is converged. Apply the 5 polish items as a single editorial pass; no architectural changes needed.
