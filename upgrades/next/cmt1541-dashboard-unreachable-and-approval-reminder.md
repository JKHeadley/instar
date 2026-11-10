# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Three dashboard fixes the operator asked for (CMT-1541).

- **Automatic sign-in repair section (Accounts page):** a machine whose setting is off, watching only, or "asks you first" no longer shows a greyed-out tick box. Its line says repairing without asking is off there and can only be switched on from that machine itself, because another machine is not allowed to raise it. The section intro says the same. The rule itself is unchanged.
- **Unreachable-machine notices:** every "couldn't reach this machine" line on the console (Accounts, Home, Schedule, Sessions, Who can reach me, Allowed, Machines) now says how long the machine has been out of reach and whether anything is working to reconnect it, for example "Couldn't reach Laptop for 12 min; reconnecting by itself." With no evidence it says so plainly. `GET /pool` rows carry a new optional `reconnect` field (`connected`, `retrying`, `retrying-slowly`, with `nextTryAt`) from the connection re-dialer when it runs; `GET /sessions?scope=pool` carries the same facts as `reach` on a machine that did not answer. "Who can reach me" no longer prints a raw machine id.
- **Approval reminder:** a sign-in repair waiting for the operator's approval longer than `subscriptionPool.assistedRelogin.approvalReminderHours` (default 4; 0 turns it off) gets one reminder per wait on the same attention row as its first notice, with a direct link to the Accounts page's "Needs you" list. It follows Quiet by Default, is never sent during the repair's night hours, and never approves anything.

Rollback: revert, or set `approvalReminderHours` to 0 for the reminder alone. No state to repair.

## What to Tell Your User

- **Clearer machine notices**: "When a machine can't be reached, the dashboard now tells you how long it's been and whether it's already reconnecting by itself."
- **Sign-in repair reminder**: "If a sign-in repair has been waiting for your OK for a few hours, I'll remind you once, with a link straight to it. I never approve it for you."
- **Repair setting rows**: "Machines whose automatic repair is off no longer show a tick box you can't use; they say it can only be switched on from that machine."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Approval reminder for waiting sign-in repairs | automatic; `subscriptionPool.assistedRelogin.approvalReminderHours` (default 4, 0 = off) |
| Reconnect status per machine | `GET /pool` → `machines[].reconnect` |

## Evidence

- Unit tests for the wording helper (both sides of each duration and fix-status branch, and the no-evidence case), the reminder (due/not due, once per wait, retry after a failed delivery, night hours, store failure), and the pool decoration; the console page tests were updated to the new wording.
- Integration: `GET /pool` carries `reconnect` from the coordinator's re-dialer view and omits it when the re-dialer is off.
- The self-action ratchet covers the reminder: one notice per wait however long the repair waits.
