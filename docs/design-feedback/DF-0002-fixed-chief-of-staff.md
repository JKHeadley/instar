# DF-0002 · Give the Chief of Staff a fixed primary place

| | |
|---|---|
| Entry | DF-0002 |
| Date of feedback | 2026-11-22, 13:26 PST (2026-11-22T21:26:25Z) |
| Card | Pending: commitment `CMT-2367` was recorded on 2026-11-27 from the source message; no Work Board card exists for it yet |
| Source message | Owner message `4597726001389351` in conversation topic `141385` (Chief of Staff), recorded 2026-11-22T21:26:25Z (13:26 PST), with three photos. The history marks it as from the owner, but its authorship field is empty and the id is not a Telegram message number, so authorship is left to the card path's sender check |
| Relay | The wording quoted under "Relayed Request" came through the Chief of Staff in message `e6e0479a-e8d7-4db1-b1bb-c4c371093ada` |
| Standard | `docs/DESIGN-STANDARD.md` |

Date: 22 November 2026, 13:26 PST. Source: Justin’s feedback relayed by Chief of Staff in message e6e0479a-e8d7-4db1-b1bb-c4c371093ada. The quoted request below preserves that relay; that relay packet held no direct transcript. The original message was found in the conversation history on 2026-11-27 and is quoted separately below, with its authorship caveat.

Original owner captures remain in the private feedback archive. No original image is published here; the only conversation text published is that original message. This public-safe diagnosis keeps the Chief of Staff relay as a relay, and does not present the original message as verified owner authorship.


## The original message (recorded as from the owner; authorship not verified)

The message (item 1 is this entry; the message also produced the other entries named after the quote):

> "We have a lot of work to do on the UI of the app:
>
> 1) The Chief of Staff conversation should, by default, have a clear, standalone position at the top of the list and look different from the rest. The UI should make it clear to the user that the Chief of Staff conversation is the unique, go-to, top level chat.
> 2) There are no right-click options on chats or messages like telegram
> 3) There are MANY very confusing conversations viewable that just say "App". I'm not sure what purpose these serve, but if they need to exist this is EXACTLY why we should have heirarchies of conversations"

The photos stay in the private archive.

## Relayed Request
> The Chief of Staff conversation must have its own fixed place at the top of the list, above Projects, and look different from every other chat, so it reads as the one top-level, go-to chat.

Chief added matching iPhone placement at 13:32 PST in 585ca63a-43e4-4e94-a568-21bef9124d68.

## Diagnosis
1. The flat Mac list inserts Projects before every conversation. MacConversations.swift puts projectsEntry before ForEach(shown). A pinned Chief can never precede that entry. The owner capture reproduces this exact order. Relates to DS-LAYOUT-6 (every screen can be reached at every size), applied here to the primary chat, and breaks the missing rule DS-LAYOUT-12.
2. The grouped list wraps the Chief in a Section but renders the same ConversationRowView with pinned:true. The role is reduced to pin decoration, so it remains visually interchangeable with ordinary chats. Breaks DS-DELIGHT-1 (the five-second test), DS-DELIGHT-4 (one shared role component) and DS-LAYOUT-12.
3. Both versions put the role inside scrolling list content. Pin order does not provide fixed primary navigation. Relates to DS-LAYOUT-9 (a refresh never moves the person), since a pinned row can scroll out of place, and breaks DS-LAYOUT-12.
4. The check missed a real-world flat/legacy server case. The live rich hierarchy route returns503, and the fallback is therefore a primary path, not an edge case. Why the check missed it: no check covered the flat fallback list; DS-LAYOUT-12 now names every list mode.

## Rules And Sharpening
- DS-DELIGHT-1: the main question is “Where do I ask my agent for help with anything?” A five-second view must make the primary chat obvious.
- DS-LAYOUT-6 and9: primary navigation remains reachable, with stable selection/focus through refresh.
- DS-DELIGHT-4 and DS-A11Y-1/2: shared role component, readable at maximum text, with explicit accessible identity.
- Missing rule at the time: a canonical go-to conversation has a distinct, fixed place before project containers in every list mode. Its status is independent of ordinary user pins. The earned rule is DS-LAYOUT-12.


## Rules this entry added or sharpened

| Rule | Added or sharpened | Problems |
|---|---|---|
| DS-LAYOUT-12 | Added | 1, 2, 3, 4 |

## Concrete Fix And Structural Checks
Resolve the primary chat only from the existing canonical pinned/hierarchy reference. Place a named primary region above the scrollable Projects/list content; exclude that canonical row from ordinary lists. Give it a distinct icon, role explanation, selected state and unread badge. Preserve the welcome-tour anchor. No title matching and no competing Chief flag. Implement Mac first, then the next iPhone build.

Tests cover canonical and impostor titles, missing/off-page refs, grouped/flat/search states, no duplicate role row, scrolling and refresh stability. Real native captures cover default, minimum width, maximum text and light mode. A new app-wide regression check verifies primary-before-Projects geometry and the role’s unique accessible identity.

## Status
Diagnosis recorded. The later sections record client releases; complete Mac/iPhone evidence review and closure remain open. No existing conversation changed or deleted.

## Earlier Mac Verification Record
The native fixture passed standard and minimum windows, maximum text at both widths, light, grouped, search, scrolling, ordinary selection across refresh, Space, Return and authoritative absence. The independent Codex review found sub-11-point purpose/count text at 85% scale; both fonts now clamp to 11 points. The final candidate's native matrix passed after that correction. Tour key isolation, full shared tests and numbered unread fit remain gates before release. iPhone proof remains open.


## Canonical Register Disposition

Earned rule: DS-LAYOUT-12. This record remains open. Adding a rule does not certify its implementation or release. The independent app and server owners retain the execution and proof requirements above.

The Apple app owner reports Mac version 0.5.1, build 132, released with a normal installed update at 22:38:28 UTC on 22 November. Its private release record is commit c32a00f, based on source b04220f. The report records 13 native navigation cases, seven tour keyboard cases and the shared suite with 1,152 executed, one skipped and zero failures. This register read the release record, but did not independently rerun those native checks. Matching iPhone size and maximum-text proof, TestFlight delivery and release verification remain pending; this record is not closed.

## Later Release Receipts

The Apple owner reports matching primary-conversation placement in iPhone 0.5.2 build 132, available in internal TestFlight at source b0621e6e0de8c9fa3eee5810ea93002760da94e3. Normal/minimum text checks and final maximum-accessibility checks are separately recorded in its private release evidence. App Store submission was reported as waiting for review; this register has no physical-device install or Store-approval proof.

The later Mac 0.5.2 build 137 installed normally from build 136 on the Laptop, with signature, Gatekeeper and eight-second reopen proof at 2026-11-23 09:53:33 UTC, according to the Apple owner. Its runtime source is bee1f46dd6e3c1c5cd7e849510967b6e6f74f5da. This updates the earlier pending-release snapshot above; the register did not independently replay the native runs or installed update. The entry stays open for its complete evidence and closure process. No existing conversation was moved or deleted.
