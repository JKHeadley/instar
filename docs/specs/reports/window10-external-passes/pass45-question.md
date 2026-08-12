# External review pass 45 — THE QUESTION, recorded before the reading

Fifteenth archived question. Held near-identical to passes 33-37: the series measures the tree, and a brief
that drifts measures itself.

## Frozen tree

CODE frozen at `04afb8e88` — pass-44 repairs applied.
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



## What changed since pass 38 — ALL SIX REPAIRED

1. The duplicate-key repair now covers all four encodings. Multipart takes the FIRST value; a JSON body
   with a repeated top-level key is REFUSED as ambiguous rather than resolved wrongly.
2. The path grammar is percent-DECODED and honours Telegram's documented `/bot<token>/test/<method>` form.
3. `URL` objects are normalised and checked; a `Request` object is refused (its body is not in `init`).
4. Redirect crossing is left open as a STATED JUDGMENT with reasoning in the door's header, not fixed.
5. and 6. The predicate claim was swept across all FOUR of its spellings (regex, abbreviation,
   capitalised prose, and the negated sentence). Two spec sections describing the deleted per-sender lint
   are marked superseded at their headings; the Lifeline's claim that the lint enforces its private funnel
   is narrowed to what the lint proves.

You are reading the tree at `~/window12-exam` on this machine (a copy of the branch; no git metadata).
Paths in the brief below are relative to that directory.



## What changed since pass 39 — all nine addressed

1. A Bot API request can carry its METHOD in a parameter; Telegram falls back to the first `method`
   argument when the path has none. The door now recovers it there, and REFUSES a token-root request
   whose method is nowhere as undecidable.
2. A terminal DNS root dot is normalised — it denotes the same host and `new URL()` preserves it.
3. The duplicate-key scanner DECODES keys before comparing, so `text` and `\u0074ext` collide as they do
   in `JSON.parse` and at Telegram.
4/6. An unreadable body no longer refuses a request whose reader-visible field is already supplied by the
   query — query values win, so the body cannot change what Telegram sends.
7. The Request-object refusal now emits a decision record before throwing.
5/8. The lint's file loop prefiltered case-SENSITIVELY (defeating its own case-insensitive recogniser),
   and its host marker missed the FILE-download host — three direct fetches it printed clean over. Marker
   widened, all three routed through the door.

Still open and NOT claimed: the method-classification semantics for `answerCallbackQuery` and
`editForumTopic` (pass 39 F4), and the byte-oriented-body refusal being decided from the JavaScript
wrapper rather than the media type (pass 39 F6, partial).



## What changed since pass 40 — all seven addressed

- The path extraction now MODELS Telegram's rather than matching a shape: strip an optional `test`
  segment, take the ENTIRE remainder as the method. The old regex took only an alphabetic prefix and
  backtracked so a test root resolved to the method `test`, hiding the parameter-method root case. The
  dead constant it left behind is deleted rather than kept as a decoy.
- The body is read ONCE and the outgoing request is rebuilt from the value that was inspected, so a
  getter or an intervening mutation can no longer show one body to the check and another to the network.
- The lint now scans `.js`/`.mjs`/`.cjs` as well as `.ts`, and recognises `fetch.call`, `fetch.apply`
  and computed `['fetch']` access.
- The spec/comment corrections from that pass are applied.

**Attack the repairs above.** Every reading for five passes has found the previous repair incomplete, and
twice the bypass sat in the gap between two tests that each looked complete on its own. Look for the
intersection cases, not the enumerated ones.



## What changed since pass 41

- **The body is FROZEN at capture, not merely read once.** Reading once was insufficient: a string is its
  bytes, but `URLSearchParams` and `FormData` are captured by REFERENCE, so a caller could let the door
  inspect an object and then mutate it before the send. Mutable bodies are now serialised to a string at
  capture. Pinned by a test that mutates the caller's own object mid-call.
