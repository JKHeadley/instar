# Model second opinion on machine load (trustworthy machine load, step 4)

## What Changed

- New `MachineLoadAssessor` (spec `docs/specs/trustworthy-machine-load-and-mesh-floor.md` Part B4). On the serving-lease holder, once a minute: when a machine's own load verdict and the outside view disagree, or its own readings contradict, Jev labels it (`healthy_busy` / `overloaded` / `impaired` / `network_problem` / `cannot_tell`), with the GPT-6 Luna referee when Jev is unsure; 15 minutes later the label is graded against what happened. Advisory and log-only (`logs/machine-load-assessment.jsonl`, `GET /load-assessment/summary`). Dev-gated (`intelligence.jevLoadAssessment`), needs the vault `typesafe_api_key`, daily cap 200.
- The reroute spawn gate's memory-pressure refusal now states the used-memory percentage and thresholds, so it can be checked against the right figure.

## What to Tell Your User

Nothing changes for ordinary agents: this is off on the fleet. On a development agent, when a machine's own load reading and how it answers disagree, the agent now records a model's second opinion (busy but fine, overloaded, broken, or a network problem) and later checks whether it was right. It never moves work or sends anything.

## Summary of New Capabilities

- `GET /load-assessment/summary` — labels, who decided (Jev or the Luna referee), the disagreements that triggered them, outcomes 15 minutes later, right/wrong grades and accuracy.

## Evidence

Unit (17 tests: both sides of every conflict boundary, outcome and grade tables, referee path, spacing/cooldown, cap, disabled/no-key/non-holder, restart re-seeding), integration (summary over real HTTP, 503 when absent), E2E (production factory + real timer: alive on a development agent, dark on the fleet, live kill switch; awareness card via migrator and template). The memory-gate message is pinned by a new case in `session-manager-memory-pressure-sibling.test.ts`. On 2026-10-27 15:25–15:28Z the Studio's reaper audit showed 17.8–22.7% available memory, 40–47% compressor occupancy and kernel pressure level 2, so the 08:28 PDT refusal was correct.
