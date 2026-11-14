---
title: Queue Pace
description: See whether work queues are catching up, holding steady, or falling behind using arrivals and completions over time.
---

A backlog count alone cannot show whether work is being finished faster than new work arrives.
Queue pace records both sides for feedback sorting, feedback fixes, maturation fixes, promises,
and self-improvement items. `GET /queue-pace` and the console Pace card show a plain verdict and
the reason when a queue is falling behind. Unknown or incomplete evidence is labelled as such.

## How the measurement works

`QueuePace` defines the interval calculations and verdicts. `QueuePaceAdapters` reads the existing
owners' records without changing them. `QueuePaceLedger` reconciles events with snapshots and stores
hourly measurements so a restart does not reset the trend. Together, these distinguish work that was
completed from work that merely left a queue for another reason.

## Optional extra sorting

`QueuePaceTuner` can request an extra feedback-sorting run when repeated measurements show that the
sorting worker itself is limiting progress. It is off by default, checks eligibility before each run,
and stays within the configured run and quota limits. The pace verdict is a measurement, not by
itself permission to run more work.