- **The predicate sweep is finally complete.** The survivor across four readings was a historical passage
  still listing a lone combining mark among payloads that wrongly passed — contradicting the current
  predicate three sections below it, since `\p{M}` was admitted deliberately at passes 30-31.

## STILL OPEN from pass 41, recorded rather than quietly carried

- The door infers encoding from the JavaScript wrapper and body text rather than consulting `Content-Type`.
- A duplicated JSON key is refused as ambiguous even when the duplicate is irrelevant to the method's
  reader-visible field — an over-refusal.
- `answerCallbackQuery` is classified bodyless although it carries reader-visible `text`; `editForumTopic`
  is mapped unconditionally to `name` although an empty name legitimately preserves the current one.

**Attack the repairs.** Six readings running have found the previous repair incomplete, twice in the gap
between two tests that each looked complete. Probe intersections, and check the door's model of Telegram
against Telegram's documented behaviour rather than against its callers.



## What changed since pass 42

**The body freeze had a SECOND READ.** The outgoing request was built by spreading the caller's `init`,
which re-reads `body`; because the override was conditional on the captured value being defined, a getter
returning `undefined` first and a payload second put the SECOND read on the wire. The outgoing init is now
built explicitly and `body` is always set from the captured value, never re-read. Pinned by that exact
getter.

That is the THIRD level of one defect across three readings — check the wrong representation, capture a
mutable reference, re-read what you captured. **Assume a fourth level exists and look for it.**



## What changed since pass 43

**A method can now carry reader-visible content in MORE THAN ONE field.** `editMessageText` also accepts
`rich_message`; the field map was method-to-ONE-field and could not express that, so the second field was
invisible rather than missed. The map is one-to-many now, both checkers loop every field, and the
over-refusal guard requires the query to supply ALL fields before treating an unreadable body as harmless.
`sendRichMessage` and `sendRichMessageDraft` are classified rather than refused as unknown.

Verified against the LIVE Bot API documentation. Check the same way: **this codebase's model of Telegram
may be stale anywhere.** Look for other methods or fields the table does not know, and say so with a
documentation citation.



## What changed since pass 44

**Structured fields are walked to their TEXT LEAVES.** `rich_message` is an `InputRichMessage`, not a
string; the previous repair named the field in the closed-world table and then checked it with a string
test, so the table read as covering a field nothing inspected. Leaves are gathered from `html`,
`markdown`, and any nested `text`, with each leaf's format taken from its KEY rather than the request's
`parse_mode`. One visible leaf delivers; all-invisible refuses; no leaves is undecidable and allowed.
Urls, ids and type tags are deliberately not gathered.

**Also still open from pass 44 and NOT claimed:** the Local Bot API Server endpoint is outside both method
recognition and the boundary lint; the multipart, single-read, live-method-table and documentation claims
that reading called false.

**The pattern to attack:** twice now a repair has been the right idea in the wrong SHAPE, and in both
cases the artefact that was supposed to prove coverage (a test, a closed-world table entry) was what made
the gap invisible. Look for coverage that is asserted by structure rather than exercised by behaviour.

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

---

## Operating instructions

Read the real files under `~/window12-exam`. Start from `src/messaging/telegram-egress.ts`,
`src/messaging/invisible-payload.ts`, `scripts/lint-telegram-egress-boundary.mjs`,
`src/messaging/TelegramAdapter.ts`, and `tests/unit/telegram-egress-boundary.test.ts`.

Write your report to `~/window12-exam/PASS45-VERDICT.md` AND print it to stdout, with these sections:

=== VERDICT ===   SOUND or UNSOUND, one line, then why.
=== MAGNITUDE === count of load-bearing findings, classified DESIGN or PRECISION.
## FINDINGS      numbered, file:line evidence, concrete failure path each.
## REGRESSION-CHECK  one line per stated-open item.

Analysis only. Do not construct working evasions; describe the class and cite the line.
