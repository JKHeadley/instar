# Feature Activation Coherence — the plain-English version

## The honest correction first

When I tried to turn the features on, I told you several were "dark — flag only, doing nothing." After digging into the actual code, I was wrong about three of them, and the truth is more interesting:

- **input-guard** (a safety feature that screens incoming messages for sneaky injected instructions) is actually **already on and running** — I'd looked for it in the wrong place. It's not dark; it's just *labeled* as off.
- **evolution-system** (where I propose improvements you approve) is **always running too** — its on/off switch is a fake; flipping it does nothing.
- **publishing** is **on by default** and needs no setup at all.

So I flipped a couple of switches that turned out to be decorative. No harm done, but it points at the real problem.

## The real problem

The list of "what features are on or off" **doesn't match what the code actually does.** Some features are advertised with an on/off switch that's wired to nothing. Some are running while the list says they're off. One (`autonomous-evolution`) has its switch wired to a setting that no part of the code ever reads — so the real control is somewhere else entirely. Telegram-style: it's a control panel where half the switches aren't connected to anything, and some lights are on with no switch at all.

That's the deepest version of the "built but dark" disease — not just a dark feature, but a **map that lies about the territory.** Anyone (you or me) reading the feature list is being misled.

## What this spec does — three things

1. **Fix the control panel itself.** Make the feature list derive its on/off from what the code actually does, so it can't drift. Add tests that fail the build if a switch is wired to nothing, or if the list claims a feature is off when it's actually running. Fix the telegram-style deadlock where one feature can only be turned on if it's already on.

2. **Decide what to do with each feature** — finish it, improve it, merge it into something newer that already does the job, or retire it:
   - **input-guard, publishing, evolution-system**: already running — just fix the label to tell the truth.
   - **autonomous-evolution** ("act without asking"): its switch is fake and the engine behind it was never finished. Collapse the three confusing settings into the one that's real, and keep changes human-approved rather than finishing the "act without asking" part — that's safer and matches our spec-first rule.
   - **telemetry**: fix the deadlock so it *can* be turned on (for other users); leave it off for you, since comparing your agent to a "population" that's basically your own infra isn't useful.
   - **dispatches** ("receive instructions from the instar maintainer"): this one's backwards for you — YOU are the maintainer. So it correctly stays off for your agent; we just fix it for the downstream agents it's actually meant for.
   - **response-review**: turns out to be a heavy duplicate of a message-checker that already runs on everything you send. Merge the one or two useful bits into that, and retire the duplicate rather than running two checkers.

3. **Hand the watchdog job to the Liveness Reconciler** (the other spec) so the control panel never silently drifts out of truth again. This spec is the one-time cleanup; the reconciler is the standing guard.

## Two more things I tripped over

- The context-death safety referee is even more switched-off than I thought — its memory/logbook isn't even created at startup. (Already covered by the stop-gate spec.)
- The emergency-stop detector (the thing that's supposed to catch you saying "stop everything") may not actually be connected to your incoming messages. That's safety-critical, so I flagged it for its own quick check.
