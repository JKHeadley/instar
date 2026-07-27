# Side-effects review — natural-language recall for SemanticMemory.search

**Change:** `search()` strips stopwords before building the FTS5 match expression, and
falls back to an OR of the content words when the strict implicit-AND match returns
nothing.

**Discovered:** live, 2026-07-27, while diagnosing why a lesson recorded on 2026-07-19
("Telegram bot visibility limit") was re-derived from scratch eight days later. Capture had
worked; the entity was stored, FTS-indexed, and retrievable by keyword. The recall hook was
enabled and installed. It returned nothing because of the shape of the query it was handed.

## The mechanism

FTS5 requires **every** bare token to match. Recall is fed the user's raw message, which is
always a sentence. Measured against the live 2,852-entity store:

| query | before |
|---|---|
| `can I reach Codey` | 0 |
| `is Codey responding to my messages` | 0 |
| `why is Codey not replying` | 0 |
| `reach Codey` | 7 |
| `Codey messages` | 17 |

No stored entity contains the word "why", so a question beginning "why" could never match
anything regardless of its content words. The system was enabled, wired, and structurally
incapable of answering the queries it received.

## 1. Over-block — what legitimate input does this now reject?

None. Stopword removal only ever *widens* the candidate set, and the OR fallback runs only
when the strict query returned zero rows. Every input that previously returned results
returns the same results by the same path — the strict query is attempted first and
unchanged for keyword queries.

The one guarded edge is an all-stopword query (`"what is it"`). Removing every token would
leave an empty match expression, which in FTS5 is a syntax error rather than a match-nothing.
`buildFtsQueryVariants` keeps the original tokens in that case, so behaviour degrades to
exactly the previous semantics rather than throwing or matching everything. Pinned by test.

## 2. Under-block — what does this still miss?

- **This fixes the fallback path, NOT the primary one — and the primary one is the real bug.**
  A fully-populated vector index already exists: `GET /semantic/stats` reports
  `vectorSearchAvailable: true, embeddingCount: 2852` against 2,852 entities, i.e. 100%
  coverage. `searchHybrid()` performs real vector KNN. But `PromptBuildRecall.ts:138` calls
  the synchronous `search()` — FTS5 keyword-only — because `recall()` is synchronous
  (`PromptBuildRecall.ts:113`) and `searchHybrid` is async. So recall runs on keyword
  matching while the embeddings sit unused, and a query worded differently from the stored
  entity misses regardless of this change.

  This change is therefore a **floor-raiser for the lexical path**, which still matters —
  `searchHybrid()` degrades to `search()` whenever vectors are unavailable, and
  `/semantic/search` uses it directly — but it is explicitly not the answer to
  "why didn't recall find this". Keyword search should be supplementary, not primary.
  <!-- tracked: ACT-1386 -->

  *Correction of record:* an earlier draft of this artifact claimed `vec0` was unloadable and
  recall was lexical-only by necessity. That was wrong. It came from probing `semantic.db`
  with python's `sqlite3`, which does not load the extension; the Node process loads it
  successfully. The false claim is recorded here rather than quietly deleted, because
  "I verified with the wrong tool and concluded a capability was missing" is the same failure
  class this whole change exists to address.
- **Stopword list is English-only and fixed.** A domain word that is genuinely a stopword
  here (e.g. "session") is not covered, and shouldn't be — over-stripping would blunt
  precision.
- **The OR fallback ranks by FTS rank only.** It can surface a weakly-relevant entity when a
  strongly-relevant one does not exist. That is the intended trade: five loosely-relevant
  memories beat the empty set that made every stored lesson unreachable. It cannot fabricate
  a hit — a query about something genuinely not stored still returns empty (pinned by test).

## 2b. The fallback announces itself (self-caught during review)

The first revision of this change introduced a **silent** degradation — the OR widening
substituted a weaker strategy and reported nothing. That is the same defect class the change
exists to fix, added by the fix. Caught before merge and corrected.

`search()` now records `lastSearchStrategy`:

- `fts-strict` — the precise implicit-AND query served
- `fts-loose-fallback` — strict found nothing; the weaker OR query served instead
- `none` — no query ran (reset on the early-return path, so a stale "served by strict" can
  never be read for a query that never executed)

