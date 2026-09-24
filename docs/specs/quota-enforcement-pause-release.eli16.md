# The usage-limit brake now lets go on its own

## What this is, in plain English

When I get very close to my usage limit and there's no other account to switch to, an emergency brake pauses all my scheduled tasks (health checks, memory reflection, maintenance, the Jev trial) so I don't burn through what's left.

The brake had no release. Once it was on, it stayed on until someone restarted my server. Its own alert said "manual intervention required", but the alert didn't reach anyone. On the night of 23 September the brake went on at 9:32pm. Usage was back under the limit within a few hours, and every scheduled task stayed frozen until a restart at 9:43 the next morning: about twelve hours of nothing, with nobody told.

## What already exists

- The brake itself: a pause at 90% of the five-hour limit, and a full stop at 95%.
- A separate, per-task check. Before any single task runs, it compares current usage against that task's priority and skips low-priority work when usage is high.
- A regular usage reading that already drives the brake.

## What is new

On every usage reading, if this brake is the thing holding the tasks, and usage has come back comfortably under the limit (five points below the line where it acts, so it doesn't flap on and off), the brake releases and sends one note saying so. It only ever releases a pause it took itself, never one someone else set on purpose.

## Safeguards

- Every task still passes its own usage check before running, so releasing the brake early can't cause overspending.
- If usage climbs again, the brake goes back on exactly as before.
- If a reading is unavailable but the weekly budget is healthy, the brake releases. That's deliberate: a frozen scheduler generates no fresh readings, so waiting for one could freeze it forever.
- Undoing this change restores the old behaviour. No data or settings are involved.

## What you need to decide

Nothing. This is a defect fix. The brake was always meant to protect usage, never to switch the scheduled work off for good.
