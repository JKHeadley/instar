# Test-Runner Concurrency Bound — plain-English overview

## The problem in one paragraph

When our test suite runs, it doesn't run as one process — it spins up a worker for roughly every CPU core on the machine. That's fine when one test suite runs at a time. But on a development machine where several AI agent sessions each build and test their own changes, nothing stops many suites from starting at once. On 2026-07-02, twenty-nine test suites ran simultaneously on one machine: roughly 300 worker processes fought for 16 cores, the agent servers sharing the machine froze, and the health watchdogs — misreading the freeze as sickness — killed healthy servers. The safety system became the outage.

## The fix in one paragraph

A machine-wide "test lane" counter: before a full test suite starts, it takes a ticket. Only one full suite runs at a time per machine (the operator's explicit rule); everyone else waits their turn, up to a time limit, then stops with a clear message that says "the machine was busy — this is NOT a test failure" and names exactly which process holds the lane. Small, targeted test runs (a developer iterating on one file) get their own second, roomier lane — six tickets instead of one, each run capped to a small worker pool — so day-to-day iterating never waits behind a full suite. The final review round made the two lanes deliberately identical in mechanism (the earlier draft gave small runs a free pass plus a separate tally, and every review round found a new hole in that special-casing; one shared, proven mechanism closed them all — including the trick of splitting a big suite into many "small" runs to dodge the queue: the second lane's tickets simply run out).

## The design choice everything hangs on

We already have a nearly identical mechanism protecting against too many AI subprocesses (the "fork-bomb cap"). The obvious move was to copy it. Review caught that copying it would have re-created the exact meltdown: that mechanism *blocks* when it isn't sure, which is right for preventing out-of-memory crashes but exactly wrong for tests — wrongly blocking a test run wedges every code push on the machine (pushes run tests first), while wrongly allowing one just means a few extra busy minutes. So this system does the opposite of its sibling on every uncertain call: **when unsure, let the test run.** A corrupted state file, an unreadable lock, a confusing situation — all resolve to "admit the run and write down what happened" rather than "freeze the developer loop."

## The dangerous part, handled carefully

A test suite that hangs forever would jam the lane forever, so after a generous ceiling (60 minutes, tunable) the system reclaims the stuck suite's ticket so the lane keeps moving. **By default it does NOT kill anything** — it just takes the ticket back and writes a loud note in the log. A semaphore's job is to free up capacity, not to execute processes, and review made clear that killing by remembered process-ID is genuinely risky: process IDs get recycled, so the number written down an hour ago might now belong to something innocent (even another agent's server). So force-stopping a hung suite is a *separate, opt-in* mode that stays off through the whole trial period and only an operator turns on later. Even then it is fenced four ways before any signal: the target ID must be sane, its start-time and command line must still match the recorded test run (defeating ID recycling), it must be its own process-group leader before a group-wide signal is allowed (so a shared group — a git-push hook, a terminal pane — is never caught in the blast), and the "if it ignores the polite stop, escalate to a hard stop" step is written down durably so it completes even if the process that noticed the hang exits first. If any check fails, the ticket is freed but nothing is touched.

## How it ships (the operator's two ratified calls)

1. **One suite at a time** (not two) — honoring the standing rule literally; there's a documented lever to raise it per machine if serial proves too slow.
2. **Watch-only first.** The system ships observing: it takes tickets, counts, and writes a durable log of every "I would have blocked this" decision — but blocks nothing and signals nothing. Only after a bounded soak (at least 14 days and 50 real suite runs with zero false would-blocks, and a check that waiting pushes weren't being starved) does the owner flip one file on the machine to turn enforcement on. The flip is tracked as a commitment so "watch-only" can't quietly become "forever"; if the window lapses with no decision, the guard dashboard flags it loudly.

## What could still hurt, honestly

Full suites serialize: on a busy multi-agent machine, someone's push waits for someone else's suite. That's the deliberate price of the operator's rule, and the log makes the cost measurable so the cap can be raised with evidence. And because the system deliberately errs toward letting runs through when its own bookkeeping is broken, it's honestly a *best-effort* bound — in a rare stuck-lock situation a few extra runs can slip through for a short window (the safe direction), and those windows are logged and visible rather than silent. Older work branches that predate the change don't carry the ticket-taking code until they rebase — the bound covers the machine progressively, not instantly. And the whole thing is per-machine, per-user by design (a test run burns THIS machine's cores; there's nothing to coordinate across machines).

## Escape hatches

One environment variable turns the whole thing off instantly (and even that is logged, so a silently-disabled guard can't quietly explain the next meltdown). Deleting one file drops enforcement back to watch-only. Reverting the change removes everything; the leftover state files are inert.
