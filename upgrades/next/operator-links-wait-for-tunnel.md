# Operator links wait for the tunnel instead of sending localhost

## What Changed

Notices that send the operator a dashboard link no longer fall back to a `localhost` address when the agent has a tunnel that has not come up yet (for example in the first moments after a restart). They wait for the tunnel's public address and try again on their next pass. An agent with no tunnel still gets the local link, and a tunnel that stays down for 30 minutes falls back to the local link so the notice is not held forever. This covers the sign-in repair reminder, the sign-in repair notices, the feedback factory's "things that need you" list, and the deferral-ratification message (which used localhost even with the tunnel up).

## What to Tell Your User

Links I send you about something that needs you will open on your phone. Right after I restart, a notice may arrive a few minutes later than before, because I now wait for your public dashboard address instead of sending one that only works on my machine.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|------------|
| Notice links wait for the public dashboard address | Automatic |

## Evidence

Founding case: 2026-11-09 20:40 PST, the sign-in repair reminder fired right after a server restart, before the tunnel was up, and sent `http://localhost:4042/dashboard/console/#/capacity/accounts?s=needs`. Tests: `tests/unit/operator-link-origin.test.ts`, `tests/unit/subscription-relogin-approval-reminder.test.ts`, `tests/unit/feedback-factory/triage-service.test.ts`, `tests/unit/feedback-factory/execute-service.test.ts`.
