# External review pass 52 — THE QUESTION, recorded before the reading

Twenty-second archived question. Held near-identical to passes 33–51: the series measures the tree, and a
brief that drifts measures itself.

## Frozen tree

CODE frozen at `b98c535b1` on `echo/window10-deep-property-guards`. This question is archived in the
commit immediately after it, which adds ONLY this file — so the reading happens at that later HEAD and the
source under review is byte-identical to the frozen SHA. Clean, `local == remote` verified by command,
boundary lint clean, type check clean, 150 tests green across the seven guard suites.

You are reading the tree at `~/window13e-exam` on this machine (a copy of the branch; no git metadata).
Paths in the brief below are relative to that directory. Note the directory NAME changed again — older copies of previous trees are still on this machine and
are NOT the tree under review.

## What changed since pass 51

Pass 51 returned UNSOUND at 2 NEW load-bearing findings (0 DESIGN, 2 PRECISION). The series on this
instrument reads 3, 1, 2 — low, oscillating, and NOT converging. Stated as such rather than as progress.

1. **Rich Markdown now has its HTML stripped before the visibility test.** Rich Markdown may carry
   ARBITRARY HTML and Telegram parses those tags as Rich HTML, so a tag name or attribute is markup here
   exactly as it is in the `html` arm. Counting those bytes as content let a markdown source whose only
   rendered text is invisible pass as visible.

2. **A declared media id must match EXACTLY, not as a prefix.** The embed pattern was
   `id=<declared>[^)]*`, so a declared `pic1` vouched for a reference to `pic1EXTRA` — a different,
   undeclared media that renders nothing. The id must now end where the declared one ends; a following
   parameter still counts.

## Where to attack, given what the last four readings found

Every finding since pass 48 has been in the rich-message SOURCE model — the markdown and html arms, the
media reference, the formula body — and none in the funnel or the serialisation. Four readings have now
each found something there that the previous one did not. Assume the same is true of these two repairs
and probe that model hardest: the arms' reduction rules, what each arm's syntax can carry that the
reduction does not remove, and anything the guard treats as content that Telegram treats as markup.

## Instrument

Passes 49-52 all run on `gpt-5.5`, and are comparable to one another; none is comparable to pass 48.

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

Read the real files under `~/window13e-exam`. Start from `src/messaging/telegram-egress.ts`,
`src/messaging/invisible-payload.ts`, `scripts/lint-telegram-egress-boundary.mjs`,
`src/messaging/TelegramAdapter.ts`, and `tests/unit/telegram-egress-boundary.test.ts`.

Write your report to `~/window13e-exam/PASS52-VERDICT.md` AND print it to stdout, with these sections:

=== VERDICT ===   SOUND or UNSOUND, one line, then why.
=== MAGNITUDE === NEW load-bearing findings, classified DESIGN or PRECISION, counted separately from
                  previously-stated-open items.
## FINDINGS      numbered, file:line evidence, concrete failure path each.
## REGRESSION-CHECK  one line per stated-open item.

Analysis only. Do not construct working evasions; describe the class and cite the line.

---
