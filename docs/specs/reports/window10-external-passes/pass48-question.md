# External review pass 48 — THE QUESTION, recorded before the reading

Eighteenth archived question. Held near-identical to passes 33–47: the series measures the tree, and a
brief that drifts measures itself.

## Frozen tree

CODE frozen at `df11339d1` on `echo/window10-deep-property-guards`. This question is archived in the
commit immediately after it, which adds ONLY this file — so the reading happens at that later HEAD and the
source under review is byte-identical to the frozen SHA. Clean, `local == remote` verified by command,
boundary lint clean, type check clean, 140 tests green across the six guard suites.

You are reading the tree at `~/window13-exam` on this machine (a copy of the branch; no git metadata).
Paths in the brief below are relative to that directory. Note the directory NAME changed from
`window12-exam` — an old copy of the previous tree is still on this machine and is NOT the tree under
review.

## What changed since pass 47 — all six addressed

Pass 47 returned UNSOUND at 6 (3 DESIGN, 3 PRECISION).

1. **The phantom `text` field** on the two rich-message methods is removed. They accept the rich structure
   only, and a field map that is too WIDE was handing the unreadable-body waiver a key the method never
   reads.

2. **The walker is no longer key-blind.** It reads the `type` discriminator and descends ONLY the fields
   that variant declares, so a member the server discards can no longer vouch for an invisible payload.
   The table is transcribed from the Bot API server's own request parser — `Client::get_rich_text`,
   `Client::get_input_page_block`, `Client::get_page_block_caption`, `Client::get_page_block_table_cell`,
   `Client::get_input_rich_message` — rather than from the prose reference or from memory.

3. **A mathematical expression is no longer counted as visible content.** It is LaTeX SOURCE, and its
   source characters are not its rendered glyphs. It is now OPAQUE: it cannot prove visibility and cannot
   be proven invisible. That required separating "I found no leaves" from "I cannot read this" —
   collapsing the two is what let a spacing-only formula license a send AND what destroyed a photo
   carrying an invisible caption.

4. **The grammar test used internal class names.** `richTexts`, `richTextBold`, `richTextPlain` and block
   type `math` appear nowhere on the wire; the server rejects every one. The test asserted it exercised
   the grammar while exercising a key-blind walk over nested strings. Rewritten against wire values.

5. **The `RichTextReference.name` "known ambiguity" was fabricated** and is deleted. The live schema says
   the displayed content is `text` and `name` is an identifier in both places, so the existing exclusion
   was already correct and the recorded tradeoff never existed.

6. **The closeout's classified-method population** said 17 (4 reader-visible + 13 bodyless) where the code
   holds 19 (6 + 13). Re-derived by command, along with the door's test count, which had also drifted.

## Found by self-audit before this reading, not handed over by pass 47

- **The container is a PRIORITY union**, not a merge: `blocks` ELSE `markdown` ELSE `html`. Invisible
  blocks beside a visible `html` sibling read as visible and rendered as nothing.
- **A method's reader-visible fields are a PRIORITY union too.** `editMessageText` reads `rich_message`
  whenever that key is present anywhere in the request and only otherwise reads `text`. The waiver
  accepted ANY mapped field from the query, so a visible `?text=` waived an unreadable body that was free
  to carry the rich_message actually sent — and, in the opposite direction, the visibility check judged
  EVERY present field, refusing a valid edit for a leftover the server discards. Both repaired together.

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

Read the real files under `~/window13-exam`. Start from `src/messaging/telegram-egress.ts`,
`src/messaging/invisible-payload.ts`, `scripts/lint-telegram-egress-boundary.mjs`,
`src/messaging/TelegramAdapter.ts`, and `tests/unit/telegram-egress-boundary.test.ts`.

Write your report to `~/window13-exam/PASS48-VERDICT.md` AND print it to stdout, with these sections:

=== VERDICT ===   SOUND or UNSOUND, one line, then why.
=== MAGNITUDE === NEW load-bearing findings, classified DESIGN or PRECISION, counted separately from
                  previously-stated-open items.
## FINDINGS      numbered, file:line evidence, concrete failure path each.
## REGRESSION-CHECK  one line per stated-open item.

Analysis only. Do not construct working evasions; describe the class and cite the line.
