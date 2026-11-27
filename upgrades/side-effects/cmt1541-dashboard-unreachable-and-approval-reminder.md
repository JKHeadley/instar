# Side-Effects Review — unreachable-machine notices, auto-repair "no tick box" rows, approval reminder

**Version / slug:** `cmt1541-dashboard-unreachable-and-approval-reminder`
**Date:** `2026-11-09`
**Author:** `echo`
**Second-pass reviewer:** `not required (no block/allow decision, no session lifecycle, no gate; the one self-triggered action is a once-per-spell notice on an existing attention row)`

## Summary of the change

Three operator-reported dashboard problems (CMT-1541, topic 33890), one change. Tier 1: a revert fully undoes it; no stored state is added.

1. **Automatic sign-in repair rows** (`dashboard/console/auto-repair-model.js`, `dashboard/console/accounts.js`): a row this page cannot change (a remote machine not set to "repair without asking") no longer shows a greyed-out tick box. Its reason line now says repairing without asking is off there and can only be switched on from that machine itself, because another machine is not allowed to raise it. The section intro says the same. The `owner-must-enable-here` result words match. The security rule in `SubscriptionReloginRemoteConfigure` is untouched.
2. **Unreachable-machine notices** say how long and whether anything is fixing it. Server: `GET /pool` rows gain `reconnect` (from the rope recovery prober's view already on `MultiMachineSyncStatus.ropeHealth`: `connected` / `retrying` / `retrying-slowly`, plus `nextTryAt`), via the new pure `decorateWithReconnect` in `src/server/poolRopeCondition.ts`. `GET /sessions?scope=pool` machine entries for a peer that did not answer gain `reach` (the same `/pool` fields). Client: new `dashboard/console/unreachable-model.js` builds one sentence shape ("Couldn't reach Laptop for 12 min; reconnecting by itself.") from `liveness` (direct or saved contact only), `ropeAllDownSince`, `ropeCondition` and `reconnect`; no evidence reads "(for how long is not known); not known whether anything is fixing it". Applied to Accounts (partial line + auto-repair unreadable row), Home (`unreachedLine`), Schedule, Sessions, Who can reach me (also stops printing a raw machine id), Allowed (safety-check rows), Machines (restart-care line). `machineIssue` recognises the new wording so those notes keep their "See machines" link.
3. **Approval reminder** (`src/core/SubscriptionReloginApprovalReminder.ts`, wired in `src/commands/server.ts`): a repair in `approval` mode waiting in `suggested` longer than `subscriptionPool.assistedRelogin.approvalReminderHours` (default 4; 0 = off) gets one reminder per waiting spell, through `telegram.createAttentionItem` with the SAME `conditionKey` as the first notice, so it refreshes that one attention row. Link: `<dashboard>/dashboard/console/#/capacity/accounts?s=needs`. Never sent inside `slowRetry.quietHours` (default 23:00-08:00 local). Never approves.

Also: CLAUDE.md template bullet + a content-sniffed `PostUpdateMigrator` patch (Agent Awareness, Migration Parity); config type `approvalReminderHours`; self-action registry entry `relogin-approval-reminder`.

## Decision-point inventory

- `SubscriptionReloginRemoteConfigure` owner-must-enable-here — pass-through (unchanged; only its words on screen change).
- Attention selectivity / Quiet-by-Default routing in `TelegramAdapter.createAttentionItem` — pass-through (the reminder rides it unchanged).
- No new decision point gates anything.

---

## 1. Over-block

No block/allow surface — over-block not applicable. The one UI removal (the disabled tick box) removes a control that could never act.

## 2. Under-block

No block/allow surface. What the notices still miss: when the rope recovery prober is off (the fleet default), `reconnect` is absent and the line says "not known whether anything is fixing it", even though ordinary pool reads keep re-dialing on their back-off. That is honest (nothing on the machine reports it) rather than a fabricated "reconnecting". When `liveness` has only a relayed heartbeat, the duration is "not known" by design: a heartbeat file is not a contact.

The reminder still misses a repair whose machine has no Telegram adapter (`telegram` absent): the same posture as the first notice; the Accounts "Needs you" section and Home's count still show it.

## 3. Level-of-abstraction fit

Right layer. The facts already exist server-side (`MachinePoolRegistry` liveness, `RopeHealthMonitor` condition, `RopeRecoveryProber` view); this exposes them on the existing `/pool` read the pages already fetch, and words them once in one client module instead of per page. The reminder feeds the existing attention path (one row per account x machine condition) instead of a parallel channel.

## 4. Signal vs authority compliance

Signals only. `reconnect` and the sentences are display. The reminder is a notice producer: it holds no authority, approves nothing, and delivery decisions (hold quiet vs push) stay with the selectivity layer.

## 4b. Judgment-point check

No competing-signals decision point is added. The threshold is a configurable cadence for a notice, not a judgment.

## 5. Interactions

- Attention lifecycle: the reminder reuses `subscriptionReloginConditionKey(episode)`, so `admitAttentionObservation` refreshes the existing row (changed text ⇒ one repost, reopened). The hourly `resolveSubscriptionReloginAttention` pass closes it on verified recovery exactly as before. A restart re-sends the identical text, which lands as an unchanged repeat (no repost).
- Slow retry re-offers: a re-offer enters `suggested` again, starting a new spell (new start time ⇒ new key), so it can be reminded again after the threshold — once.
- `/sessions?scope=pool` now calls `poolView()` lazily, only when a peer failed; no extra fan-out.
- `machineIssue` regex widened by one phrase; existing phrases unchanged.
- Home's internal-phrase guard (`console-home-one-answer.test.ts`, #2404) bars "No answer from"; the shared wording therefore uses "Couldn't reach", which Home already used.

## 6. External surfaces

- `GET /pool` rows gain optional `reconnect`; `GET /sessions?scope=pool` machine entries gain optional `reach`. Additive; absent when unknown. The phone app's `/mobile/machines` shares `poolView` and simply carries the extra field.
- Operator-visible text changes on seven console pages and one new attention notice. No push is added: Quiet-by-Default decides.

## 6b. Operator-surface quality

1. **Leads with the primary action?** Yes. The auto-repair section keeps "Turn on for ticked machines" as the primary button; rows that cannot be ticked no longer pretend to be part of it. The reminder's link opens the Needs-you section, where Repair is the row's button.
2. **Zero raw internals?** Yes, and improved: Who can reach me printed `<machineId> did not answer.`; it now names the machine or says "a machine with no name yet". No ids, enum values or reason codes reach the text (`retrying` etc. are mapped to words).
3. **Destructive actions de-emphasized?** No destructive action touched.
4. **Plain language + phone width?** Sentences are plain ("Couldn't reach Laptop for 3 hours; reconnecting by itself."). Rows without a box keep a same-width empty cell so text aligns at phone width; no new wide elements.

## 7. Multi-machine posture (Cross-Machine Coherence)

- `reconnect` / `reach`: proxied-on-read from THIS serving machine's view of each peer (its own prober and liveness evidence); the page is about reachability from the machine serving it, which is the question the notice answers. A peer that is unknown to the prober reads "not known".
- Approval reminder: machine-local BY DESIGN — each machine reminds only for its own episodes (`machineId === subscriptionPoolMachineId`), the same posture as the first "suggested" notice, so one episode yields one reminder, not one per machine. Held spell keys are in memory; restart safety comes from stable text on one condition row, not stored state.
- Generated URL uses the tunnel URL when present, else localhost, the same rule as the existing sign-in notice.

**Status surfaces:** `/pool` (whole pool, as seen from the serving machine; a dark prober ⇒ field absent ⇒ "not known"). No `/health`, `/capabilities` or `/channels` change.

## 8. Rollback cost

Pure code change. Revert and ship a patch. No persistent state, no migration to undo (the CLAUDE.md bullet is text; a reverted build leaves it harmlessly describing a reminder that no longer fires). Setting `approvalReminderHours: 0` turns the reminder off without a release.

## Conclusion

Ships as Tier 1. All three operator asks are met without changing any authority.

## Evidence pointers

- Unit: `tests/unit/console-unreachable-model.test.ts`, `tests/unit/subscription-relogin-approval-reminder.test.ts`, `tests/unit/pool-rope-condition.test.ts` (decorateWithReconnect), `tests/unit/console-auto-repair-model.test.ts`, and updated wording in the console page tests.
- Integration: `tests/integration/pool-routes.test.ts` — `/pool` carries `reconnect` from a live coordinator view; absent when the prober is dark.
- Ratchet: `tests/unit/self-action-convergence.test.ts` over the new `relogin-approval-reminder` entry.

## Class-Closure Declaration (display-only mirror)

- **`defectClass`**: `unbounded-self-action`
- **`closure`**: `guard`
- **`guardEvidence`**: `{ enforcementType: ratchet, citation: tests/unit/self-action-convergence.test.ts (SELF_ACTION_CONTROLLERS → relogin-approval-reminder), howCaught: under a repair that waits forever, the controller fires once per waiting spell (spell key held) and the count stays at 1 however long the horizon; a version that re-fired every pass would scale with the horizon and fail the bound }`
- Control-loop edge: the reminder's notice does not feed the predicate (only the operator's tap changes the episode state). Steady-state bound: 1 per spell, plus at most 1 absorbed repeat per server restart. Settling brake: the held spell key, and the attention row's unchanged-text de-duplication across restarts.
