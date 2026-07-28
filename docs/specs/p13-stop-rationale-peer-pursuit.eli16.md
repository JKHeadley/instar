# ELI16 — P13 guard: "blocked on another agent" is not a reason to stop

## What this changes
When the agent runs on its own (autonomous mode), a structural guard — the **P13 stop-rationale guard** — already watches every time the agent tries to END its run and blocks bad excuses for stopping. Until now it caught two: "I need a human judgment call" and "this needs real engineering." This change teaches that same guard two MORE bad excuses, both of which the agent actually used on 2026-06-08:

1. **"I'm blocked / waiting on another agent."** Depending on another agent (or even the operator) to reply or act is NOT a dead end. It is the agent's job to keep *pursuing* it — re-send the message, check for a reply on a cadence, try an alternate path, or advance other open work in the meantime — not to declare itself finished and quit. (In the incident, the peer had *already* replied; the agent just hadn't looked carefully.)

2. **"An idle/polling loop just burns the box."** Sitting in a loop that periodically checks for a reply costs almost nothing. Waiting on a peer is not a CPU drain, so "it wastes resources" is not a valid reason to stop while real work still remains.

## What already exists
The guard (`CompletionEvaluator.evaluateStopRationale`) is already wired into the autonomous stop path (`/autonomous/evaluate-stop`) and already blocks the two original excuses. This change adds the two new ones to the same instructions the independent judge reads. It also fixes a latent bug: a bare `STOP_BLOCKED` verdict (no second reason line) used to echo the token "STOP_BLOCKED" back as the steering text instead of giving the agent the full, helpful default guidance — so the rich guidance was effectively unreachable.

## Why it's safe
The change only makes the guard MORE willing to keep the agent working — it adds reasons NOT to stop; it never makes the agent stop when it shouldn't. The guard still **fails OPEN** on any error or ambiguity, so an evaluator hiccup can never trap a genuine, earned completion (the primary completion authority still governs). A genuinely operator-only residual that the agent has already pursued, with no other work to advance, is still an allowed stop. Tests: 15/15 green; `tsc --noEmit` clean.

## What you need to decide
Nothing mandatory — this is a Tier-1, safety-improving guard extension and the PR is the review surface. The one judgment to weigh: do you agree that "blocked on a peer" should keep the autonomous loop pursuing rather than ending? (Earned directly from your 2026-06-08 correction, so: yes.)
