# Apprenticeship overdue-cycle SLA signal

The apprenticeship system now has a quiet way to notice when a mentoring cycle has been left open
too long.

A cycle is one mentor/overseer loop: task, mentee output, mentor notes, overseer differences, and
coaching. Those cycles already live in SQLite. This change adds a monitor that only reads them. If a
cycle is still open and its `createdAt` timestamp is older than the configured limit, the monitor
marks it overdue.

The default limit is 120 minutes, but the whole signal ships turned off:

```json
{
  "monitoring": {
    "apprenticeshipCycleSla": {
      "enabled": false,
      "overdueAfterMinutes": 120
    }
  }
}
```

When someone turns it on, it can raise an attention item once for each overdue cycle. It remembers
which cycle ids it already raised during the current server process, so it does not ping every tick
for the same stale cycle.

There is also a read-only API route:

`GET /apprenticeship/cycles/overdue?instanceId=...`

That route returns the overdue cycle ids, instance ids, cycle numbers, age in minutes, and creation
timestamps. If the monitor is disabled or unavailable, the route returns 503 instead of pretending it
is active.

The important boundary: this is only a signal. It does not close cycles, change cycle records, or
decide that the work was bad. It only says, "this open cycle has been open longer than expected."
