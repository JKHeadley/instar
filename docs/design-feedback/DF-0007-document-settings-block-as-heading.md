# DF-0007 · A document's settings block showed as one giant heading

| | |
|---|---|
| Entry | DF-0007 |
| Date of feedback | 2026-11-21, 16:19:54 PST (2026-11-22T00:19:54Z) |
| Source message | Justin's Telegram message `146883` in conversation topic `141133`; human-authored, not forwarded |
| Card | `wc_83ef05e62da1e1ba`, "Document page shows a spec's settings block as one giant bold heading", filed with the documents project on 2026-11-21 |
| From | Justin, in the context budget conversation |
| Screen | The document page, opened from Telegram on a phone |
| Surfaces | The web document page, opened in Telegram's in-app browser on a phone; the same server renderer feeds every surface that shows documents |
| Screenshot | Kept in the agent's private store, not in this public repository. It shows a draft constitution article: the page title and version picker, then a full phone screen of large bold text made of the draft's settings lines (title, short name, author, status, who requested it with a quoted message, a relayed priority note). The article's own text does not begin on the first screen. |
| Standard | `docs/DESIGN-STANDARD.md` |

## The owner's words

> "Some quick feedback that needs to go to the appropriate project
>
> The formatting of this document looks really terrible right now and I'm not sure what caused that"

## What happened

The draft was written the way spec files are written: it began with a settings block, a line of three dashes, a list of `name: value` lines, and a closing line of three dashes. The document page does not recognise that block. Its renderer (`src/documents/render.ts`, which uses the `marked` reader) reads the first dashes as a divider, which the renderer then draws as nothing, and the closing dashes as the underline of a heading, so every settings line became one second-level heading. Reproduced on main `c738629b9` on 2026-11-27 with the repository's own reader: it returns a divider, then one heading whose text is all of the settings lines joined, then the real title.

The session that published it fixed that one document on 2026-11-21 by republishing it without the settings block, and filed the renderer fix with the documents project (card above). The renderer itself was unchanged on main when this entry was written, so the next spec published with a settings block will look the same.

## What is good

The page header itself was right: one title, a version picker and a short line saying where the document is discussed. No better version of this page exists to compare with; the bar is an ordinary well-set article.

## Problems found

Each problem cites the rule it broke and why that rule's check did not catch it. Three of the citations apply a rule written for screens of data to a document page by close analogy; that is noted where it happens. DS-WORDS-7 is added so that the document case has a rule of its own and a machine check.

1. **Settings shown as content, in the largest type on the page.** Lines meant for tools became the most prominent text on the page. Breaks DS-LAYOUT-11 (one header and one section-heading style: here a block of data took the section-heading style) by analogy, and the new DS-WORDS-7. Why it was missed: DS-LAYOUT-11 is a review rule, and nobody reviewed rendered documents. DS-WORDS-7's machine check now covers it.
2. **Line breaks lost.** Each setting should be its own line; they ran together, so names and values could not be told apart. Breaks DS-LAYOUT-8 (one thing per line, grouped by kind), written for lists of results and applied here by analogy. Why it was missed: review only, as above. Covered by DS-WORDS-7's check, which fails any heading spanning more than one source line.
3. **Internal terms and ids on screen.** Short names, session names, topic and message numbers and a relay note reached the owner as text. Breaks DS-WORDS-2 and DS-WORDS-3. Why it was missed: DS-WORDS-2's machine check scans the fixed strings in screen code against the internal-terms list; it never sees author content rendered at run time. DS-WORDS-7 closes this for settings blocks by keeping internal fields out of the owner's view; the DS-WORDS-2 check is not widened here, because ordinary documents may legitimately discuss internal terms.
4. **The title shown twice.** The page header shows the title; the settings block repeated it in other words. Breaks DS-DATA-5 (each fact appears once per item), written for a row or card and applied to the page by analogy. Why it was missed: review only. Covered by DS-WORDS-7, since a hidden or collapsed settings block no longer repeats the title in the body.
5. **The first screen held no content.** On a phone the owner saw only the header and the settings; the article was off screen. Breaks DS-DELIGHT-1 (the five-second test). Why it was missed: DS-DELIGHT-1 is a review rule, and no capture of a document page at phone size was ever reviewed. DS-WORDS-7's review part now requires the first screen at 390 x 844 to show the document's own text.
6. **Nobody looked before the owner did.** The document was sent for the owner's decision without a look at the rendered page. Breaks DS-DELIGHT-5. Why it was missed: DS-DELIGHT-5 is a review rule with no machine check, and the design check does not yet look at rendered documents at all. How the check gets fixed: the design check gains the DS-WORDS-7 machine check, which renders a fixed set of awkward documents through the real renderer on every change to the renderer or the document page, so this class fails before a person sees it.

The class of mistake: the documents page trusts that every input is prose. Any author text that a Markdown reader interprets differently from what the author meant (settings blocks, a paragraph directly above a line of dashes, a long run of text read as a heading) reaches the owner as broken formatting.

## Rule added

DS-WORDS-7 · Settings at the top of a document never show as its text. Earned from this entry.

## Concrete fix

For the documents project (card `wc_83ef05e62da1e1ba`):
- The renderer recognises a settings block at the very top of a document (three dashes, `name: value` lines, three dashes) and does not render it as content. It either hides it or shows it as a small, collapsed "About this document" table in secondary text, one setting per row, with internal-only fields (ids, slugs, session names) left out of the owner's view.
- A heading is built only from one source line. A paragraph that sits directly above a line of dashes renders as a paragraph, not as a heading. (The renderer draws nothing for a divider today; whether to draw one is the documents project's choice.)
- Regression checks: a document beginning with a settings block renders with no heading made from it; a paragraph above dashes renders as a paragraph; the first screen at phone size (390 x 844) shows the start of the document's own text.

For Design Standards: the design check gains the machine check named in DS-WORDS-7.

## Status

| | |
|---|---|
| Diagnosis | Complete, 2026-11-27 |
| Rules | DS-WORDS-7 added |
| One-off fix | The single document was republished without its settings block on 2026-11-21 |
| Renderer fix | Not started on main as of 2026-11-27; owned by the documents project, card `wc_83ef05e62da1e1ba` |
| Automatic check | Not built yet; specified in DS-WORDS-7 |
| Closed | No. Closes when a document with a settings block renders correctly at phone and desktop size and the DS-WORDS-7 check passes |
