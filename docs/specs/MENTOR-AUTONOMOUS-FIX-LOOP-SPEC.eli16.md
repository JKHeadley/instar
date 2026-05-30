# In plain English: make the mentor job actually FIX things, as Echo, on Opus

## What this is about

Echo runs a "mentor" job that helps another agent (Codey) by checking in every so
often. Today that job only WATCHES and TAKES NOTES: it sends Codey a check-in
message (written by a small, cheap model), looks at Codey's logs, and writes down
any problems it spots into a list. It never actually fixes anything. The real
fixing — watch how Codey is doing, find a bug, and ship a proper fix for it — has
always been done by a developer by hand.

## What Justin asked for

He wants the job to do the WHOLE thing automatically, the same way a developer
does it in a live session: give Codey a real task, watch both the chat experience
and Codey's internals, and FIX whatever is broken as a real, shipped code change —
with all the fixing done by a powerful Opus model. In his words, "if it could just
be you taking on that job that would be ideal."

## What's new

A new switch, `mentor.autonomousFix.enabled`. When it's on, the mentor heartbeat
stops doing the watch-and-note routine and instead becomes a GUARDIAN. Each
heartbeat it asks four questions: is the feature on? is there budget left? is a
loop session already running? has enough time passed? If all four pass, it starts
ONE full-power Opus session that is basically a copy of Echo. That session runs
one full cycle — check Codey's health (and fix it if it's down), give Codey a real
task, watch the chat and the internals, fix any problem as a proper pull request
through the normal ship checks, and report back — then it exits. The guardian
starts the next cycle later on its own.

## Why it won't run wild

The most important guard is "only one at a time." A single cycle (assign, watch,
fix, ship, report) takes a long time — much longer than the 15-minute heartbeat.
So without a guard, the heartbeat would keep launching new expensive Opus sessions
on top of each other. The single-instance check means: if one is already running,
the heartbeat does nothing. Budget and a minimum-wait also gate it. And the whole
thing ships OFF by default — each agent has to opt in. The Opus session also has
to pass the exact same automated ship checks (tests, CI) as a human, so it can't
land code that fails.

## What you need to decide

Nothing to configure to stay safe — it's off until you turn it on. To turn it on
for an agent, set `mentor.autonomousFix.enabled: true` in that agent's config. You
can watch what it does in `GET /mentor/status` (it reports `spawned`,
`loop-active`, `budget`, and so on) and in the pull requests it opens.
