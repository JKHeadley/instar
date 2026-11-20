# Convergence Report — Server memory ceiling

## Cross-model review: codex-cli:gpt-6.2-astra

The external GPT-tier review ran through the agent's codex CLI on all 6 rounds. Gemini was not signed in. The Claude clean-door reviewer was not run.

## Status: NOT CONVERGED. Stopped at the Tier-2 round cap (6) with safety findings

Round 6 still found design problems. The internal reviewer found one about safety and security: the kill reached detached children such as the remote-desktop relock guard and detached git writes. Codex found three: a stale health result could act on the replacement server, a huge argument list could blind the probe, and the hold and the notice started on different rules. Each has a clear fix, and all of them are now written into the spec. No review round has checked those fixes yet.

The skill's rule is that the review stops at the cap when the open findings concern safety, so the convergence tag was NOT written. Building this needs one more review round, which the operator has to approve. Alternatively, the operator can accept the round-6 fixes as written.

## ELI10 Overview

When an agent's server starts eating memory, the lifeline will stop it before it fills the machine. Normally it then starts the server again and says nothing. If this happens three times in six hours, it sends the owner one plain message. The limit is 8 GB, or half the machine's memory if that is smaller. A healthy server uses 1 to 2 GB.

## Original vs converged

- **The kill.** The first draft reused the lifeline's existing restart routine. That routine has several branches that do not kill the server at all, or only after a delay of up to 80 seconds: while the circuit breaker is open, during the cooldown after repeated failures, during planned restarts, and during the backoff wait. The spec now kills straight away, using the server's process ID, the pane's process group and the tmux session ID. The existing rules still decide when the server comes back.
- **Children of the server.** Children the server deliberately detached are left running, as they would be after a normal crash. These include the remote-desktop relock guard, detached git writes and Local Verify runs.
- **Measuring memory.** On macOS the plain "resident" memory figure undercounts when the system compresses memory, which is exactly what happens during a runaway. The spec now also reads the true memory footprint.
- **Confirming a breach.** A breach needs a second, fresh reading, with no time limit between the two. This matters because under starvation the supervisor's checks were seen 300 to 980 seconds apart. A single reading at 1.5 times the limit is enough on its own. One footprint reading cannot count twice. If the recheck just before the kill comes back below the limit, the kill is cancelled.
- **Messages.** The first draft notified the owner on every restart. The spec now stays silent for a stop that fixes itself, and sends one notice per episode, built from what was actually recorded. The "server went down" message no longer fires for these stops.
- **Restart pacing.** A server that balloons every time it boots now waits 5, 10, 20, then 30 minutes before each automatic restart. During this hold the failure counters do not advance. A boot, an operator restart, a doctor session and planned restarts all ignore the hold.
- **Races.** A health result now carries the spawn generation that was current when the check started. Restart timers are tracked, so a stale result can never tear down the replacement server.
- **Defaults.** Every ceiling value, including the default, is clamped to between 3 GB and 90% of the machine's memory. On a machine with less than about 3.4 GB the ceiling turns itself off.

## Iteration Summary

| Round | Design findings (internal + codex) | Spec changes |
|---|---|---|
| 1 | 11 + 3 | Rewritten: own kill path, footprint, unknown handling, async probe, notice only on escalation, defaults corrected |
| 2 | 5 + 5 | Fresh-reading confirmation with no time window, the 1.5x rule, session-id binding, clamped default, recovery stated from recorded state |
| 3 | 2 + 4 | Kill by pid and process group, footprint clearing rules, recheck can cancel the kill, respawn hold, pending sample record |
| 4 | 3 + 3 | Hold moved into `handleUnhealthy()` as an early return, operator overrides, persisted episode state, timer cancellation |
| 5 | 3 + 3 | Fix for the false claim about `setsid`, a set of timer handles plus a generation token, episode kill count, confirmed-stop check |
| 6 | 1 (safety) + 3 | Detached children spared, the generation captured when the health check starts, the argument-free first `ps`, hold and notice on one rule (NOT re-reviewed) |

Standards-Conformance Gate: ran in round 1 (11 flags) and round 2 (14 flags). Its flags were folded into the rewrites: maturation-ladder divergence stated, Occam/OS-limit assessment added, alerts-topic justification, reachability, unbounded-retry brakes.

## Proportion

This is a Tier-2 spec of about 280 lines. All 6 of 6 rounds were used, and each round kept finding real interactions with the existing supervisor's restart paths. The supervisor (2,700 lines with many restart branches) is the cost driver, not this feature.

## Left behind (precision)

- The 1024 MB floor wording from round 1. It is superseded by the 3072 MB clamp.
- tmux `remain-on-exit` dead panes could bypass the hold through a name-based restart. This cannot cause a kill loop.
- Step 3 of the Action section does two things and should be split when it is built.

## Convergence verdict

Not converged: stopped at the cap with safety findings fixed but not re-reviewed. Needs one more review round, or the operator's acceptance.
