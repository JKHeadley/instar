# Side-Effects Review — Reading in the dashboard clears the phone's unread count

**Version / slug:** `dashboard-read-markers`
**Date:** `2026-11-08`
**Author:** `echo (M5 Pro builder, topic 134088)`
**Second-pass reviewer:** `not required`

## Summary of the change

Opens `POST /mobile/conversations/read` (docs/specs/mobile-unread-messages.md §3.5) to browser devices by adding it to `BROWSER_ROUTES` in `src/server/mobilePairingRoutes.ts`, and makes the dashboard Conversations page report the newest shown message read. The page reports only from the focused, visible tab, and only when the position advances. It uses the same `{ref, id, atMs, machine}` contract and the same per-person marker as the phone. Files: `src/server/mobilePairingRoutes.ts` (one allowlist line), `dashboard/console/chats-model.js` (`positionOf`, `readRefOf`, `readMarkFor`), `dashboard/console/chats.js` (`maybeMarkRead`, called on paint and on window focus), tests.

## Decision-point inventory

- Whether a browser device may call a route — **modify** — one more route named in the closed browser allowlist.

---

## 1. Over-block

No block/allow surface added. The browser gains one route.

## 2. Under-block

The page reports the newest message shown as read when the conversation is open and focused, even if the operator has not scrolled to it. This is the same rule the phone uses (the conversation is open). A reader who opens a conversation and looks away clears its count; that is accepted, as on Telegram Web.

## 3. Level-of-abstraction fit

The marker logic, forwarding, access checks and the 60/min `read-marks` bucket all stay in the existing route and `ConversationUnreadService`. The browser is only admitted to them, and the client builds the same mark as the phone.

## 4. Signal vs authority compliance

- [x] No — this change has no new block/allow surface (it admits a device kind to an existing route, whose own checks stay in force).

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point.

## 5. Interactions

- **Shadowing:** the authenticator's browser check now passes this route; the person check, `conversationRef`, the route's `deviceMayUse` and the own bucket still apply.
- **Double-fire:** a phone and a browser of one person may both report; markers are forward-only, so reports from both converge.
- **Races:** one report in flight per open conversation, and only the focused tab reports.
- **Feedback loops:** a successful report refreshes the list once, which reads counts but does not report again, because the position did not advance.

## 6. External surfaces

The phone's unread counts and the app badge now drop when the owner reads in the dashboard. That is the intended change. No new routes, no new persistent state, and no notices.

## 6b. Operator-surface quality

1. **Leads with the primary action?** Unchanged; badges appear on list rows only.
2. **Zero raw internals?** Badges show a number only.
3. **Destructive actions de-emphasized?** Not applicable; no actions added.
4. **Plain language + phone width?** Badges reuse the `.chat-unread` style checked at 1280×728 and 390×844 in the #2966 live rehearsal, and the badge flow was driven live on a throwaway agent (below).

## 7. Multi-machine posture

Read markers are **replicated** (kind `conversation-read-marker`, unchanged). A report for a conversation another machine holds is forwarded once by the existing route using the row's `machine`, which the page sends.

## 8. Rollback cost

Revert the commit. Markers already moved stay moved (forward-only), and they mean what the owner read. No migration.

## Conclusion

Small and reversible. Covered by `tests/e2e/dashboard-read-markers-alive.test.ts`: a production-booted agent with an owner phone and an owner browser; the agent replies and the phone sees it unread; the browser reports it read; the phone sees 0. The test fails with the route closed (403). Also covered by `tests/unit/console-read-marks.test.ts` (the position rule and the one mark). Driven live on the throwaway agent: a reply in conversation A while B was open showed badge 1; opening A cleared it, and the server's count for the person was 0.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. No self-triggered controller added; the report is caused by the operator opening or focusing a conversation.
