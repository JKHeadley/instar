# Messages to a renamed session reach the session holding that role

<!-- bump: patch -->

## What Changed

Same-agent messages (`POST /messages/send` with `to.session`) now reach the session that holds that role now, even after it came back under another name, such as `echo-echo-x` after a respawn or `echo-topic-N` after a reboot.

**How a session is chosen.** The resolver tries, in order:

1. the exact name;
2. the conversation (topic) the old name served;
3. the same stored name, for roles with no topic;
4. the same name with a doubled prefix collapsed.

It delivers only when exactly one running session fits. If two fit, it refuses and names both. It never types a message into a session that started after the message was written.

**Retries** stay on the session chosen first. If that session has since been replaced, the retry stops with the reason `resolved-session-ended`.

**Notices to the sender.** When a message can't be delivered, the session that sent it gets one notice. A notice lists the failed messages and why, and is marked as quoted data. A sender gets at most one notice per minute. Senders that aren't sessions are counted under `undelivered` in `GET /messages/stats`.

**Changes to `/messages/send`.** The server now sets `from.agent` and `from.machine` itself, and keeps what the caller sent in `from.requested`. The route refuses a caller-made `delivery-notice`.

**Session names.** New sessions whose name already starts with the agent's name no longer get the prefix twice.

**Retry scope.** Retries now touch only messages addressed to this machine. Before, the sending machine's own copy of a cross-machine message was retried into a local session with the same name.

## What to Tell Your User

- **Messages between my sessions survive restarts**: "When one of my sessions restarts under a slightly different name, the others' messages still reach it, and if a message truly can't be delivered, the session that sent it is told."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Messages reach a renamed session | Automatic; `GET /messages/:id` shows `delivery.resolvedSession` |
| Delivery notices to the sending session | Automatic |
| `undelivered` counter | `GET /messages/stats` |

## Evidence

Tests:
- `tests/unit/sessionAddressResolver.test.ts`: 16 tests covering every rule on both sides, ambiguity, freshness, stand-down and job runs.
- `tests/unit/messages-reach-renamed-sessions.test.ts`: 15 tests covering redirected delivery and the pin, refusal and notice, stale refusal, pinned retry then `resolved-session-ended`, cross-machine envelopes never retried, the notifier's grouping, loop and proven-sender rules, field cut, and `chooseTmuxName`.
- `message-router.test.ts` and `DeliveryRetryManager-runRecoveryCycle.test.ts`: 33 tests, unchanged and passing.
- Integration (`tests/integration/messages-reach-renamed-sessions-routes.test.ts`) and wiring (`tests/e2e/messages-reach-renamed-sessions-wiring.test.ts`) run in Local Verify.
