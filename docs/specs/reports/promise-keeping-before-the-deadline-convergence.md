# Convergence Report — Promises are kept before their time

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-tier external pass ran in all six rounds through the agent's codex CLI. A clean-door Anthropic read (`claude-code:claude-fable-5-2`) also ran every round; it is a second read, not a cross-model opinion. Gemini is not installed on this machine.

## ELI10 Overview

When the agent promises its person something by a time, the old design waited until the time passed and then sent the person a list of what slipped. Justin rejected that: the agent should pick the work up and do it, and the person should hear as little as possible. This spec makes keeping the promise the main mechanism and the late message the last resort.

Before the time, the conversation that made the promise is checked twice, at the halfway point and 30 minutes before. If that conversation has stopped, a new one is started for it, silently. After the time, the work is handed back to a conversation to finish. The person hears nothing until the result arrives, unless the conversation has to move the time. Moving a time and telling the person are one server action, so a time can never move silently. Only when the agent could not get the work restarted, or two restarts produced nothing, does the person get one fixed message: what was missed, why, and that the agent is still on it. After that the agent keeps trying on a slowing schedule, and anything it gives up on is said out loud, once.

The tradeoffs: more sessions get started (bounded to a third of the machine's normal room, only on the main machine, never in the person's headroom). Silence before the first word can be long, up to the time plus 8 hours for long promises, because the agent is working rather than reporting. Promises with no time get two new choices in the existing promise review, not a new job.

## Original vs Converged

- **Starting a session.** The original routed starts through the normal inbound message path. Review showed that path tells the person "Session starting up", can refuse with a person-visible line, frames the notice as the person's own message (so the session would acknowledge it), and returns before the spawn finishes. The converged design uses the direct spawn path with three new options: a system-notice block, quiet, and admission as an automatic start. It never runs while a session is bound, and it reserves its slot until the spawn settles.
- **Budget.** The original read `maxSessions` as a hard ceiling and reserved 2 slots. Topic sessions actually go up to three times that. Starts now happen only below `maxSessions`, so the person's headroom is untouched. Working promise sessions are capped at a third of `maxSessions`, and finished ones are released under strict, all-known conditions.
- **Moving the time.** The original let any PATCH re-arm everything, so a session could push a time forever, silently. A move is now one server operation: send the message, confirm delivery, then move the time. It is crash-safe through the send's operation record. PATCH of a given time is refused. One 15-minute grace is allowed with no message.
- **Proof of progress.** "Delivered" after a pickup needs a delivered message in the conversation. A pickup is confirmed by a live session or its output. Results from a superseded time are ignored through generations.
- **Last resort.** The original asked the person to reply to restart the work. Now it never asks anything. It says what was missed, gives a truthful reason (failed, busy, not on the main machine, queued, or picked up twice), and says the agent is still on it. It is combined per conversation and capped. After it, the agent backs off, then tries daily, then hands the row to the promise review. If the review retires something the person was told the agent would keep doing, the person gets one closing line.
- **Untimed promises.** A proposed daily triage job was dropped in favour of two new actions in the existing promise review: set a time, verified against the conversation, and pick up. The original "set a time in the past" trick, which would have produced a false "I missed the time I gave you", is gone.
- **Scope made explicit.** Slack conversations (fb-baf17cfd-85f) and promises owned by a standby or a down machine (fb-e2a65da1-b42) are excluded and tracked.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | all six internal lenses, codex, clean-door, gate (2) | ~20 | ~8 | start path, budget, verification, time moves, last resort, untimed lane, stamps |
| 2 | sec/adv/scale, integ/decision/lessons, codex, clean-door, gate (3) | ~14 | ~6 | direct spawn options, admissionKind, triage → promise review, crash-safe attempts, fairness, new fields |
| 3 | combined internal, codex, clean-door, gate (2) | 9 | 6 | reschedule operation, deliver evidence, reason-agnostic deadline, parking, spawn decoupling, short promises |
| 4 | combined internal, codex, clean-door, gate (2) | 7 | 6 | send path for reschedule, reschedule crash safety, grace as its own op, slot accounting, generic continuation off |
| 5 | combined internal, codex, clean-door, gate (3) | 6 | 5 | operation-outcome recovery, safe release rule, old rows still picked up, parked ordering and exit, tests refreshed |
| 6 (cap) | combined internal, codex, clean-door, gate (2) | 8, none safety/security/data-loss | 9 | applied at the cap without a further round: intent end rules, generations, reservations until settlement, stuck-session handling, latency bound, per-machine cap stated, new counter stated |

Standards-Conformance Gate: ran every round (2, 3, 2, 2, 3, 2 flags). Each round's fit verdict for the parent principle "The Agent Carries the Loop" was `fit`.

## Proportion

Tier 2 (new session-start authority, changes to the commitment write API). The spec is about 230 lines and the work spans about 8 source files. Six of six rounds were used, ending at the cap. ⚠ The rounds stayed productive to the end: each one found real crash-safety and edge-case gaps rather than wording. That reflects how much state the design carries, about 20 stamp fields. The clean-door reviewer's repeated suggestion to model this as one per-time state enum is noted under Left behind.

## Left behind

- **Ladder counts flagged by the gate (Judgment Within Floors), every round.** The fixed counts are 2 pickups, 3 failed starts, the 7-day park and the per-pass values. They are kept as judgment-candidates with a floor and the pass report as arbiter, because each one only delays the one irreversible step. Accepted risk: long work that neither delivers nor reschedules in two intervals gets the `not-moving` message. The bootstrap asks such work to reschedule (told), which avoids it.
- **Parked starts capped per day per machine** (the gate, round 6). Kept: parked rows are reached oldest-first in turn, and the cap now equals the working limit. Accepted risk: a large outage backlog drains over several days.
- **Implicit state machine** (clean-door, rounds 2–6). Building it as an explicit per-time `stage` enum with a transition table is the build's choice. The fields are listed so either form satisfies the spec.
- **`deliver` evidence proves delivery, not content.** Stated in the spec. The session's judgment of content stays, as today.
- **`set-time` verbatim quote check may refuse often.** It fails safe; log the refusal rate in the review report.
- **Locally defined terms** ("speaking machine", "lease holder", "Quiet by Default") are not redefined in the spec.
- **Industry pattern sentence** (durable timers / outbox). Not added.
- **Build simplifications (spec updated to match, no new review round):** a reschedule from a non-owner machine is refused with the owner named, rather than forwarded, because the send must happen where the row is written; the release rule reads the conversation log for "the person has not written since the start" (unknown → not ended) instead of a new per-session counter.
- **Slack conversations**: tracked as fb-baf17cfd-85f.
- **Standby-owned or down-owner promises**: tracked as fb-e2a65da1-b42.

## Full Findings Catalog

Rounds 1–6 findings are in the session transcript of topic 144400 on 2026-11-18. The DESIGN items and their resolutions are summarised in "Original vs Converged" and the Iteration Summary above. Every round's raw external output is in the reviewer JSON files written by `cross-model-review.mjs` for that run.

## Convergence verdict

Converged at round 6, the Tier 2 cap. The last round's eight design findings were fixed in the spec at the cap. None was a safety, security or data-loss risk, so per the cap rule they did not send the spec back for a seventh round. Nine items are left behind above, with reasons. The spec is ready for Justin's review and approval.
