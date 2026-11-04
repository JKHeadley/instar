# Side-Effects Review — Native conversations increment 3, review follow-up

**Version / slug:** `mobile-native-conversations-inc3-followup`
**Date:** `2026-11-02`
**Author:** `echo`
**Second-pass reviewer:** `not run (Tier 1; the independent review of PR #2586 produced these findings)`
**Tier:** 1 · 2 source files, 3 test files · one commit attempt.

## Summary of the change

Three low findings from the independent review of PR #2586 (docs/specs/mobile-native-conversations.md §4.4):

1. **Test only:** an e2e case boots the production AgentServer with a stub Telegram adapter whose `getOwnerUserId()` returns a number, proving the production `telegramOwnerPresent` check keeps the private-chat path (no dashboard approval).
2. **Wording:** the CLAUDE.md "Pairing a phone without Telegram" section said "my token alone cannot see it". That overstated the boundary: the agent can read `dashboardPin` from config. It now says the dashboard path only proves someone could unlock the dashboard, which is weaker than a private Telegram chat. Agents that already got the old line get it replaced in place (content-sniffed, idempotent) by `migrateClaudeMd`.
3. **Fail closed:** `MobilePairingService.pruneDashboardCodes` dropped only the shown plaintext when a device was no longer pending or the registry read threw; it now also drops the confirmation code (`svc.confirm.drop`), so no hidden code can remain confirmable.

## Decision-point inventory

- Dashboard-code prune — modify — when the shown code is dropped, the confirmable code is dropped with it (strictly narrower: can only cancel a pairing, never allow one).

## 1. Over-block

A transient registry read error during a prune now cancels that pending pairing's code; the operator asks for a new link. Accepted: the same read error already hid the code, so that pairing could not be completed through the dashboard anyway.

## 2. Under-block

None identified. The wording change states the existing boundary (mobile-device-keys.md §2.2) honestly.

## 3. Level-of-abstraction fit

The prune is the one place the dashboard code's life ends besides confirm/decline; dropping both copies there keeps them in step.

## 4. Signal vs authority compliance

- [x] No — this change has no new block/allow surface (it only removes a code that is no longer shown).

## 4b. Judgment-point check

No judgment point added.

## 5. Interactions

`leaseTick` and `isDashboardPending` both prune; both now also clear the matching confirm code. The Telegram path never has a dashboard entry, so its codes are untouched.

## 6. External surfaces

CLAUDE.md wording for every agent on update (one line). No route or response change.
- **Operator surface (Mobile-Complete Operator Actions):** no operator-facing action added or changed.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

## 7. Multi-machine posture

Unchanged: pending codes are machine-local by design (physical-credential-locality).

## 8. Rollback cost

Revert the PR. No state change.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable beyond the CLAUDE.md wording, which is refreshed in place by migration. No self-triggered controller added.
