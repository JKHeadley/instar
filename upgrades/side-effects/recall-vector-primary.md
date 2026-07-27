# Side-effects review — recall retrieves semantically, keyword becomes the fallback

**Change:** `PromptBuildRecall.recall()` becomes async and calls `searchHybrid()` (the vector
path) instead of the synchronous keyword-only `search()`. The timeout becomes a real race. The
strategy that actually served is reported. `SemanticMemory.searchHybrid()` now records
`vector-hybrid` so the reported strategy matches what ran.

**Discovered:** 2026-07-27, diagnosing why a lesson stored on 2026-07-19 was re-derived from
scratch. Operator directive the same day: *"Keyword searching should be supplementary, NOT the
primary method."*

## The condition

A fully-populated vector index existed and went uncalled. `GET /semantic/stats`:
`vectorSearchAvailable: true`, `embeddingCount: 2852` against 2,852 entities — 100% coverage.
`searchHybrid()` performs real vector KNN. `PromptBuildRecall.ts:138` called `search()`.

The cause was not a design decision. `recall()` was synchronous and `searchHybrid()` is async, so
the synchronous one was reachable and got used. **One ergonomic choice silently set the retrieval
strategy for the entire system**, and nothing reported it, because a keyword answer and a semantic
answer are the same shape — a `ScoredEntity[]` either way.

This is the second defect in the same path in one day. The first (#1680) was that recall returned
*nothing* for any natural-language query. Fixing that made the lexical path work; this makes the
lexical path the fallback it was always supposed to be.

## 1. Over-block — what legitimate input does this reject?

None. `searchHybrid()` degrades to `search()` internally whenever vectors are unavailable
(`SemanticMemory.ts:1714`), so an installation without a working embedding provider gets exactly
the previous behaviour — and now *reports* that it did, rather than being indistinguishable from
the semantic path.

The one input class treated differently is a **slow** search. Previously the timeout was checked
after the search returned, so a 30-second embedding cold start would have blocked the prompt path
for 30 seconds and then reported a timeout. It is now a race, so the budget actually holds.

## 2. Under-block — what does this still miss?

- **Cold start still costs one recall.** The first call after a server boot pays the ONNX model
  load and will likely time out; subsequent calls are warm. The timeout path is silent and
  cached-empty, so the cost is one missed recall, not an error. Pre-warming the model at boot is
  the obvious follow-up and is deliberately not in this change. <!-- tracked: ACT-1395 -->
- **It does not improve what is *in* the index.** Recall can only surface what was stored;
  extraction quality is a separate problem.
- **The strategy signal is per-call and in-memory**, not aggregated. Nothing yet reports "what
  fraction of recalls were served semantically" — that would be the honest measure of whether
  this change achieved its purpose, and it is not built here.

## 3. Level-of-abstraction fit

Correct layer. `recall()` is the single funnel the prompt hook reaches through, and the strategy
choice belongs at the point where the retrieval is requested, not inside `SemanticMemory` (which
correctly offers both and lets the caller choose).

The one-line addition inside `searchHybrid()` — recording `vector-hybrid` after the inner
`search()` call — belongs in `SemanticMemory` because only it knows whether embeddings actually
participated. Without it the strategy would report a lexical value even when vectors ranked the
result, which would make the reporting actively misleading rather than merely absent.

## 4. Signal vs authority compliance

Recall is a **signal producer**: its output is injected as context and gates nothing. This change
cannot block, delay, or redirect any action. The worst case is a less-relevant memory in context.

The timeout carve-out deserves scrutiny, because it *weakens* a breaker: a timeout no longer
counts toward the circuit. That is deliberate and argued — an embedding model that is still
warming is not a broken provider, and counting it would open the breaker on a healthy path and
keep recall dark for the whole cooldown, converting slowness into an outage. Genuine errors still
count, and a test pins that the breaker still opens on real failures so the carve-out cannot
quietly blunt it.

## 5. Interactions

- **Caller.** One call site (`routes.ts:3805`), already inside an async handler; it gains `await`.
  The hook that reaches it is unchanged and still receives the same JSON.
- **Circuit breaker.** Error path unchanged. Timeout path deliberately excluded — see §4.
- **Cache.** Unchanged. A timeout is not cached (it may succeed warm); empty and fresh results are
  cached as before.
- **#1680's strategy field.** This extends the same union rather than introducing a parallel
  signal, so `fts-strict` / `fts-loose-fallback` keep their meaning and `vector-hybrid` joins them.
- **Cost.** Embedding is a local ONNX pipeline — no API call, no per-call spend, no new provider
  dependency and nothing to route or budget.

## 6. External surfaces

`/internal/prompt-recall` gains an optional `strategy` field in its response. No field is removed
or changed. The hook ignores unknown fields. No schema, migration, config, or persisted state.

`recall()`'s signature changes from sync to async — a source-level breaking change with exactly
one in-repo caller, updated here. It is exported, so an out-of-tree caller would break; there are
none in this repo and the type change is compile-visible rather than silent.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local by design, and correctly so — no durable state is introduced.** The change picks
which local query runs against the local `semantic.db`; the strategy signal is per-call and
in-memory. Nothing here is replicated because nothing here is a durable fact about the agent —
whether *this* machine's recall was served semantically is a property of this process's index and
embedding provider, not a shared truth. Whether the semantic store itself replicates is a
pre-existing, separate question this change neither introduces nor alters.

## 8. Rollback cost

Revert the commit. `recall()` returns to sync + keyword, the caller drops its `await`, and the
strategy field disappears. No persisted state, no migration, no data to repair. The index remains
populated either way — it was populated and unused before this change, and would be again.

## Evidence

New tests verified to fail against unmodified source before the fix:

```
# fix reverted
Tests  5 failed | 17 passed (22)
  ✗ calls searchHybrid, not the keyword-only search
  ✗ reports the strategy that actually served
  ✗ reports a lexical strategy honestly when vectors did not serve
  ✗ bounds a slow search by the timeout instead of blocking the prompt path
  ✗ does NOT count a timeout as a circuit failure

# fix applied
Tests  22 passed (22)

# regression
semantic-memory + recall-query + privacy + vec0-probe — 4 files, 99 passed
tsc --noEmit — clean
```

The two new tests that pass in *both* runs are deliberate guards: "claims no strategy on a path
that never reached a search" and "still opens the circuit on real errors". They should pass
either way — that is what makes them guards rather than proofs.
