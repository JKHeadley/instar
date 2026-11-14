# Window run liveness: heartbeat clock order and busy sessions (plain-English overview)

## What happened

A 48-hour autonomous run (remote desktop work, topic 131439) was marked "stalled" by the window-run liveness checker even though the session kept working. Active status was taken away from a healthy run. Two separate mistakes caused it.

## Mistake 1: a heartbeat that is "too new" was treated as missing

The checker stamps the time first, then reads the session's heartbeat (the last-modified time of its transcript file). A session that writes during that tiny gap has a heartbeat a few milliseconds newer than the stamped time. In the incident it was 65 milliseconds newer. The old check required the heartbeat to be at or before the stamped time, so a session that was actively writing read as "heartbeat not fresh". That is backwards: a heartbeat newer than the check is the freshest possible evidence.

The fix allows a heartbeat up to 5 seconds newer than the stamped time to count as fresh. A heartbeat further in the future than that is still refused, so a broken clock cannot fake freshness forever.

## Mistake 2: a busy session was counted as a failed recovery

When a run looks unhealthy, the checker gets exactly one recovery attempt: it asks for the session to be refreshed. The refresh path refuses to kill a session that is in the middle of work and answers "session-busy". The checker treated that answer as "recovery failed", stalled the run and revoked active. But a busy session is alive, and is doing work.

The fix records that answer as "executor busy" instead of "failed". The checker re-checks right away. If everything is green, the run goes back to active. If not, it stays at-risk, a later green check restores it, and the existing 15-minute recovery limit still fails the run if it never recovers. No second refresh is attempted, so the one-attempt rule is kept.

## What stays the same

All five health checks still have to pass before a run is labeled active. The single recovery attempt and the 15-minute ceiling are unchanged. Any refusal other than "session-busy" is still a failed recovery that stalls the run loudly.

## What a reader needs to decide

Nothing new needs deciding. This is a bug fix that makes the checker stop calling a working session dead. If it turned out wrong, reverting the change restores the old behavior exactly; no stored data changes shape except a new possible value ("executor-busy") in the recovery-attempt record.
