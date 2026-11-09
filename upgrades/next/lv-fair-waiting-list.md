<!-- bump: patch -->

## What Changed

Local Verify now keeps a place in line for a pull request it turns away because its queue is full. Before, a refused pull request got only a `queue-full` row in the audit log, so when a slot opened, whichever pull request happened to ask next took it. Over 24 hours to 2026-11-07 18:44Z, 34 pull requests were refused 1,238 times; 30 got in after a median 77.6 minutes (longest 606.9), and 4 were still outside after a median 844.7 minutes.

Now every refusal adds the pull request to a waiting list, saved on disk and ordered by when it was first refused. When the queue drops below its cap, the pull requests refused earliest get the free slots; a newer one asking first is refused again (audit row `queue-full-waiting`). A pull request keeps its place only while it keeps being offered: one not offered for 30 minutes of running time while `main` is healthy holds nothing, one idle for 6 hours is removed, and closed, merged or already-recorded pull requests leave the list at once. A new push keeps the place. The list never holds a slot while the queue is empty or `main` is unhealthy. The admitted queue entry carries `firstRefusedAt`, which is also written to the `queued` and `started` audit rows, so the time spent waiting outside the queue can finally be measured. Admitting a fix past a full queue while `main` is red, the extra room for `merge-throughput` pull requests, and re-queuing a pushed head all work exactly as before. A failed pull request's one re-run on a new base is now spent only when it is actually admitted, never by a refusal. The one-time re-run of failed pull requests when `main` turns green again is not held back by the list.

## What to Tell Your User

When several pull requests are waiting for a local test run, they now get in roughly in the order they first asked, instead of whichever one happens to ask at the right moment. Long waits of many hours for an unlucky pull request should stop. There is nothing for you to do.

## Summary of New Capabilities

- A saved waiting list for Local Verify: pull requests refused for a full queue keep their place, oldest first, shown as `waiting` on the Local Verify read surface.
- `firstRefusedAt` on queue entries and audit rows, so time spent waiting outside the queue can be measured.

## Evidence

New tests: `tests/unit/localVerify/waitingListService.test.ts` (13 cases, including the one-shot red→green re-run and an explicit failure re-run not spent by a refusal; oldest waiter admitted first while a newer PR and a younger waiter are refused; two free slots; closed waiter removed on offer and by the tick sweep; a stale waiter cannot stall admission; empty queue never reserved; moved head keeps its place; list and `firstRefusedAt` survive two restarts with downtime longer than the stale window; unreadable file moved aside; throughput overflow and below-cap admission unchanged; keptPlace re-queue unchanged; main-red repair admission unchanged), `tests/unit/localVerify/waitingList.test.ts` (6 cases), plus route and lifecycle assertions. Every Local Verify test file passed on the final code: unit 36 files / 713 tests, integration 6 files / 32 tests, e2e 2 files / 17 tests. The full suite was not run locally (shared machine); the normal queue runs it.
