# External review pass 49 — THE QUESTION, recorded before the reading

Nineteenth archived question. Held near-identical to passes 33–48: the series measures the tree, and a
brief that drifts measures itself.

## Frozen tree

CODE frozen at `39bef4f2a` on `echo/window10-deep-property-guards`. This question is archived in the
commit immediately after it, which adds ONLY this file — so the reading happens at that later HEAD and the
source under review is byte-identical to the frozen SHA. Clean, `local == remote` verified by command,
boundary lint clean, type check clean, 142 tests green across the six guard suites.

You are reading the tree at `~/window13b-exam` on this machine (a copy of the branch; no git metadata).
Paths in the brief below are relative to that directory. Note the directory NAME changed again — older copies of previous trees are still on this machine and
are NOT the tree under review.

## What changed since pass 48 — all three addressed

Pass 48 returned UNSOUND at 3 NEW load-bearing findings (2 DESIGN, 1 PRECISION), the lowest of the series.

1. **The formula repair reached one of three representations.** OPAQUE treatment applied only to the
   explicit `mathematical_expression` block, so the same formula written in the `markdown` or `html`
   container arm still had its raw LaTeX SOURCE counted as visible content. Formula regions are now
   removed from the visibility test in both arms, using the syntax the live reference gives: markdown
   `$inline$`, `$$block$$` and a ```math fence; html `<tg-math>`.

   **And the first version of that repair would have introduced a regression**, caught by its own negative
   control rather than by a reading. Removing formula regions and marking any formula-bearing source
   undecidable ALLOWS an invisible payload wrapped in a formula tag — a case the previous code refused.
   A formula now grants the waiver only when its OWN BODY carries content. The first version of THAT check
   tested the whole matched region, so the delimiters and the tag name supplied the content and every
   formula looked renderable; the bodies are now captured.

2. **A media declaration vouched without being referenced** — introduced one increment earlier, in the
   very change that closed the same defect one layer below. The API defines the `media` array as media
   SPECIFIED IN the source using `tg://photo?id=`, `tg://video?id=` and `tg://audio?id=` links, so an
   entry nobody references renders nothing. It now requires the pair — a declaration and a reference to
   its id — or a direct HTTP(S) media URL, which the reference says renders on its own.

   Found while writing that control: markdown image syntax left a bare `!` behind when the link was
   reduced, so an image whose destination carried the payload passed on the strength of its own
   punctuation. The reduction now consumes the image marker.

3. **`divider` was classified as rendering nothing.** It renders a rule. The runtime outcome was the same
   either way, which is why it was worth fixing: the stated-open work of refusing a structure PROVEN to
   render nothing depends on that distinction meaning what it says.

## Carried forward from pass 47's self-audit

- The container is a PRIORITY union (`blocks` ELSE `markdown` ELSE `html`), not a merge.
- A method's reader-visible fields are a priority union too: `editMessageText` reads `rich_message`
  whenever that key is present anywhere in the request and only otherwise reads `text`.

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

Read the real files under `~/window13b-exam`. Start from `src/messaging/telegram-egress.ts`,
`src/messaging/invisible-payload.ts`, `scripts/lint-telegram-egress-boundary.mjs`,
`src/messaging/TelegramAdapter.ts`, and `tests/unit/telegram-egress-boundary.test.ts`.

Write your report to `~/window13b-exam/PASS49-VERDICT.md` AND print it to stdout, with these sections:

=== VERDICT ===   SOUND or UNSOUND, one line, then why.
=== MAGNITUDE === NEW load-bearing findings, classified DESIGN or PRECISION, counted separately from
                  previously-stated-open items.
## FINDINGS      numbered, file:line evidence, concrete failure path each.
## REGRESSION-CHECK  one line per stated-open item.

Analysis only. Do not construct working evasions; describe the class and cite the line.
