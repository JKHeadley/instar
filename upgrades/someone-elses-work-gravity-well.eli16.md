# Catching "someone else will need to build that"

## What happened

On Nov 10, an agent was in an approved run to fully finish a feature. Part of the feature needed a button in the iPhone app, and the app's code was not on that machine. The agent wrote, in the design and in a progress message, that the app "will need a small button added" and that this was "app work outside this repository, recorded for the app's owner". That sounds like honest scoping. It was really a deferral: nobody owned the work, nobody was asked to build it, and it was not on the run's finish list. The run could have ended "done" with team members unable to open documents in the app at all. Justin's correction: never just claim what will be needed; either pull the code to your machine or hand it to the conversation that owns that work.

## Why the existing checks missed it

Instar already has several checks against deferral. They all look for words like "later", "follow-up", "phase 2" or "deferred". This sentence used none of them. It was phrased as a fact about where the work lives.

## What this change does

It teaches every layer that already guards against deferral to recognise this shape, judged by meaning:

1. The outbound message reviewer (the smart gate that reads each message before it is sent) now holds a progress or completion message that says outside work is needed without saying who builds it and how it gets there. A cheap phrase check spots these sentences first and only then hands the reviewer the extra rule, so every other message is reviewed exactly as before. If the message names the route ("handed to the app session with a brief", "pulling the app code here to build it"), it passes.
2. The cheap message hook, which only adds a reminder and never blocks, now adds a checklist when it sees phrases like "outside this repository" or "recorded for the owner", unless a handoff is named.
3. The spec reviewer that checks a design is complete now treats such a sentence as a design gap that stops the spec from being marked converged.
4. The autonomous-run skill lists this shape among its deferral traps and says the finish condition must cover every piece the goal needs, including pieces in the app or another project.
5. Every agent's CLAUDE.md gets a short "Someone Else's Work" trap entry.

## What already existed

The message reviewer's "false blocker" rule (B17), the deferral hook, the spec reviewer and the autonomous skill all existed. This change extends each one and adds one small phrase detector; it adds no new service, setting or route.

## Safeguards

The message reviewer is told to lean towards letting messages through when unsure, and to pass any message that names a route, asks who should own the work, or reports a real blocker. The hook never blocks. Existing agents receive the skill and CLAUDE.md text through the normal update path, and a customised skill file is left alone.

## What you need to decide

Nothing. This is a wording and checking change that a revert fully undoes.
