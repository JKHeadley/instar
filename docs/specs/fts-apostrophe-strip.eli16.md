# An apostrophe made the agent's memory throw an error

## What was broken

The agent searches its own memory to check whether it already knows something. That search is fed
the question exactly as it was asked — an ordinary English sentence.

English sentences contain apostrophes. "the bot's messages", "what doesn't work", "that's the one".

The search engine underneath treats an apostrophe as the character that opens a quoted string. So
the moment a question contained one, the engine hit what looked to it like an unfinished quote and
**threw a syntax error instead of searching**. Not a poor result — no result at all, and an error.

Measured live against the running agent:

- `why can a telegram bot not see another bot's messages` → **error**
- the same question without the apostrophe → the correct memory, **ranked first**

## Why it mattered more than it sounds

This was fixed a day after two other memory-search repairs, and it undid part of them. Those
repairs made the agent able to find a lesson from a natural-language question — which is the
whole point, because the alternative is re-discovering things it already learned.

But the meaning-based search runs the word-based search alongside it, so an error in the word-based
half took the whole search down with it. **The character most likely to appear in a real question
was the one that broke the search built to answer real questions.**

## What changed

One character added to the list of symbols already stripped out of a query before it reaches the
search engine.

The apostrophe now joins `* : " ^ { } ( ) . $ @ # ! ~ ? [ ]`, which were already removed for the
same reason — they mean something to the engine and nothing to the person asking.

**No search results are lost by removing it.** The engine already splits words at the apostrophe, so
"bot's" and "bots" produce the same searchable words either way. Stripping it changes only whether
the query is accepted at all.

## How I know it works

I broke it on purpose first. With the apostrophe left out of the strip list, the two new tests fail.
With it in, all eighteen tests in that file pass, and seventy-six across the memory suites.

The tests also assert something a stricter check might have missed: that the *word* survives. It
would be easy to "fix" this by throwing away the whole term, which would stop the error and quietly
lose the search. The tests require `bot` and `relay` to still be there afterwards.
