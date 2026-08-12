# External review pass 50 — THE QUESTION, recorded before the reading

Twentieth archived question. Held near-identical to passes 33–49: the series measures the tree, and a
brief that drifts measures itself.

## Frozen tree

CODE frozen at `b1f310b63` on `echo/window10-deep-property-guards`. This question is archived in the
commit immediately after it, which adds ONLY this file — so the reading happens at that later HEAD and the
source under review is byte-identical to the frozen SHA. Clean, `local == remote` verified by command,
boundary lint clean, type check clean, 147 tests green across the seven guard suites.

You are reading the tree at `~/window13c-exam` on this machine (a copy of the branch; no git metadata).
Paths in the brief below are relative to that directory. Note the directory NAME changed again — older copies of previous trees are still on this machine and
are NOT the tree under review.

## What changed since pass 49

Pass 49 returned UNSOUND at 3 NEW load-bearing findings (1 DESIGN, 2 PRECISION).

1. **The formula body-content test now has ONE definition used by all three representations.** It had
   reached the `markdown` and `html` arms and NOT the explicit structured discriminators, which stayed
   unconditionally opaque — so an invisible formula written as markdown was refused while the identical
   formula written as a block or an inline wrapper vouched for the message around it. That was the FIFTH
   instance in this window of a repair applied to one representation of its own class, so the repair is a
   shared `formulaScan` function rather than a third matching line.

2. **The plain-language companion no longer describes the deleted per-sender architecture as current.** It
   had told a reader that each sender is checked individually and that the single door was still owed
   rather than shipped. Corrected, with what it replaced recorded rather than silently overwritten.

3. **NOT closed, and stated:** a formula whose LaTeX source carries characters but renders no glyph still
   delivers. Deciding it needs a renderer this code cannot supply. What IS closed is its ability to vouch.

## Also open, found while pinning that repair rather than by a reading

A structure whose ONLY content is an empty-bodied formula still delivers: it yields no leaves, and the
no-leaf rule allows. The walk cannot yet tell "understood, and renders nothing" apart from "not
understood" — both return the same state. The test for it asserts the behaviour that EXISTS rather than
the refusal that would be preferable, deliberately.

## Instrument

Pass 49 and this reading both run on `gpt-5.5`; the configured `gpt-5.6-sol` died twice on capacity at
~165K and ~244K tokens and could not be resumed. Passes 49 and 50 are therefore comparable to EACH OTHER
and neither is a comparable next point after pass 48.

## Stated open, and NOT claimed closed

Confirm or refute each; do not recount them as new.

- Redirect crossing is classified once, from the initial URL, and the final fetch still follows redirects.
  Left open as a STATED JUDGMENT with reasoning in the door's header.
- Body encoding is inferred from the JavaScript wrapper rather than from `Content-Type`.
- Any duplicated top-level JSON key makes the whole body unreadable before relevance is considered.
- `answerCallbackQuery` and `editForumTopic` classifications remain product judgments, not mechanical facts.
- A Local Bot API Server endpoint is outside both runtime and lint recognition; both hard-code the cloud host.
- The multipart claim and the single-read claim in the door's own prose were each called false by pass 47.
- Structured content is inspected only in its JSON-body representation; query, form and multipart
  collection leave the rich structure as a serialised string.
- The lint's host prefilter depends on literal source text rather than URL semantics.
- No-leaf structures are ALLOWED. The union now distinguishes a variant that renders nothing (an anchor)
  from one this guard cannot read (media, a custom emoji, a formula) — judge whether that distinction is
  carried far enough, and specifically whether a structure PROVEN to render nothing should still be allowed.
- One test is deliberately red: the family-audit assertion needs a real multi-reviewer convergence.
  Editing the expectation would forge the acceptance it exists to prove.

## The question

Read the tree at the frozen SHA and answer: **is the guarantee — that no Telegram payload reaching a
reader as nothing can leave this agent — SOUND, and is every claim made about it in source comments, lint
output, tests and the spec TRUE of the code as written?**

Judge the claims as strictly as the code. A comment that overstates what its analysis performs is a defect
of the same kind as a missing check, because it is what a later reader will trust instead of re-deriving.

**Every reading since pass 36 has found a bypass within one increment of this door being called complete**,
each from modelling the receiving server's behaviour on how this codebase happens to call it rather than on
what the API accepts. Assume the same is true of the repairs above — including, and especially, the
discriminator table, which is a transcription and could be transcribed wrongly or incompletely. Probe the
request shapes it still does not enumerate, and check the door's model against the server's documented and
implemented behaviour rather than against its callers.

Report a VERDICT (SOUND / UNSOUND), a MAGNITUDE, then the FINDINGS with file:line evidence and a concrete
failure path, then a REGRESSION-CHECK against the stated-open list above.

**Count NEW load-bearing findings separately from previously-stated-open ones, and do not recount the
latter.** Total findings conflate "this reading found fresh problems" with "these old ones are still
there", and only the first says whether the repairs are gaining.

Analysis only. Do not construct working evasions; describe the class and cite the line.

---

## Operating instructions

Read the real files under `~/window13c-exam`. Start from `src/messaging/telegram-egress.ts`,
`src/messaging/invisible-payload.ts`, `scripts/lint-telegram-egress-boundary.mjs`,
`src/messaging/TelegramAdapter.ts`, and `tests/unit/telegram-egress-boundary.test.ts`.

Write your report to `~/window13c-exam/PASS50-VERDICT.md` AND print it to stdout, with these sections:

=== VERDICT ===   SOUND or UNSOUND, one line, then why.
=== MAGNITUDE === NEW load-bearing findings, classified DESIGN or PRECISION, counted separately from
                  previously-stated-open items.
## FINDINGS      numbered, file:line evidence, concrete failure path each.
## REGRESSION-CHECK  one line per stated-open item.

Analysis only. Do not construct working evasions; describe the class and cite the line.

---
