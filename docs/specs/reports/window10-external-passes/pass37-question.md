# External review pass 37 — THE QUESTION, recorded before the reading

Seventh archived question. Held near-identical to passes 33-36: the series measures the tree, and a brief
that drifts measures itself.

## Frozen tree

CODE frozen at `5da57afb1` on `echo/window10-deep-property-guards`. This question is archived in the
commit immediately after it, which adds ONLY this file — so the reading happens at that later HEAD and the
source under review is byte-identical to the frozen SHA. Clean (dirt 0), `local == remote` verified by
`git ls-remote`, boundary lint clean, no stray measurer process. Memory checked before dispatch: 23% RAM
free, ~1.07 GB swap headroom — the same conditions under which pass 36 completed.

## What changed since pass 36

Pass 36 returned UNSOUND at 9 (5 DESIGN, 4 PRECISION). **Three of those were real bypasses in the egress
door introduced one increment earlier.** All are now closed:

1. **The door was one encoding wide.** It examined only a non-empty string body; Telegram also accepts
   parameters in the URL query, as form encoding, and as multipart. It now gathers parameters from the
   query AND the body, parses JSON and form encoding, and REFUSES a shape it cannot read (multipart,
   streams) rather than forwarding it.
2. **Case.** URL and method matching were case-sensitive while Telegram's dispatch is not. The URL regex
   is now case-insensitive and the method is canonicalised before the field lookup.
3. **The closed-world method check had been deleted by the move.** The door now REFUSES an unclassified
   Bot API method. Verified against the live tree: all 17 methods used in `src/` are classified (4
   reader-visible, 13 bodyless), so no existing sender is broken by the refusal.
4. **The lint saw only a bare identifier `fetch`.** It now also recognises a property-access call
   (`globalThis.fetch`). Sabotage-verified.

Four groups of false claims were corrected against derived values: comments describing pre-format calls
that had been deleted, a comment naming a deleted lint as the closed-world enforcer, the spec declaring
CMT-1246 both shipped and pending, the spec's predicate omitting `\p{M}`, a fixture inventory claiming 8
non-printing and 5 positive controls where the file holds 7 and 10, and route diagnostics naming two of
five refusal classes.

## STATED OPEN — attack the openness, do not rediscover it

1. **The rendering shortcut still OVER-refuses.** The HTML branch strips tag-shaped substrings without
   establishing Telegram would accept them, so malformed tag-shaped text plus one invisible node is
   refused although a reader would see it after Telegram's parse fallback. NOT fixed — deciding it needs
   Telegram's parse result. The false claims about it ("true without qualification", "the reader provably
   receives nothing") were corrected. Rides CMT-1260 with the symmetric under-refusals.
2. **One per-sender guard survives.** The tokenless-standby relay hands the message to ANOTHER MACHINE,
   so this process never makes the request and the door cannot see it.
3. **The codepoint table is not vendored.** The predicate uses runtime `\p{...}` escapes, so its verdict
   depends on the host's Unicode version. CMT-1261.
4. **The relay refusal/unreachable conflation is located, pinned, not fixed.** `relayOutbound` treats only
   422 as a refusal. CMT-1247.
5. **The lint does not catch a blinded door**, and does not resolve a `fetch` bound to a DIFFERENT name.
   Both limits are stated in its header; the first reds tests instead.
6. **One test is deliberately red.** The family-audit assertion needs a real multi-reviewer convergence
   for Building and The Substrate. Editing the expectation would forge the acceptance it exists to prove.

## The question

Read the tree at the frozen SHA and answer: **is the guarantee — that no Telegram payload reaching a
reader as nothing can leave this agent — SOUND, and is every claim made about it in source comments, lint
output, tests and the spec TRUE of the code as written?**

Judge the claims as strictly as the code. A comment that overstates what its analysis performs is a defect
of the same kind as a missing check, because it is what a later reader will trust instead of re-deriving.

**Pay particular attention to the egress door itself.** Pass 36 found three bypasses in it one increment
after it was introduced and called complete. Assume the repairs above are similarly incomplete until the
code shows otherwise, and probe the shapes they do NOT enumerate.

Report a VERDICT (SOUND / UNSOUND), a MAGNITUDE (count of load-bearing findings, classified DESIGN or
PRECISION), then the FINDINGS with file:line evidence and a concrete failure path, then a
REGRESSION-CHECK against the stated-open list above — for each, confirm it is still open as described, or
explain how the description is wrong.

Analysis only. Do not construct working evasions; describe the class and cite the line.
