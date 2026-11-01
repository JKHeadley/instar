# Side-Effects Review — Telegram user-seat allowance and Web K 684

**Version / slug:** telegram-userseat-allowance-1031  
**Date:** 2026-10-31  
**Author:** Echo desk  
**Second-pass reviewer:** browser_allowance_review (independent APPROVE recorded in desk ledger at 19:58 PDT)

## Summary of the change

The managed Telegram browser can send to one operator-directed destination outside the agent's bot chat when the operator configuration supplies the exact profile, account, chat, topic and decision reference. The existing origin store retains admission, receipt, recovery and duplicate prevention. The same source branch recognizes the reviewed Web K 684 asset set. Changed runtime files: OriginConfig.ts, TelegramOriginBoot.ts, types.ts and ReviewedWebKBuilds.ts. The driving spec is docs/specs/telegram-message-origin.md; Justin's user-seat direction is recorded in topic 102965 on 2026-10-30.

## Decision-point inventory

- Browser destination authorization in TelegramOriginBoot — modify: admits the exact configured user-seat destination in addition to existing own-chat routes.
- Browser allowance parser and matcher in OriginConfig — add: rejects malformed or broad values and compares all destination fields.
- ReviewedWebKBuilds — modify: accepts only the reviewed 684 asset names and digests through the existing enrollment canary.
- Origin store send/recovery outcome — pass-through: keeps the same operation and receipt rules.

## 1. Over-block

A legitimate new group or topic is held until an operator changes the exact local allowance. This is intentional for acting through Justin's browser identity. A malformed decision reference also holds. Ordinary bot sends are unaffected.

## 2. Under-block

A local operator who changes the configured allowance can authorize another exact destination. The code does not independently verify the semantics of the decisionRef string, so the operator-owned config and its audit trail remain an authority input. Origin enrollment, lease, account, and receipt checks still apply.

## 3. Level-of-abstraction fit

The parser validates structural identity and destination equality at the browser authorization boundary. It does not infer conversational permission from text. The operator decision sits in configuration; the origin store remains the authority for delivery and recovery.

## 4. Signal vs authority compliance

Exact field equality is a hard invariant at a typed boundary, as allowed by docs/signal-vs-authority.md. No fuzzy detector gains blocking authority. The reviewed build list is an exact executable identity gate backed by source-map review and an authenticated read-only canary.

## 4b. Judgment-point check (Judgment Within Floors standard)

The code does not decide whether a user-seat task is wise or complete. It enforces only the operator's recorded exact destination floor. The agent still judges the task and the observer still judges useful completion.

## 5. Interactions

A browser request must pass profile enrollment, account match, lease ownership, exact destination, origin store admission and receipt recovery. The first held operation recovered under its original ID after the runtime patch, producing one Telegram receipt. No second operation was issued.

## 6. External surfaces

Telegram Web is an external write. The origin store records the operation and platform receipt; failed or uncertain sends stay held and are not blindly repeated. Browser drift remains fail closed until a reviewed build is enrolled.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No new operator UI is introduced. The allowance is local configuration maintained by the desk from a recorded instruction; no raw identifiers are shown as a primary user-facing action.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: Justin's managed signed-in browser profile and its enrollment are on the Studio. The source capability ships to every machine, but the exact local allowance is configured only where that browser account is enrolled. It emits no separate notice or URL; origin delivery and receipt remain durable on the owning machine. A transferred topic needs a separately enrolled browser and operator configuration before it can send.

## 8. Rollback cost

Revert the source change and remove the local allowance to return to the prior own-chat browser authorization. Existing delivered receipts remain in the origin store; rollback must not resend them.

## Conclusion

The exact allowance is bounded to one enrolled profile/account/destination and keeps the existing origin receipt semantics. The independent code review approved the design; targeted unit and E2E passed. The full source suite was interrupted locally and remains a CI merge gate. Live message 699 was delivered once, but the resulting product task did not complete because its child worker was lost; that is a separate open failure.

## Second-pass review (if required)

The prior independent browser_allowance_review returned APPROVE for the exact allowance design, recorded in the 19:58 desk ledger line. No new concern was recorded for the subsequent comments and release fragment.

## Evidence pointers

- docs/specs/reports/telegram-message-origin-evidence/web-k-2.2-684-review.md
- docs/specs/reports/telegram-message-origin-evidence/user-seat-destination-1031.md
- Desk ledger 2026-10-31 19:58, 20:07 and 21:58 PDT
- Telegram origin operation f015a911-2af2-45ad-ab4b-71a8eded176b, platform message 699

## Class-Closure Declaration (display-only mirror)

Defect class: authorized user-seat browser destinations could be excluded by the bot-only own-chat authorization. Closure: exact operator-config allowance with unit and E2E coverage for acceptance and rejection, plus the existing origin receipt recovery. Web K drift remains separately covered by exact asset matching and enrollment canary.
