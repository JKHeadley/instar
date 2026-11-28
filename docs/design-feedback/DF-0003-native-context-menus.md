# DF-0003 · Native actions where the person right-clicks

| | |
|---|---|
| Entry | DF-0003 |
| Date of feedback | 2026-11-22, 13:26 PST (2026-11-22T21:26:25Z) |
| Card | Pending: commitment `CMT-2368` was recorded on 2026-11-27 from the source message; no Work Board card exists for it yet |
| Source message | Owner message `4597726001389351` in conversation topic `141385` (Chief of Staff), recorded 2026-11-22T21:26:25Z (13:26 PST), with three photos. The history marks it as from the owner, but its authorship field is empty and the id is not a Telegram message number, so authorship is left to the card path's sender check |
| Relay | The wording quoted under "Relayed Request" came through the Chief of Staff in message `e6e0479a-e8d7-4db1-b1bb-c4c371093ada` |
| Standard | `docs/DESIGN-STANDARD.md` |

Date: 22 November 2026, 13:26 PST. Source: Justin’s feedback relayed by Chief of Staff in message e6e0479a-e8d7-4db1-b1bb-c4c371093ada. The quoted request below preserves that relay; that relay packet held no direct transcript. The original message was found in the conversation history on 2026-11-27 and is quoted separately below, with its authorship caveat.

Original owner captures remain in the private feedback archive. No original image is published here; the only conversation text published is that original message and its later repeat, both quoted below. This public-safe diagnosis keeps the Chief of Staff relay as a relay, and does not present the original message as verified owner authorship.


## The original message (recorded as from the owner; authorship not verified)

The message (item 2 is this entry; the message also produced the other entries named after the quote):

> "We have a lot of work to do on the UI of the app:
>
> 1) The Chief of Staff conversation should, by default, have a clear, standalone position at the top of the list and look different from the rest. The UI should make it clear to the user that the Chief of Staff conversation is the unique, go-to, top level chat.
> 2) There are no right-click options on chats or messages like telegram
> 3) There are MANY very confusing conversations viewable that just say "App". I'm not sure what purpose these serve, but if they need to exist this is EXACTLY why we should have heirarchies of conversations"

A later repeat, also recorded as from the owner with authorship not verified, in the same conversation on 2026-11-25T05:46:12Z with two photos (message `op-079822cff786676b2202e17665f16ba5`): "right-clicking a message in the app does not have the same effect/menu as right clicking in telegram".

The photos stay in the private archive.

## Relayed Request
> On a chat: open in new window, pin/unpin, mute, close or archive, delete. On a message: reply, pin, copy text, copy link, forward, delete, select.

## Diagnosis
1. Mac chat rows have no general action menu. The few existing context menus operate on project groups, not individual chats. Breaks DS-LAYOUT-10 (an action sits with the thing it acts on) and the missing rule DS-ACTION-8.
2. Message bubbles expose read-aloud and make-card actions, while the native NSTextView supplies its own selection/link behavior. A menu added only to the outer SwiftUI bubble can miss right-clicks on the words themselves. Breaks DS-ACTION-8: the menu must open on the actual text as well as the bubble.
3. Server support is incomplete. The parity owner’s source and live audit separates existing pin/tombstone routes from missing mute/archive, structured reply, forward, message delete and device-safe per-message links. A conversation-only link cannot be labelled Copy message link. Breaks DS-ACTION-6 (every control says what it does) and DS-ACTION-7 (nothing shown that can never be used) unless missing contracts stay unoffered.
4. Prior checks exercised left-click links and text selection but not the complete native context action on both text and bubble backgrounds. Why the check missed it: no check opened a native context menu at all; DS-ACTION-8 now requires it on both hit targets.

## Rules And Sharpening
- DS-LAYOUT-10: actions sit with the thing they act on.
- DS-ACTION-3/6/7: destructive actions are distinct, controls state their effect and unsupported operations never become pretend actions.
- DS-DELIGHT-3 and DS-PARITY-5: native interactions give immediate feedback and match the stronger comparison.
- Missing rule at the time: pointer-based conversation surfaces expose context actions on the actual text/row hit target, with scope and available capabilities preserved. Local close is distinct from stopping or deleting; reply targets and message links retain message identity. The earned rule is DS-ACTION-8.


## Rules this entry added or sharpened

| Rule | Added or sharpened | Problems |
|---|---|---|
| DS-ACTION-8 | Added | 1, 2, 4 |

## Concrete Fix And Structural Checks
Use native menus with window/agent/row-scoped callbacks. Preserve read-aloud, card creation, links and selection. Add the requested actions against final signed-device contracts, with truthful feature/readiness/error states and cancellation for destructive operations. Test actual native menu opening over both words and background, selection, keyboard invocation, two windows, stale IDs, permissions, wrong machine, cancellation and platform mirror failures. Capture each menu at normal and large text.

Server owner: echo-telegram-parity-for-instar-chats. Mac UI/release owner: the Apple app rebuild owner. Close-window is local and does not stop the agent or change history. No existing conversation will be deleted as cleanup.

## Status
Diagnosis recorded. Existing server routes are documented by the parity owner; missing contracts are tracked there. Implementation, real action proof and release receipts remain required.


## Canonical Register Disposition

Earned rule: DS-ACTION-8. This record remains open. Adding a rule does not certify its implementation or release. The independent app and server owners retain the execution and proof requirements above.

The Apple owner reports that Mac build 133 shipped the bounded native menu/window/pin increment, with six native cases and normal installed update proof. This is not proof that every requested server-backed chat/message action exists. Remaining contracts and actual action evidence stay open; subsequent navigation releases do not close this item. The register did not independently repeat that native execution.
