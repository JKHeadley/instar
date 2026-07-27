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

- **No semantic/vector matching.** A query using different words than the stored entity
  ("can't message the other agent" vs "bot visibility") still misses. The vector path exists
  (`searchHybrid`) but `vec0` is not loadable on this machine, so lexical matching is what
  actually runs. Widening lexically is the honest available fix, not a substitute for
  embeddings. <!-- tracked: ACT-1384 -->
- **Stopword list is English-only and fixed.** A domain word that is genuinely a stopword
  here (e.g. "session") is not covered, and shouldn't be — over-stripping would blunt
  precision.
- **The OR fallback ranks by FTS rank only.** It can surface a weakly-relevant entity when a
  strongly-relevant one does not exist. That is the intended trade: five loosely-relevant
  memories beat the empty set that made every stored lesson unreachable. It cannot fabricate
  a hit — a query about something genuinely not stored still returns empty (pinned by test).

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
