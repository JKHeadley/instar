# Plain-English Overview — Teaching the Background Robots to Use the Front Door

## What is this?

PR 1 (merged tonight as #873) fixed how my tiny internal judgment calls
(safety checks, message screening) talk to Claude — they can now use normal
interactive sessions instead of the one-shot commands that start billing the
prepaid $200/month pot on June 15.

But there's a second, bigger kind of background work: full jobs. Scheduled
tasks, agent-to-agent replies, system-update helpers — each of these today
launches Claude as a one-shot command ("here's your task, run and exit").
Those one-shots draw from the same prepaid pot after June 15, and nothing
reroutes them when it empties.

## What's the fix?

Almost all of those job launches already pass through ONE doorway in the
code. This PR teaches that doorway a second mode: when the subscription
switch (from PR 1) is set to `auto` or `force`, instead of launching Claude
as a one-shot command, it launches a normal interactive Claude session —
the same kind you chat with — types the task into it, and watches for the
"I'm done" pattern on screen (a watching mechanism that already exists and
is already used for conversations).

Same task, same safety rails, same cleanup — different billing lane.

## What the adversarial review added (5 reviewers, all findings folded in)

- **A real "I'm done" signal.** An interactive session doesn't exit when the
  task finishes, and the existing finish-detector only knows crash/pause
  phrases — so without a fix, every rerouted job would sit idle for 15
  minutes and be recorded as "timed out" even when it succeeded. Now each
  rerouted task ends by printing a unique completion marker the watcher
  looks for, with a hard time limit as the backstop.
- **Your account can't be eaten by other agents.** Scheduled jobs were
  already throttled when your subscription's 5-hour window runs hot — but
  agent-to-agent replies weren't. Rerouted without a gate, a chatty peer
  could burn your window until YOUR conversations start failing. Now those
  paths check the same quota gate, and there's a cap on how many rerouted
  sessions can run at once plus a memory check before each one starts.
- **No double-runs after a restart.** A job mid-flight across a server
  restart can't be accidentally started a second time.
- **You can verify it.** Every session now records which billing lane it
  used, visible in the session list — so "the soak ran 100% on the
  subscription lane" is something we can prove, not claim.
- **Nobody can quietly undo it.** A new automatic check fails the build if
  any future code launches the old one-shot way outside the approved spots.

## The one tricky case

Agent-to-agent replies remember their conversation by pinning a specific
transcript ID so follow-ups can resume the thread. The rerouted launch
carries that same pin through, and a test proves resume still works. If that
ever breaks in practice, `auto` mode quietly falls back to the old way (and
reports it) — only the emergency `force` mode insists.

## What's deliberately NOT here?

One oddball launcher (the "quick reply" fast path) doesn't go through the
common doorway. Under `force` it simply declines and lets the normal
(rerouted) path handle the reply instead of secretly using the old billing
lane. Rebuilding it properly is a later PR if the soak shows it matters.

## What do you need to decide?

Nothing today — the switch stays OFF by default everywhere, and a test pins
that OFF means bit-for-bit today's behavior. After this merges, the next
step is the one-day `force` soak on me: a full day where every background
brain-call and job runs purely on interactive sessions. That soak is the
"make SURE we're ready for June 15" proof, and its results come to you with
the fleet-default decision.
