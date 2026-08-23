# A session that dies on its own now leaves a trace — in plain English

## What was missing

Earlier today every interactive codex session died about 18 seconds after it
started. When we went to the records to find out why, there was nothing there.
Each death was filed as a perfectly normal completion — status "completed",
reason blank — and the log that records every session shutoff had no row for
it at all. The cause had to be rediscovered by hand: spawn a session, sit and
watch the terminal, see what it printed before it vanished.

That is a defect in its own right. Instar promises that a session can never
disappear without a trace. It had a gap: the promise covered every way INSTAR
ends a session (reapers, kills, restarts) but not a session whose own process
simply stopped. Those are exactly the ones you most need evidence for, because
nobody asked for them to end.

## What changed

Three things, all on the path that notices a session's terminal is gone.

**1. The record says why.** The session record now carries a reason —
"process exited" — and, when it died young, "process exited during startup".
That phrase alone would have turned today's mystery into a one-line search.

**2. It lands in the shutoff log like everything else.** The same log that
records every reaper kill and every refused kill now gets a row of a new kind,
"exited", with the session's name, its framework, and how many seconds it had
been alive. The existing "why did my session vanish?" surface (`GET
/sessions/reap-log`) shows it without any change on the reading side.

**3. It carries the evidence the dead terminal would have taken with it.**
This is the part that was genuinely missing. By the time instar notices the
pane is gone, there is nothing left to capture. So during a session's first
two minutes — the window where silent deaths cluster — the monitor keeps the
last dozen lines it saw. When the session vanishes, those lines go into the
row. For today's bug that row would have read, verbatim: "Update available!
… 1. Update now … Press enter to continue". Case closed from the records.

## What it deliberately is not

- **Not a new alarm.** Nothing pings you. It is a record, read when you ask.
- **Not a change to how sessions end.** Every listener that fired before
  still fires; this adds a reason and a row, it removes nothing.
- **Not a raw terminal dump in a log.** Those lines pass through the same
  credential scrubber the dashboard's live terminal view already uses, and
  they are capped at a dozen lines. The scrubbing happens inside the log
  writer itself, so no caller can bypass it. The row also records how many
  redactions were applied, so a reader knows the tail was touched.
- **Not unbounded.** Only young sessions are sampled, samples live in memory
  only, they are dropped the moment a session is no longer running, and the
  stored tail is clamped on write and re-clamped on read.

## How we know it works

Each of the three pieces has a test that was made to fail by putting the bug
back: remove the reason stamp and the reason test fails; make the log reader
forget the new row kind and the round-trip test fails (it would silently
relabel a self-exit as a kill). A scrubbing test proves an API key and a
bearer token in the sampled lines do not reach the log. A clamping test
proves a 400-line dump is cut to the last dozen lines.

## What you would notice

Nothing, until a session dies on its own — and then, instead of a blank, you
get a reason, an uptime, and the last thing it printed.
