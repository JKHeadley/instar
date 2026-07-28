# Dead sessions showing up as live tiles — the dashboard filter fix

## What you saw

Hours after five old Mac Mini sessions were closed, they showed up AGAIN on the laptop's dashboard as clickable "running on Mac Mini" tiles. Clicking one would try to stream a terminal that no longer exists.

## Why it happened

The dashboard builds its session list from two sources. For THIS machine, it asks "what's running right now?" and only shows live sessions. But for OTHER machines, it asked for the full history book — every session record the other machine has ever kept, including finished and closed ones — and drew a live-looking tile for each. So closed sessions on the Mini kept appearing on the laptop as if they were running.

## The fix

One line: when drawing tiles for another machine's sessions, only draw the ones whose records actually say "running" (or "starting"), exactly the same rule the local list has always used. The behind-the-scenes data is untouched — the full history is still there for anything that needs it; it just doesn't masquerade as live anymore.

## How this relates to the other duplicate-session fix

Two layers of the same symptom, fixed separately: one fix (the ghost-record one) makes sure old records stop CLAIMING to be running; this fix makes sure the dashboard only DRAWS records that claim to be running. Either alone closes most of it; together the dashboard simply tells the truth.

## What you'll notice

The dashboard shows only genuinely live sessions for every machine. Nothing to configure.
