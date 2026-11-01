# Planned restart and local PR checks — Plain-English Overview

> Planned maintenance waits for a running PR check to finish, then restarts before the next check begins.

## The problem in one breath

Two planned server restarts interrupted the same PR check on November 1. Together they discarded about 13 minutes of test work. The updater already knew to wait for a check, but other settings could request a restart directly through a file that the server supervisor consumed immediately.

## What already exists

- **PR verification** runs the full unit, integration, and end-to-end suites in a separate child process. It records that child in a small local state file and removes the record when the run ends.
- **Planned restart requests** use a local flag file. Both the background supervisor and the foreground server can act on that flag.
- **Updater hold** waits for a PR check when the updater itself requests a restart. It does not cover the other writers of the shared flag.

## What this adds

Both consumers of the restart flag now check the same live PR-run record before acting on a planned request. They leave the request in place while the child runs. The verifier also pauses its queue when a planned restart is waiting, giving maintenance the next turn instead of starting another long check.

## The safeguards

The record must name a live child process, except for a 30-second interval between recording the run and starting its child. A stale record cannot hold the restart. When a real check causes a delay before the request's original expiry, the consumer records proof tied to that particular request. An already-expired request cannot gain proof later. The wait ends after at most three hours from the request or the run start; only a proven delayed request remains deliverable for one more hour so the supervisor cannot discard it at the boundary. A request never delayed by verification keeps its original one-hour expiry. Explicitly forced restarts bypass the wait, and the updater's existing four-hour limit remains the final limit for updater requests. Unplanned crash recovery is unaffected. If a check is interrupted at a limit, the existing verifier records and retries that interruption; it does not call the partial run green.

## What ships when

This is one reversible code change with unit, integration, and end-to-end checks. It needs an independent second-pass review because it changes restart timing. No new setting, service, or user action is needed; installed agents receive it with the package release.

## What you actually need to decide

The operational rule is to let an ordinary planned restart wait for one active check, within the stated bounds, so completed test work is preserved.
