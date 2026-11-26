# DF-0002 · Owner cards explain the decision and the button

| | |
|---|---|
| Entry | DF-0002 |
| Date of feedback | 2026-11-26 |
| From | Justin, in the Chief of Staff conversation |
| Screen | Work cards shown as owner requests |
| Surfaces | Work Board, Dashboard and companion apps |
| Evidence | Justin's descriptions of the cards in the Chief of Staff conversation; no private screenshot copied into this repository |
| Standard | `docs/DESIGN-STANDARD.md` |

## The owner's words

> "This is extremely hard to digest and is not clear at all why it needs me."

Justin also reported an internal technical card reaching him as if it needed his approval, with jargon and an incorrect claim about spending money. A separate sign-off card implied that the project was done even though its text pointed to a button on another screen. He described the broader problem as the card writer lacking enough project context to create coherent owner requests.

## Diagnosis

The card's first view did not say, in plain language, why the owner was being asked or what the button would do. Internal implementation terms displaced the decision. The card's meaning and its button's actual result were not checked together. Agent work and automated holds were also classified as owner work.

## Rules added

| Rule | Change |
|---|---|
| DS-ACTION-8 | Added: one plain first sentence explains why the owner is asked and what the button does; keep context to three short lines and put technical evidence under **Details**. |
| DS-ACTION-9 | Added: only a real, open decision belonging to this owner appears as an owner ask. Agent work, automated repair, uncertain outcomes and other people's accounts remain status information. Do not repeat an answered decision for the same revision. |
| DS-ACTION-10 | Added: the button acts on the exact item and revision described; opening another screen is labelled Review or Open, and a stale item is refused. |

## Checks before closure

1. At 390 px and 1280 px, a reader who has not followed the project can explain why the card needs the owner and what its main button will do from the collapsed card alone.
2. The visible card has no more than three short context lines; technical evidence appears only after opening **Details**.
3. The action test follows the button to its handler and verifies the exact item and revision before it acts. A replacement or already answered decision cannot be acted on.
4. Agent-only work, automated repair, uncertain outcomes, and another person's account do not appear as actionable owner requests.
5. The check runs against the Work Board renderer and card-writing guidance. A language model may flag or hold a card for review, but it cannot establish owner authority or action correctness without the authoritative source and handler.

## Status

| | |
|---|---|
| Diagnosis | Complete, 2026-11-26 |
| Rules | Added as DS-ACTION-8 to DS-ACTION-10 |
| Renderer and card-writing guidance | Not yet updated |
| Project-context pre-send check | Not yet implemented; must remain signal-first and dark until its source access and refusal behavior are verified |
| Closed | No. Close after the owner-facing renderer and writer guidance pass the checks above on every supported surface. |
