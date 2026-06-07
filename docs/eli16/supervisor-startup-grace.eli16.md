# Supervisor startup grace 3→10 min — Plain-English Overview

> The one-line version: a watchdog gives a starting-up server a few minutes to come alive before it decides "this is dead, restart it." That window was 3 minutes, but on a busy machine the server takes 5–6 minutes to finish starting (it loads a huge pile of memory and reconciles dozens of sessions before it can answer "I'm alive"). So the watchdog kept killing the server *while it was still starting* — forever. Widening the window to 10 minutes lets a slow start actually finish.

## The problem in one breath

Echo's "is the server alive?" supervisor restarts a server that fails its health check once the startup grace period ends. The grace was 3 minutes. But a real boot on this loaded box — loading ~18k stored messages of memory, the knowledge graph, and reconciling ~45 sessions, all before it opens its health-check port — takes 5–6 minutes. So the grace ran out mid-boot, the supervisor declared the still-booting server dead, restarted it, and the next boot hit the same wall: an endless restart-before-it-finishes loop. That loop is exactly the "server temporarily down on every message" symptom.

## What already exists

- **The supervisor** — the part of the lifeline that watches the server's health and restarts it if it goes unresponsive. It already has a "startup grace" concept (don't judge a server that's still booting) and a CPU-starvation restart-defer. The grace was just set too short.
- **`startupGraceSeconds`** — an existing config knob to override the grace. Unchanged by this fix.

## What this adds

It changes one number: the startup grace goes from 3 minutes to 10 minutes. That's enough to comfortably cover a slow boot, so a legitimate boot always finishes and answers its health check — which stops the loop. A boot that's genuinely hung (not just slow) is still caught, just after 10 minutes instead of 3.

## The safeguards

**A longer grace can only prevent a wrong restart, never cause one.** It strictly reduces the chance of killing a healthy-but-still-booting server. Fast machines are unaffected (their boots finish in well under 3 minutes either way).

**It makes the rest of the rollout safe.** When agents across the fleet auto-update to the new version and restart, the longer grace means their restart can't loop on a slow boot — so shipping the other stability fixes won't re-trigger this incident anywhere.

**A genuine hang is still caught.** If a boot truly wedges, the supervisor still restarts it after the (now longer) grace, and the out-of-process fleet watchdog remains as a further backstop.

## Honest scope

This is the immediate, proven cure (it broke the live loop on Echo the moment it was applied). It is NOT the deepest fix: the real root is that the server binds its health check only *after* all the heavy boot loading. The durable fix — answer health first, load memory in the background, so a restart can never loop regardless of grace — is tracked as the top post-mortem item. This grace bump is independently correct and makes restarts safe in the meantime.

## Evidence

`tests/unit/supervisor-startup-grace.test.ts`: the default grace is now ≥ 6 min (and strictly greater than the old 3-min that caused the loop); the `startupGraceSeconds` override still works; a health failure inside the grace window is not acted on. `tsc --noEmit` clean. Proven live: applied to Echo mid-incident, the server went from restarting every ~5–6 min to stable, health recovering to 6/6.
