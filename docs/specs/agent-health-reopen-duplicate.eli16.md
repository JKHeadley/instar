# ELI16 — a repeated health alert no longer retries forever

## What was wrong

When the agent notices a problem with itself, such as replies from another agent piling up because no session can start, it posts a heads-up in the "Agent Health" Telegram topic. If the same problem comes back later, it reopens the existing alert and posts a short "this came back" line.

Telegram messages pass through a duplicate check: the same text to the same topic within about 15 minutes is suppressed, because the person already has it. On 4 October, Luna's laptop tried to post the same "this came back" line every 30 seconds. Each try was correctly suppressed as a duplicate, but the code reported that suppression as a failure. The part of the system that raised the alert then thought the alert had not gone out and tried again 30 seconds later, for over 13 minutes, filling the log with "Attention write failed" entries.

## What changes

When the "this came back" line is suppressed because an identical copy was already delivered to that topic, the alert now counts as delivered, and the retrying stops. If the message is held for any other reason, such as the machine being unable to confirm it may send right now, it is still treated as a failure and retried as before.

## What you need to decide

This is a bug fix with no decision for the operator.
