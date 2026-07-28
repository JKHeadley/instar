# Side-effects review — strip the apostrophe from FTS5 queries

**Change:** one character added to the existing strip class in `sanitizeFts5Query`
(`src/memory/SemanticMemory.ts:106`): `'` joins `* : " ^ { } ( ) . $ @ # ! ~ ? \ [ ]`.

**Tier:** 1. One character in one pure function. No route, no config, no persisted state, no
migration, no schema. Rollback is removing the character.

## The defect, measured live

FTS5 reads `'` as a string delimiter, so an ordinary possessive or contraction reaches the parser as
an unterminated string and the query THROWS. Against the running agent (v1.3.1012, 2,930 entities):

| query | result |
|---|---|
| `why can a telegram bot not see another bot's messages` | `fts5: syntax error near "'"` on **both** `/semantic/search` and `/semantic/search/hybrid` |
| the same query without the apostrophe | 20 hits, `Telegram Bot Visibility Limit` at **rank 1** |

**The throw is not confined to keyword search.** `searchHybrid()` runs FTS5 alongside vector KNN, so
the exception takes the hybrid call down with it — and `PromptBuildRecall` is fed the user's RAW
message. PR #1683 had just made recall prefer the hybrid path; this defect could take that path out
on any question containing a contraction.

## Why STRIP rather than escape

Consistency and cost. Every other special character here is stripped, not escaped, and FTS5's
`unicode61` tokenizer already splits on the apostrophe — so `bot's` and `bots` produce identical
tokens. Stripping changes only whether the query PARSES, never what it can match.

Escaping (doubling the quote) would also work but introduces a second convention in a function whose
whole contract is "remove characters that mean something to the engine and nothing to the asker".

## Blast radius

Queries that previously threw now return results. Queries that previously worked are unaffected —
verified: 18 tests in the recall-query file and 76 across five memory suites pass unchanged, and the
pre-existing operator-stripping and stopword tests are untouched.

**Residual risk considered and rejected as immaterial:** a user searching for a literal apostrophe
(e.g. an entity whose name contains one) loses that character from the query. Since the tokenizer
already splits there, no stored entity is reachable *only* via a literal apostrophe, so nothing
becomes unfindable.

## Verification — by reverting, because a passing test proves nothing

```
apostrophe REMOVED from the strip class:  2 failed | 16 passed (18)
  × strips the apostrophe, which FTS5 reads as a string delimiter
  × strips apostrophes from contractions too, not only possessives
apostrophe RESTORED:                      18 passed (18); 76 passed across 5 memory suites
tsc --noEmit                              exit 0
```

The tests assert the word SURVIVES the strip (`bot`, `relay` still present), not merely that the
apostrophe is gone. Without that, "fix" the error by dropping the whole term would pass.

## A note on how this was found

By reading the live surface after merging PR #1683, rather than by a test. I first ran the check
against `/semantic/search` — the KEYWORD route — and was about to report that the vector fix
under-delivered, because the correct entity did not appear. Reading the route showed
`/semantic/search` calls `search()`, not `searchHybrid()`; the hybrid route ranks it **first**. The
apostrophe error was the one real defect in that check, and it was on both.
