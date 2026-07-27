## What Changed

Fixes a crash in the agent's memory search: a question containing an apostrophe — an ordinary
possessive or contraction — threw a syntax error instead of returning results.

The search engine underneath reads `'` as the character that opens a quoted string, so
"the bot's messages" or "what doesn't work" reached it as an unterminated quote. The apostrophe now
joins the special characters already stripped from a query before it is run.

This matters more than a stray character because the meaning-based search runs the word-based search
alongside it, so the error took the whole search down — on the path the agent uses to check whether
it already knows something.

## Evidence

Measured against the running agent (v1.3.1012, 2,930 stored entities):

| query | result |
|---|---|
| `why can a telegram bot not see another bot's messages` | `fts5: syntax error near "'"` on both search routes |
| the same query with the apostrophe removed | 20 results, the correct entity **ranked first** |

Verified by reverting, because a passing test proves nothing: with the apostrophe left out of the
strip list the two new tests FAIL (`2 failed | 16 passed`); with it in, **18 pass** in that file and
**76** across five memory suites, with `tsc --noEmit` clean.

No results are lost by stripping it — the engine already splits words at the apostrophe, so
"bot's" and "bots" produce identical search terms. The tests assert the word itself SURVIVES, since
the lazy way to stop the error would be to discard the whole term.

## What to Tell Your User

Your agent checks its own memory before answering, so it does not re-discover things it already
worked out. That check was fed your question exactly as you asked it — and if your question happened
to contain an apostrophe, which most natural questions do, the search failed outright instead of
looking.

It now handles those questions normally. Nothing about what it remembers has changed; it can simply
reach it again.

## Summary of New Capabilities

- Memory search accepts questions containing apostrophes instead of failing on them.
