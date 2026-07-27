## What Changed

Memory recall now retrieves semantically. Keyword matching becomes the fallback it was always
meant to be.

A fully-populated vector index already existed and went uncalled: `GET /semantic/stats` reports
`vectorSearchAvailable: true` and `embeddingCount: 2852` against 2,852 entities — 100% coverage —
while `PromptBuildRecall.ts:138` called the keyword-only `search()`.

The cause was not a design decision. `recall()` was synchronous and `searchHybrid()` is async, so
the synchronous one was reachable and got used. **One ergonomic choice silently set the retrieval
strategy for the whole system**, and nothing reported it, because a keyword answer and a semantic
answer are the same shape — a `ScoredEntity[]` either way.

`recall()` is now async and calls `searchHybrid()`, which degrades to `search()` internally when
vectors are unavailable, so an installation without a working embedding provider keeps exactly its
previous behaviour — and now reports that it did.

Two supporting changes:

- **The result reports which strategy served it** (`vector-hybrid`, `fts-strict`,
  `fts-loose-fallback`). `searchHybrid()` records `vector-hybrid` after its inner `search()` call,
  so the reported strategy matches what actually ran rather than what the last lexical step did.
- **The timeout is a real race.** It was previously checked *after* the search returned, so a slow
  embedding cold-start would block the prompt path for its full duration and then report a
  timeout. The budget now holds.

A timeout deliberately does **not** count toward the circuit breaker: a model still warming is not
a broken provider, and counting it would open the breaker on a healthy path and keep recall dark
for the entire cooldown, converting slowness into an outage. Genuine errors still count, pinned by
a test.

This is the second defect in this path in one day. The first was that recall returned *nothing*
for any natural-language query; fixing it made the lexical path work. This makes the lexical path
the fallback.

## Evidence

New tests run against **unmodified source first**:

| run | result |
|---|---|
| fix reverted | **5 failed / 17 passed** |
| fix applied | **22 passed** |
| semantic-memory regression (4 files) | **99 passed** |
| `tsc --noEmit` | clean |

Two new tests pass in *both* runs by design — "claims no strategy on a path that never reached a
search" and "still opens the circuit on real errors". They are guards, not proofs.

## What to Tell Your User

Your agent has two ways to search its own memory: one that matches on meaning, and one that
matches on words. The good one was built, fully switched on, and never called.

All 2,852 of its stored memories already had the data needed for meaning-based search. The recall
path used word-matching instead — not as a decision anyone weighed, but because the word-matching
version returned instantly and the meaning-based one takes a moment, so only the instant one was
reachable from the way recall was written. One small choice, made once, quietly decided how the
whole system remembers.

Nothing reported it, because both searches hand back the same shape of answer. A worse result and
a better result look identical once they arrive.

Recall now asks the meaning-based search first. It also says which search served each answer, so
running on the fallback no longer looks the same as running properly — and the time limit is now
enforced while waiting rather than checked afterwards, so a slow search can't hold up your reply.

The first lookup after a restart may still be slow while the model loads. That costs one missed
lookup, quietly, and everything after is fast.

## Summary of New Capabilities

- Memory recall retrieves by meaning rather than keyword, using the embedding index that was
  already built and populated but never called.
- Each recall reports which strategy served it, so running on the keyword fallback is
  distinguishable from running semantically.
- The recall timeout is enforced during the wait rather than checked afterwards, so a slow
  embedding cold-start cannot block the prompt path.
- A timeout no longer counts toward the recall circuit breaker, so a warming model cannot disable
  memory for a full cooldown; genuine errors still trip it.
