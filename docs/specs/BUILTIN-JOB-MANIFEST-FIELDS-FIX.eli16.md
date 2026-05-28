# Built-in jobs aren't loading — in plain terms

## The one-line version

Every Instar agent's automatic background jobs (the health check, the reflection that captures
learnings, the evolution pipeline, the overseers that watch everything) quietly stopped loading a
week ago, and this fixes the small reason why.

## What's actually broken

Think of each built-in job as having two files: a recipe card (the `.md` with all its settings —
how often to run, how important it is, how long it takes) and a little index card (a `.json`
"manifest" the scheduler reads first to decide whether to load the job).

The code that writes the index card was leaving three fields blank — including "how important is
this job" (its priority). The scheduler, when it reads an index card with no priority, throws the
whole job out as invalid. So *every* built-in job got thrown out. On the agent I checked, the job
count is literally zero, and the logs show this happening over twelve hundred times since about
May 20th.

It's a mismatch between two pieces of our own code: one writes the index card, the other reads it,
and the writer stopped including fields the reader insists on.

## The fix

Tiny and surgical: have the index-card writer copy those three fields (priority, expected duration,
model) off the recipe card, exactly where it already copies the schedule. Because the writer rewrites
every index card on each update, the moment an agent updates it will automatically repair all its
broken job cards — no special migration needed.

There's also an optional safety net: teach the *reader* to assume a sensible default ("medium
priority") when an index card is missing that field, so a future slip-up like this can't silently
kill every job again. We'll decide in review whether to add that belt-and-suspenders layer now.

## Why it matters / what changes for you

Right now, affected agents are running with their entire scheduled-autonomy backbone dark — no
periodic reflection, no evolution proposals, no overseer checks — and nothing was obviously
complaining. After this, those jobs load and run again. Nothing changes that you have to configure;
it just restores behavior that's supposed to be on.

## The main tradeoff

The only judgment call is the optional safety net: making the reader lenient about a missing priority
is more robust, but "more lenient" always deserves a second look (could a genuinely-malformed card
now slip through as a wrongly-prioritized job?). That's exactly the kind of thing the convergence
review checks before this ships.

## Status

Approved by Justin 2026-05-27; built via /instar-dev (both producers + the shared typed builder +
tests, including a real-shipped-templates round-trip). Self-heals broken manifests on next update.
