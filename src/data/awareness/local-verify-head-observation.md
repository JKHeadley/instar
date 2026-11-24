---
title: Measuring a pull request’s wait for verification
---

Read `firstObservedAt` on the queue entry or on the exact revision returned by `GET /local-verify/record?pr=NUMBER&head=SHA&base=BRANCH`. Subtract this Unix millisecond timestamp from the parsed `finishedAt` timestamp for the observation-to-verdict duration. The clock starts when this coordinator first reads the revision on GitHub. Polling can miss the interval between a push and that read. Omit records with missing timestamps from duration summaries and count them separately.
