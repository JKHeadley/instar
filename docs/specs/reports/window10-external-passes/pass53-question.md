# External review pass 53 — THE QUESTION, recorded before the reading

Twenty-third archived question. Held near-identical to passes 33–52: the series measures the tree, and a
brief that drifts measures itself.

## Frozen tree

CODE frozen at `173dc662e` on `echo/window10-deep-property-guards`. This question is archived in the
commit immediately after it, which adds ONLY this file — so the reading happens at that later HEAD and the
source under review is byte-identical to the frozen SHA. Clean, `local == remote` verified by command,
boundary lint clean, type check clean, 152 tests green across the seven guard suites.

You are reading the tree at `~/window13f-exam` on this machine (a copy of the branch; no git metadata).
Paths in the brief below are relative to that directory. Note the directory NAME changed again — older copies of previous trees are still on this machine and
are NOT the tree under review.

## What changed since pass 52

Pass 52 returned UNSOUND at 2 NEW (0 DESIGN, 2 PRECISION), both in the rich source reduction. Series on
this instrument: 3, 1, 2, 2.

1. **Tag stripping is now a SCANNER that tracks quote state**, not `/<[^>]*>/g`. The regex stopped at the
   first `>` even inside a quoted attribute, leaving the rest of the attribute source in the leaf to count
   as visible content. A scanner rather than a cleverer pattern on purpose: the nested-quantifier regex
   that handles quoted attributes is also the shape that backtracks catastrophically, and this runs on
   every outbound message.

2. **The direct-media matcher now recognises `video` and `audio`, not only images.** Pass 52 recorded this
   as an OVER-refusal and deliberately did not count it, because it destroys visible sends rather than
   leaking invisible ones. It was introduced in the same commit that named that failure direction.

Pass 52's finding 2 — media waivers matched against raw source rather than parsed rendering positions —
is NOT closed. It is an instance of the root named below.

## THE NAMED ROOT, and what this reading is asked to do about it

Recorded in the source at the reduction itself, one commit BEFORE pass 52 ran, and confirmed by it: every
finding since pass 48 has the same cause. The reduction SUBTRACTS markup it knows about and treats the
remainder as visible — an open world, which can only ever remove the shapes someone thought of. Pass 52's
own words for finding 1 were that the pattern "is not a tokenizer", and for finding 2 that it is "the same
class as pass 50, but still present".

The structural fix — inverting the reduction to extract only what is provably rendered, the same inversion
this file already performed successfully for its character predicate — is DEFERRED with a stated reason:
it changes refusal semantics on a path where a wrong answer destroys a real message.

So this reading is asked for something more useful than a seventh instance. **If you find another instance
of that root, say so and name it as such rather than reporting it as a new class.** What would be genuinely
new: a finding OUTSIDE the rich source reduction, or evidence that the root is misdiagnosed, or a concrete
account of what the inversion would have to extract in order to be correct.

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

Read the real files under `~/window13f-exam`. Start from `src/messaging/telegram-egress.ts`,
`src/messaging/invisible-payload.ts`, `scripts/lint-telegram-egress-boundary.mjs`,
`src/messaging/TelegramAdapter.ts`, and `tests/unit/telegram-egress-boundary.test.ts`.

Write your report to `~/window13f-exam/PASS53-VERDICT.md` AND print it to stdout, with these sections:

=== VERDICT ===   SOUND or UNSOUND, one line, then why.
=== MAGNITUDE === NEW load-bearing findings, classified DESIGN or PRECISION, counted separately from
                  previously-stated-open items.
## FINDINGS      numbered, file:line evidence, concrete failure path each.
## REGRESSION-CHECK  one line per stated-open item.

Analysis only. Do not construct working evasions; describe the class and cite the line.

---
