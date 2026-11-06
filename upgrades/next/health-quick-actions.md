<!-- bump: patch -->

## What Changed

Each problem in the app and the dashboard console now has quick actions. Hide for a while (1 hour, 1 day or 1 week) brings it back if it's still happening, and says so if it stopped and returned. Hide from me stops it showing and counting while the agent keeps tracking it. Ignore completely stops the agent tracking it, after one confirmation with one plain sentence. A reported problem stops being recorded at all; a background check stops counting as a problem; a live reading the agent depends on can't be ignored and says why. Security and data-loss items can only be hidden for a while. Everything hidden sits in a Hidden list with a way to bring it back. Hidden items never raise a count, and an agent with something hidden still happening reads "Running", never "Healthy". Choices reach every machine of the agent, and one that was offline catches up.

## What to Tell Your User

When you're looking at a problem you can now hide it for an hour, a day or a week, hide it from yourself for good, or tell me to stop tracking it altogether. It's a tap or two, and anything you hide is in a Hidden list where you can bring it back. Security problems can only be hidden for a while, and a few things I can't stop watching because other parts of me rely on them; the screen says when that's the case.

## Summary of New Capabilities

- Quick actions on each health problem, in the app and the console: Hide for a while, Hide from me, Ignore completely, with a Hidden list to undo them.
- Ignoring a reported problem stops the agent recording it, alerting on it or counting it in its health.
- Choices replicate across this agent's machines.

## Evidence

Unit, integration and e2e tests cover each kind of item on both sides, the real auth chain, and a real server's reporter and `/health` (see the PR). The console was read at 390x844 and 1280x728, and the app's screens on a simulator.
