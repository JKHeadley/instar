---
title: Jev "Going in Circles" Shadow
description: A log-only measurement that asks a fast decision model, every few tool actions, whether a session is repeating the same fix for the same failure. It never sends a nudge. Development agent only.
---

Sometimes an agent gets stuck: it changes code, runs the tests, sees the same failure, and changes the code the same way again. The standing rule is that after about three such tries, the agent should stop patching and step back. Nothing watched for this before.

**`JevCirclesShadow`** measures whether a nudge for this would be useful, without ever sending one. Every five actions in a Claude Code session, the server reads that session's last fifteen actions from its own transcript, removes anything that looks like a secret, and asks Jev (TypeSafe's fast decision model) the same five-label question used in the offline test. It records only the answer: the label, the confidence, and whether a nudge *would* have fired. A 30-minute cooldown is applied to the would-fire count, so the log shows how often a real nudge would appear.

In the offline test on 656 real activity slices, this caught about 8 in 10 real loops with about 1 false alarm in 20 normal slices, and almost never mistook patient waiting (polling a build or a status) for a loop.

## Safeguards

- Log-only: `JevCirclesShadow` never sends, blocks, or injects anything into a session.
- The log is content-free: session, time, label, confidence, would-nudge.
- Text sent to Jev is secret-scrubbed; each check is bounded in time, metered, and capped per day. Failures are silent.
- Live on a development agent, dark on the fleet; a kill switch is read live.

Summary route: `GET /jev-circles/summary` (Bearer) — checks run, would-nudges, and per-session counts.
