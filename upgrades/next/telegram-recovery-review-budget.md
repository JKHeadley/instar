# Bound queued Telegram review costs

<!-- bump: patch -->

## What Changed

Automatic Telegram recovery now records a 15-minute interval per original queued
operation before entering outbound review or delivery. Failed reviews and
pre-dispatch refusals previously left the operation immediately recoverable,
causing another paid review on each recovery pass without consuming a transport
attempt. Upgraded recovery processes using the same canonical outbox share the
durable interval, which survives process and worker restarts. Current policy is
still evaluated when due. The recovery-owner server must restart onto the patch;
installing package files alone does not change a running process.

The existing origin audit exposes recovery starts and the next eligible time.
Original payloads, delivery deadlines, child attempt limits and uncertain-result
fences are preserved. Existing agents receive the behavior and awareness on update.

## What to Tell Your User

Queued Telegram messages now wait at least 15 minutes between automatic recovery
attempts, instead of repeatedly spending review tokens while sending is broken.
Restarting an agent does not restart this spending loop. This mitigates repeated
review costs; a queued message is still not a guarantee of delivery.

## Summary of New Capabilities

- The existing origin audit shows `recovery.attempts` and `recovery.nextAttemptAt`.
- No configuration change or queue clearing is required.

## Evidence

Real worker tests cover concurrent owners, restart, re-admission, exact interval
boundaries, original deadline and transport budgets, uncertain results and fair
selection. HTTP tests count reviews through the actual outbound evaluator and
verify current-policy refusal and eventual delivery on a due attempt. Production
boot tests exercise the persisted interval through shutdown and restart.
Final validation results are recorded in the side-effects artifact.
