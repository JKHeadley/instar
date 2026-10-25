# Executor at a quieter minute — Plain-English Overview

> The one-line version: the part of the feedback pipeline that starts fix attempts now wakes at :17 and :47 instead of :00 and :30, so it stops being turned away by other jobs waking at the same moment.

## The problem in one breath

The fix-starter wakes up twice an hour. It woke at :00 and :30, the same moments as several other background jobs. Each of those jobs takes a seat in a small room that holds six. When they all arrived together the room was full, and the fix-starter refused to begin, because there was no seat left for the work it would start. On 2026-10-23 that happened at every single wake-up, so no fix was ever started.

## What already exists

- **The seat limit** — at most six of these background sessions at once. It protects the machine and stays exactly as it is.
- **The other jobs** — the feedback sorter (every 15 minutes), the report processor, the health check and grading, all on the hour and half-hour.

## What this adds

Only a new wake-up time. The fix-starter still wakes twice an hour, makes the same safety checks, and obeys the same limits. Two minutes after each sorter run, the ranked list it reads is fresh.

## The safeguards

Nothing is loosened. If the room is ever full at :17 it still refuses, exactly as before.

## What you actually need to decide

Nothing: this is a one-line timing change that can be reverted in one line.
