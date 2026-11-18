# Convergence Report: Topic-bound agent spawns placed by load (placement Step 2)

## Cross-model review: codex-cli:gpt-6-astra

The GPT-tier review ran in all seven rounds, through the codex CLI with model gpt-6-astra. A clean-door Claude read (claude-code, claude-opus-5-5) also ran in every round. It is a second read, not a cross-model opinion. Gemini is not signed in on this machine and did not run.

An internal reviewer read each version against the PR 3382 source (branch `echo/agent-sessions-placed-by-load`). It covered security, integration, adversarial cases, decision completeness, Verify the State, and lessons. The constitution conformance check ran five times.

## ELI10 Overview

When a person starts a new conversation, the agent already picks a computer with room for it. When the agent starts work for a conversation by itself (a review, a spec round, a long run), that work always starts on whichever computer received the request. On 17 November that left the Mac Studio with 23 sessions and the Laptop with none.

This step lets the agent's own conversation work start on a computer with room. It does that in the way a person's first message already does: the topic is claimed for the other machine, and the brief is handed over as that conversation's first message. The other machine starts the session with the brief as a fresh task.

## Original vs Converged

- **The design was cut after round 5.** The first design added a new kind of start message, plus a new handler and a launch store with its own states on the receiving machine. Each round of review found new races and recovery cases in that machinery:
  - an older peer quietly starting a blank session;
  - a refusal coming back as "unknown";
  - a user message starting a second session mid-hand-over;
  - replay after a restart repeating work;
  - duplicate answers being read as refusals.

  Findings did not fall (12, 5, 5, 4, 5). So the converged design reuses the existing path a person's first message takes to a peer. The only receiving changes are small ones: fresh-task framing, structural agent authorship, and a null media id.
- **Lease holder only.** Only the lease holder may send the cross-machine delivery (`checkCommandRBAC` refuses `not-router`), so a busy machine without the lease keeps the work local.
- **Fresh-task framing.** The existing hand-over text would tell the new session it had been restarted, and to wait. A brief now arrives as `agentTask`: "do this now".
- **No duplicates on the placed path.** A topic owned by a peer gets one answer, `409`, whenever it is found. The local fallback is a checked claim, not a blind spawn. An `unknown` outcome keeps the claim and never starts the work locally.
- **Scope kept honest.** Explicit model or framework, heavy work, and requests from older peers all stay local. Only topics with no live owner are placed. The shadow log gains the topic's ownership state, so the real benefit is measured rather than assumed from "18 of 23".

## Iteration Summary

| Round | Standards-Conformance Gate | Material / design findings | Outcome |
|---|---|---|---|
| 1 | ran (2 flags, then fixes) | internal 5, codex 3, clean-door 4 | old-peer gate, sender check, profile, size |
| 2 | ran (2 flags) | codex 3, clean-door 2 | launch record states |
| 3 | not re-run | internal 3, codex 2, clean-door 1 | refusals through `canServe`; automatic recovery after `unknown` cut |
| 4 | not re-run | codex 3, clean-door 1 | replay cut |
| 5 | not re-run | codex 3, clean-door 2-3 | **design cut to the existing first-message path** |
| 6 | ran (3 flags: provenance, survivability, judgment) | internal 2, codex 3, clean-door 3 | lease holder only, agent authorship, explicit options stay local, checked fallback |
| 7 | not re-run | internal 1, codex 2, clean-door 2 | fresh-task framing, heavy work stays local, ownership state in the shadow log, `unknown` count as a trigger |

Round 7 is one past the usual cap of 6. It was run because the round-5 cut replaced most of the design, and the replacement needed one full review. Its findings were narrow, and every one is applied.

## Left behind (accepted, with reason)

- **Judgment Within Floors.** The thresholds are reused unchanged from Step 1. They decide only where work starts, never whether it starts.
- **The brief is kept on two machines, not replicated further.** This avoids spreading private task text. A loss of both machines costs one re-issued task.
- **`unknown` waits for a person.** An absent record cannot prove that a delayed delivery will not still land, so the work is never started automatically.
- **Topics already owned are not released and re-placed.** That is a later step, if the shadow-log ownership data shows it matters.

## Approval

Waiting for the Chief of Staff.
