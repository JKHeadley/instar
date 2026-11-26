# ELI16 — A failure count that cannot go down is not a health signal

## The one-sentence version

My health report added up every scheduled job's run of consecutive failures with
no time limit, so a job I had switched off a month earlier kept dragging the
verdict down forever — and I nearly told the operator it was an active fire.

## What this surface is for

`GET /health` is the one place that answers "is this agent all right?". The
lifeline polls it, the dashboard badge reads it, and I read it when someone asks.
Among other things it reports `consecutiveJobFailures` — how many failures the
scheduled jobs are carrying — and if that number reaches five, the agent calls
itself degraded.

## What went wrong

A job's failure count is durable state. It resets on one event only: that job
running again and succeeding. Nothing else clears it.

So consider a job that is switched **off**. It will never run. It will therefore
never succeed. Its count is frozen at whatever it was, and no action anyone can
take will reduce it. Summing it into a health verdict means the agent is
permanently unhealthy for a reason nothing can fix.

That is not hypothetical. On 2026-10-21 a perfectly healthy agent reported 119
job failures and called itself degraded. Reading the job list: 118 of those
belonged to one mirroring job that was disabled and had last run on 26 September
— twenty-five days earlier. The remaining 1 was a single session kill, also
historical. The operator asked me whether everything was up to date, and I told
them a job "has now failed 118 times in a row", which implies it is happening
now. It is not happening at all.

## What changed

A job's failures count toward the health verdict when two things are true: the
job is switched on, and it has run in the last 24 hours. A failure recorded
outside that is history, not health.

Nothing is hidden, which matters — dropping the number quietly would just swap a
false alarm for a silence, and a disabled job sitting on 118 failures is
something somebody should eventually look at. So the excluded failures are
reported separately, each naming the job, its count, when it last ran, and
whether it was set aside for being disabled or for being out of date.

The five-failure threshold itself is untouched. Five current failures still mean
degraded. This narrows what "current" means; it does not relax the rule.

## Why 24 hours, and not the 30 minutes used elsewhere

There is already a window exactly like this one layer over, for the system's
other degradation events, and it is 30 minutes. It exists for the same reason and
its own comment says so: without it, one old transient would pin the badge red
for the rest of the process's life.

Thirty minutes is wrong here, though, because a job's clock is its own. A daily
job that failed this morning really is a current failure, and a half-hour window
would discard it. A day covers every cadence shorter than a day.

## What this does not fix

The window is plain wall-clock. It does not read each job's schedule, so a
six-hourly job and a daily job are treated the same, and a weekly job's genuine
failure is set aside sooner than its own cadence would justify — visible in the
list, but no longer part of the verdict. The better rule is "older than a few of
this job's own intervals", and that needs the schedule parser plus a decision
about jobs with no schedule at all. Stated here rather than left for someone to
discover.

The deeper version is a class, not an instance: any surface that sums a durable
counter which never self-clears will read as live while describing the past. This
change fixes the one place it was caught, and does not stop the next one.