Read-only. It gates nothing and does not change what `search()` returns. This is
*No Silent Degradation to Brittle Fallback* (`docs/STANDARDS-REGISTRY.md:125`) applied to a
retrieval path: "silent degradation to a weak check is worse than no check, because it looks
protected while being fake-protected." The standard's own scope is LLM calls that *gate* an
action, so it did not formally bind here — but its reasoning is exactly on point, and
honouring it cost three tests.

The concrete argument for it: recall ran on keyword-only search for its entire life while a
fully-populated vector index (2,852/2,852 embeddings) went uncalled, and nothing anywhere
reported that. A cheap path that announces itself is the difference between that being
discoverable and being invisible for months.

## 3. Level-of-abstraction fit

Correct layer. `search()` is the single funnel every recall caller uses — the
`before-prompt-recall` hook, `PromptBuildRecall`, and the `/semantic/search` route all reach
it. Fixing query construction here fixes every caller at once. Fixing it in the hook would
have left the route and any future caller broken, and would have put query-shaping knowledge
outside the module that owns the index.

## 4. Signal vs authority compliance

Recall is a **signal producer** — its output is injected as context, never as an
instruction, and it gates nothing. This change cannot block, delay, or redirect any action;
the worst case is that a slightly-less-relevant memory is surfaced as background context.
That is precisely the class of check where widening recall is safe: a false positive costs a
line of injected context, while the false negative it replaces cost a repeated incident.

No blocking authority is added or moved.

## 5. Interactions

- **Filter composition.** The fallback re-uses the identical prepared statement and
  parameter list, substituting only the match expression. Type, domain, confidence, and
  privacy filters therefore apply to both passes identically — verified by a test asserting
  `minConfidence: 0.95` still returns empty through the fallback path.
- **Vector re-ranking.** `_lastVectorScores` merging is untouched and runs after row
  selection, so a widened row set is re-ranked by the same logic.
- **Operator stripping preserved.** `sanitizeFts5Query` still runs first, so `AND`/`OR`/
  `NOT`/`NEAR` and FTS5 syntax characters are removed from user input before tokenising. The
  `OR` this change introduces is constructed by us from already-sanitised tokens, never
  passed through from the caller. Pinned by test.
- **No double-execution cost in the common case.** The second query runs only on a zero-row
  first pass.

## 6. External surfaces

No wire format, schema, migration, config, or route change. `/semantic/search` returns
results where it previously returned an empty array for the same input. Nothing that
previously returned data changes shape. One new exported function (`buildFtsQueryVariants`),
exported for testability because the failure is invisible at the route level — a zero-result
search looks identical to "nothing was ever stored", which is exactly why this survived
undetected.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local by design, and correctly so — no new state is introduced.** This changes only
how a query string is built before hitting a local SQLite FTS index. Each machine already
owns its own `semantic.db`; whether that store *replicates* is a separate concern that this
change neither introduces nor alters. No notice, no generated URL, no durable state, nothing
that could strand on topic transfer.

## 8. Rollback cost

Near zero. Revert the commit; `search()` returns to passing the sanitised string straight
through. No persisted state, no migration, no agent-state repair. Any query that worked
before the change works identically after a revert.

## Evidence

Tests verified to fail against unmodified source before the fix was applied:

```
# fix reverted
Tests  9 failed | 4 passed (13)
  — the 4 passing are the regression guards: bare keyword query, strict-match
    preference, genuinely-absent query returns empty, confidence filter honoured.
    They SHOULD pass on unfixed source; that is what makes them guards.

# fix applied
Tests  13 passed (13)

# regression surface
semantic-memory + privacy + evidence + invokeFromRemediator + corruption-recovery
  — 5 files, 126 tests passed
tsc --noEmit — clean
```

Verified against the **live 2,852-entity store**, not only fixtures:

```
"can I reach Codey"                      0 → 5 hits
"is Codey responding to my messages"     0 → 5 hits
"why can a telegram bot not see messages"  0 → 5 hits,
      top hit = "Telegram bot visibility limit"
```

That last line is the point of the change: the entity recovered as the top hit is the exact
lesson that was stored on 2026-07-19, never surfaced, and re-derived from scratch on
2026-07-27.
