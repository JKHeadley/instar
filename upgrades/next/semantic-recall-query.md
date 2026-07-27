## What Changed

Fixed a silent failure that made the agent's memory recall return nothing for essentially
every question it was asked.

Before answering, the agent searches its own memory store and injects anything relevant as
context. That search required **every** word of the query to appear in a stored entry —
FTS5's implicit AND over bare tokens. Recall is fed the user's raw message, which is always
a sentence, so ordinary function words decided the outcome. No stored entity contains the
word "why", so any question beginning "why" matched nothing regardless of its content words.

`SemanticMemory.search()` now strips stopwords before building the match expression, and
falls back to an OR of the content words when the strict AND match returns zero rows. The
strict query runs first and stays authoritative whenever it finds anything, so keyword
searches are unchanged and the widening only ever replaces an empty result.

The failure was invisible by construction: an empty result set is indistinguishable from an
empty memory. No error, no warning, no slow query — the system reported healthy while
returning nothing indefinitely.

## Evidence

Tests were run against **unmodified source first**, to prove they exercise the bug:

| run | result |
|---|---|
| fix reverted | **9 failed / 4 passed** — the 4 are the regression guards |
| fix applied | **13 passed** |
| semantic-memory regression surface | **5 files, 126 passed** |
| `tsc --noEmit` | clean |

Verified against the live 2,852-entity store, not only fixtures:

```
"can I reach Codey"                        0 → 5 hits
"is Codey responding to my messages"       0 → 5 hits
"why can a telegram bot not see messages"  0 → 5 hits, top hit "Telegram bot visibility limit"
```

That top hit is an entity stored on 2026-07-19 which never surfaced and was re-derived from
scratch on 2026-07-27 — the incident that prompted the fix.

## What to Tell Your User

Your agent's memory has been storing things correctly all along, but the part that looks
things up was almost never finding them — so lessons it had genuinely learned would quietly
fail to come back, and it could re-discover the same thing weeks later as though it were new.

The cause was mundane: the lookup demanded that every word of the question appear in a
stored note, including words like "why", "is" and "the". Since no note contains the word
"why", any question starting with "why" found nothing at all. Questions are the only thing
this system is ever given, so it was returning empty almost every time.

Ordinary connecting words are now ignored when searching, and if the precise search finds
nothing the agent retries with a looser one. Precise matches still win whenever they exist,
so this makes recall find more without making it noisier — and a question about something
genuinely not in memory still correctly returns nothing.

You don't need to do anything. Recall simply starts working where it previously came back
empty.

## Summary of New Capabilities

- Memory recall now answers natural-language questions instead of returning empty for any
  query containing ordinary function words.
- A looser fallback search runs only when the precise search finds nothing, so existing
  keyword lookups keep their exact previous behaviour and precision.
- Queries about genuinely unknown topics still return no results — the fallback widens the
  search without inventing relevance.
