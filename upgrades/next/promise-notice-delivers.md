# Promise reminders reach the person

<!-- bump: patch -->

## What Changed

When the agent gives a promise a set time, it sends a reminder in that conversation, and if the time passes without delivery, a "this is late" line. With Quiet by Default on, both were labelled as routine automatic reports. They went into the Notifications feed instead of the chat, while the agent's records said they had been sent. They now carry their own protected label, "Promises made to you", and are delivered to the conversation, with a limit of 6 per conversation per 10 minutes against a runaway loop. A reminder that is held instead of delivered now counts as a failed send. It is retried and then marked undelivered with an alert, never recorded as "the person was told".

## What to Tell Your User

- **Promise reminders**: "When I give you a time and it passes, the note telling you it is late now actually reaches you in our conversation. Before, it could end up only in the Notifications list."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Check-in and late-promise lines are delivered under Quiet by Default | Automatic (still behind `commitments.checkInReminder.dryRun`) |

## Evidence

Live check CMT-1923 on Echo, 2026-11-18: CMT-1951's late line was counted sent at 15:44:49Z, but `notification-selectivity.jsonl` recorded `record / quiet-default / uncategorized` and the text sat in `quiet-notifications.jsonl`. Tests: `tests/unit/promise-notice-delivery.test.ts`.
