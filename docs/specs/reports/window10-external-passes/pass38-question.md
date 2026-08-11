# External review pass 38 — THE QUESTION, recorded before the reading

Eighth archived question. Held near-identical to passes 33-37: the series measures the tree, and a brief
that drifts measures itself.

## Frozen tree

CODE frozen at `1630d26fd` (the question was first archived against `fa8ce60c9`; one further
commit landed before dispatch — a duplicate-key bypass found by self-audit — so the SHA is restated rather
than left describing a tree that moved) on `echo/window10-deep-property-guards`. This question is archived in the
commit immediately after it, which adds ONLY this file — so the reading happens at that later HEAD and the
source under review is byte-identical to the frozen SHA. Clean (dirt 0), `local == remote` verified by
command, boundary lint clean, no stray measurer process.

## What changed since pass 37

Pass 37 returned UNSOUND at 8 (6 DESIGN, 2 PRECISION). All eight repaired:

1. **Parameter precedence was backwards.** Telegram appends URL arguments before body arguments and its
   accessor returns the FIRST match, so on a conflicting key the QUERY value is sent. The door let the
   body overwrite the query. Query is now overlaid LAST, at every return path.
2. **The URL fragment was read as payload.** `fetch` strips it, so visible fragment text masked an
   invisible query value. Cut before collection.
3. **Method recognition matched raw text.** Spellings `fetch` normalises (explicit `:443`, leading
   whitespace, upper-case host) reached Telegram with every check skipped. Now parsed with `new URL()`.
4. **The lint's "confined" was FALSE about the live tree.** It could not resolve a URL built by
   concatenation, and `test-as-self.ts` held two direct Bot API fetches of that shape. Binary expressions
   are now resolved, the host mark is case-insensitive, and both calls are migrated through the door.
5. **Multipart was over-refused** on the false premise that `FormData` cannot be read without consuming
   it. It is now read; only genuine one-shot streams are refused.
6. **The door's own refusals were absent from the decision stream.** Two new rules —
   `unclassified-method` and `unreadable-request` — now emit through the sink before throwing.
7. **and 8. The unfinished sweeps.** The predicate was still documented as L/N/P/S in two further places
   and in route commentary describing the DELETED subtractive design; the deleted per-sender lint was
   still cited as the live enforcer in four places; the adapter claimed `fetch` is called once below it
   when it is not called there at all; the spec said convergence was still owed directly beneath its own
   convergence tag; the vendored table was assigned to the already-landed CMT-1246 instead of CMT-1261.
   Each swept by counting the population first; zero live citations remain.

9. **Repeated parameter keys** resolved to the LAST value while Telegram resolves them to the FIRST.
   Found by self-audit before this reading; both a bypass and an over-refusal came from that one line.
   Fixed at all three collection sites and pinned in both directions.

## STATED OPEN — attack the openness, do not rediscover it

1. **The rendering shortcut OVER-refuses.** The HTML branch strips tag-shaped substrings without
   establishing Telegram would accept them, so malformed tag-shaped text plus one invisible node is
   refused although a reader would see it after the parse fallback. Deciding it needs Telegram's parse
   result. Rides CMT-1260 with the symmetric under-refusals (encoded invisibles, emphasis delimiters).
2. **One per-sender guard survives.** The tokenless-standby relay hands the message to ANOTHER MACHINE,
   so this process never makes the request and the door cannot see it.
3. **The codepoint table is not vendored** — the predicate uses runtime `\p{...}` escapes, so its verdict
   depends on the host's Unicode version. CMT-1261.
4. **The relay refusal/unreachable conflation** is located and pinned by three tests, not fixed. Only 422
   is treated as a refusal. CMT-1247.
5. **The lint does not catch a blinded door** (that case reds tests instead), and does not resolve a
   `fetch` bound to a DIFFERENT name. Both limits are stated in its header.
6. **One test is deliberately red.** The family-audit assertion needs a real multi-reviewer convergence
   for Building and The Substrate. Editing the expectation would forge the acceptance it exists to prove.

## The question

Read the tree at the frozen SHA and answer: **is the guarantee — that no Telegram payload reaching a
reader as nothing can leave this agent — SOUND, and is every claim made about it in source comments, lint
output, tests and the spec TRUE of the code as written?**

Judge the claims as strictly as the code. A comment that overstates what its analysis performs is a defect
of the same kind as a missing check, because it is what a later reader will trust instead of re-deriving.

**Two passes running have found bypasses in the egress door within one increment of it being called
complete** — three in pass 36, three more in pass 37, each from modelling Telegram's behaviour on how this
codebase happens to call it rather than on what the API accepts. Assume the same is true of the repairs
above. Probe the request shapes they still do not enumerate, and check the door's model of Telegram
against Telegram's documented behaviour rather than against its callers.

Report a VERDICT (SOUND / UNSOUND), a MAGNITUDE (count of load-bearing findings, classified DESIGN or
PRECISION), then the FINDINGS with file:line evidence and a concrete failure path, then a
REGRESSION-CHECK against the stated-open list above — for each, confirm it is still open as described, or
explain how the description is wrong.

Analysis only. Do not construct working evasions; describe the class and cite the line.
