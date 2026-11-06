# Feedback sorting no longer stalls after a restart

## What Changed
After a server restart, the machine's ownership number moved ahead of the copy saved with the feedback queue. Sorting refused every model call until another job updated that copy, and it reported the refusal as "call-cap-reached" even with most of the daily limit unused. The pace tuner then slowed sorting because of that false limit. A current owner with unbroken tenure now carries the saved number forward when it reserves a call, as starting a drain run already does. Stale owners and other machines are still refused. "call-cap-reached" now appears only when a daily counter is really at its limit; any other refusal reads "authority-admission-refused".

## What to Tell Your User
Feedback sorting keeps moving after a restart instead of pausing and wrongly saying it hit its daily limit. No limits changed.

## Summary of New Capabilities
- Feedback sorting resumes on its next run after a restart, and its status names the real reason when a call is refused.

## Evidence
Unit: tests/unit/feedback-factory/triage-arbiter.test.ts (carry-forward failed before the fix; stale owner, foreign owner and spent cap stay refused) and tests/unit/feedback-factory/triage-service.test.ts (both reason labels). Echo's live log on 2026-11-06: all six false stops fell between a lease change and the next durable epoch write, with 24 of 150 calls used.
