# Autonomous-run progress notes: failed sends explain themselves and stop repeating

## What Changed

During an autonomous run, the agent posts a short progress note in the run's topic when the topic has been quiet for a while. When that post failed, the agent tried again on the very next check, about once a minute, and wrote down only the type of error. On the Studio, one 43-minute problem with the agent's own local message route (Nov 24) became 100 failure records across three topics. Every record said only "TypeError", which is what Node's built-in fetch throws when a local request breaks before any answer arrives.

Now:

- Each failed post records a short, cleaned-up reason: the HTTP status and the message route's own words when the route answered, or the underlying connection error (for example ECONNREFUSED) when it did not. Secrets are scrubbed and the text is capped at 160 characters. The message itself is never recorded.
- After a failed post, that topic waits before trying again: 5 minutes, then 10, then 20, then at most 30, and the wait resets after the next post that works. The same outage now makes 4 failure records per topic instead of 43.
- If the route says the topic itself can no longer receive (Telegram reports the thread deleted or closed, or the chat gone), the agent records it once and then checks that topic only once an hour for the rest of the run, in case it is reopened. A new run in that topic starts fresh.

## What to Tell Your User

If something briefly stops the agent from posting its progress notes during a long autonomous run, it no longer tries every minute and fills its records with failures. It waits a little longer between tries, writes down why the post failed, and checks a closed or deleted topic only once an hour.

## Summary of New Capabilities

No new capability. The progress-note heartbeat records why a post failed, spaces out its retries, and checks a topic that can no longer receive only hourly.

## Evidence

Studio feature-evidence log, Nov 20–27: 107 "send failed" rows, 100 of them a TypeError, all from build 1.3.2010 between 2026-11-24 23:17 and 2026-11-25 00:00 UTC, on topics 147616, 130715 and 144319, about one per topic per minute. The same topics posted normally afterwards. Reproduced in tests/unit/autonomousHeartbeatSendError.test.ts: a fetch to a local port with nothing listening throws TypeError "fetch failed" with cause ECONNREFUSED, which the new description records. tests/unit/AutonomousProgressHeartbeat.test.ts replays the 43-minute, three-topic outage: before the fix, 43 attempts per topic; after, 4 per topic, and all three post on the first check after the route recovers. Over 4 hours, a topic refused with "message thread not found" gets one try plus three hourly re-checks and one error row, while the other topics keep reporting. A reopened topic posts again at its next re-check. The spacing tests fail on the old code.
