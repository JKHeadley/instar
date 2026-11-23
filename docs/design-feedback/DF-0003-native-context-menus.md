# DF-0003 · Native actions where the person right-clicks

Date: 22 November 2026, 13:26 PST. Source: Justin’s feedback relayed by Chief of Staff in message e6e0479a-e8d7-4db1-b1bb-c4c371093ada. The quoted request below preserves that relay; the packet does not contain a direct transcript of Justin’s wording.

Original owner captures remain in the private feedback archive. No original image or private conversation content is published here. This public-safe diagnosis preserves the Chief of Staff relay as a relay, rather than presenting it as a direct owner quote.

## Relayed Request
> On a chat: open in new window, pin/unpin, mute, close or archive, delete. On a message: reply, pin, copy text, copy link, forward, delete, select.

## Diagnosis
1. Mac chat rows have no general action menu. The few existing context menus operate on project groups, not individual chats.
2. Message bubbles expose read-aloud and make-card actions, while the native NSTextView supplies its own selection/link behavior. A menu added only to the outer SwiftUI bubble can miss right-clicks on the words themselves.
3. Server support is incomplete. The parity owner’s source and live audit separates existing pin/tombstone routes from missing mute/archive, structured reply, forward, message delete and device-safe per-message links. A conversation-only link cannot be labelled Copy message link.
4. Prior checks exercised left-click links and text selection but not the complete native context action on both text and bubble backgrounds.

## Rules And Sharpening
- DS-LAYOUT-10: actions sit with the thing they act on.
- DS-ACTION-3/6/7: destructive actions are distinct, controls state their effect and unsupported operations never become pretend actions.
- DS-DELIGHT-3 and DS-PARITY-5: native interactions give immediate feedback and match the stronger comparison.
- Missing rule at the time: pointer-based conversation surfaces expose context actions on the actual text/row hit target, with scope and available capabilities preserved. Local close is distinct from stopping or deleting; reply targets and message links retain message identity. The earned rule is DS-ACTION-8.

## Concrete Fix And Structural Checks
Use native menus with window/agent/row-scoped callbacks. Preserve read-aloud, card creation, links and selection. Add the requested actions against final signed-device contracts, with truthful feature/readiness/error states and cancellation for destructive operations. Test actual native menu opening over both words and background, selection, keyboard invocation, two windows, stale IDs, permissions, wrong machine, cancellation and platform mirror failures. Capture each menu at normal and large text.

Server owner: echo-telegram-parity-for-instar-chats. Mac UI/release owner: the Apple app rebuild owner. Close-window is local and does not stop the agent or change history. No existing conversation will be deleted as cleanup.

## Status
Diagnosis recorded. Existing server routes are documented by the parity owner; missing contracts are tracked there. Implementation, real action proof and release receipts remain required.


## Canonical Register Disposition

Earned rule: DS-ACTION-8. This record remains open. Adding a rule does not certify its implementation or release. The independent app and server owners retain the execution and proof requirements above.

The Apple owner reports that Mac build 133 shipped the bounded native menu/window/pin increment, with six native cases and normal installed update proof. This is not proof that every requested server-backed chat/message action exists. Remaining contracts and actual action evidence stay open; subsequent navigation releases do not close this item. The register did not independently repeat that native execution.
