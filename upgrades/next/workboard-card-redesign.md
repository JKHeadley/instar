<!-- bump: patch -->

## What Changed

The dashboard's Work board card is redesigned. An opened card leads with who it is from, how long it has waited (in relative time), the title in large type and a one-sentence ask, with "Why you" as a quiet line. The recommendation is a highlighted callout with Done (filled) and Not important (outlined) right under it; Put on hold and Remove for good are plain text. The checklist shows a status mark per item (passes, needs you, not known, fails). Goal, the Chief of Staff's own words and the card's record fold under Details. The conversation shows as a chat panel, beside the content on wide screens and below it on phones. Board tiles show a status chip, the title, the ask, how long it has waited and one main button. A card's optional `brief` is used when the server sends it; otherwise the Chief of Staff's card text is split into those parts by a tested parser, which also drops the internal wait id, UTC stamp and Markdown escapes.

## What to Tell Your User

Cards on the work board are much easier to read now: what is being asked is at the top in plain words, the recommended next step has its button right under it, and the checklist shows at a glance what passes and what needs you. The card's conversation sits beside it.

## Summary of New Capabilities

| Capability | How to Use |
|---|---|
| Redesigned work board card and tiles | Automatic on the dashboard's Work page; open any card. |

## Evidence

18 new unit cases (the parser on the live card text byte for byte, a confirm card, the brief path, chips, button ranking, chat lines, and four page flows in jsdom), the existing Work page tests adjusted and green, plus the console copy, warning-path, refresh and operator-surface floors. Headless Chromium screenshots at 1280x728 and 390x844 in dark and light against a local mock, before and after; no horizontal scroll.
