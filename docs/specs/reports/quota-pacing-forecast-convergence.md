# Convergence Report — Quota pacing, step 1: reading history, provider runway and per-account forecast

## Cross-model review: codex-cli:gpt-6-astra

GPT-6 Astra (through the agent's Codex login) reviewed the spec in round 1 and round 2. The clean-door Anthropic second read (`claude-code:claude-opus-5-5`) also ran in both rounds; it is a separate disclosure and does not count as cross-model.

## ELI10 Overview

Instar checks every 15 minutes how much of each Claude and Codex account's quota has been used, but it keeps only the last two readings. So it can't say where an account will be when its quota resets, or whether a group of accounts will run out before the next reset. On 17 November one Codex account had more than half its week left 12 hours before reset, and nothing noticed until the operator saw a screenshot.

This spec adds a history of those readings on each machine and a forecast built from it. For each provider (Claude, Codex) it shows whether weekly room lasts all week. For each account it shows where the account will land at reset. It is read-only: it moves no sessions, switches no models, pauses no jobs and sends no messages. Later steps, each with their own spec, may act on it, with the owner's approval.

The main trade-off is honesty against simplicity. The forecast always says "can't tell" with a reason rather than guessing, counts each login once even though every machine sees every account, and reports a best guess plus a range rather than one confident number.

## Original vs Converged

- **Topology.** The draft assumed each account lived on one machine. Every machine actually lists all 14 accounts. Now each login is matched by a hash of its provider-attested email, counted once, and a login two machines disagree about shows "machines disagree" instead of an average.
- **What crosses machines.** The draft relied on a "signed pool read" that doesn't exist and would have shipped raw history between machines. Now each machine sends only small computed summaries over the existing bearer pool fan-out, and the history files are excluded from git-sync and declared machine-local.
- **The forecast itself.** The draft projected the busiest 6 hours forward for days, which almost always reads 100%. That made "on track" hide the very 17 November case, and the "reachable maximum" was really a past peak. Now there is a central forecast at the current pace, a range from the slowest to the fastest recent pace, and no "reachable maximum". The provider verdict comes from the central scenario, with "tight" meaning only the pessimistic one runs out.
- **Bad inputs.** The poller writes an invented 0% for expired Codex windows, and can stamp an old usage-file reading as fresh. Now such rows are marked invalid or age-unknown, never counted as 0% or as fresh, and out-of-order rows are excluded.
- **Success measure.** The draft blocked the next step unless 8 of 10 forecasts landed in range, a test that a wide range always passes. Now the forecast replays itself after each reset (error, inside or outside the range, range width) as evidence for a review, not a pass mark.
- **Rollout.** The draft would have written a config value that switches the feature off even on development agents, and it had no test-agent rung. Now it goes through the dev-agent gate and has a full maturation plan: test agent, Echo for three weeks, then a graduation review.
- **Safety details.** The account id is validated before it is used as a filename. The ledger hooks the one function every read passes through, not just the scheduled one. Storage is capped, derived from the spacing rule, and every cut is disclosed.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | security+adversarial (8), scalability+integration (6), decision-completeness (9), lessons-aware (10), GPT-6 Astra (5), clean-door (4); gate 4 flags | 42 raised, about 15 distinct after merging duplicates | 21 precision | full rewrite of §1-§4, new Maturation plan, decision table, posture |
| 2 | GPT-6 Astra (4), clean-door (3), security+scale+integration (6), decisions+lessons (6); gate 3 flags | 19 raised, about 9 distinct (several already fixed mid-round) | 17 precision | fixed 5-minute buckets; identity stored per row; arrival-order eligibility; persistent unserved demand; merge on measuredAt with live-over-file ranking; typed pollAccount wrapper; no migration; registries; unified posture; fan-out helper extracted from queue-pace |
| 3 (cap) | GPT-6 Astra (4), clean-door (1), all-lenses internal (8); gate 2 flags | 13 raised, about 9 distinct; the shared reset tolerance was found by all three | 27 precision | shared 5-minute reset tolerance; complete local summary schema (measuredAt, calibration, uncapped forecasts); identity-less slots excluded from supply; censored calibration outcomes; Fable-null sidecar flag; freshness-first merge ranking; no WriteDomainRegistry entry; durable tick log for the ladder; fan-out byte check unchanged from queue-pace |

Standards-Conformance Gate: ran every round (round 1: 4 flags, round 2: 3 flags, round 3: 2 flags), each flag fixed in the same round.

Reviewer models: the internal reviewers ran as Claude subagents on the authoring session's model (Opus 5.5). Rounds 2 and 3 combined the six lenses into two reviewers and then one; every lens was covered each round. External: GPT-6 Astra (codex-cli) ran in all three rounds; the clean-door read ran on claude-opus-5-5 in all three.

## Proportion

Tier 1 (read-only measurement, about 180 spec lines, an estimated 6 to 8 source files plus tests). 3 rounds used of a 3-round cap. The round count is in line with the size. The design changed a lot in round 1 because the draft's picture of the multi-machine topology was wrong.

## Left behind

Round 3's design findings were applied as direct fixes at the cap, without a fourth review round. None concerned safety, security or data loss (the feature is read-only and display-only). They are listed in the catalog and will be checked again by the build's own tests and the test-agent rung.

Precision items carried to the build (one line each, the important ones):
- Map every `pollAccount` null exit (token unresolvable, observation-absence, credential-absent, rollout null after transport failure) to failed or not-a-read in the wiring test.
- Bench back-off lives in `CodexDeviceLimitTripwire` / the pool's `deviceLimitNextReadAt`, not the poller: read it from there.
- A Codex rollout's `measuredAt` is the token_count event time, not the file time.
- `measuredAtSynthesized` and `fableUnknown` land in the pool's `lastQuota` regardless of the switch (additive); list them in the side-effects artifact.
- The central scenario's "last known room" for a stale account returns to 100 at a reset that has already passed.
- `tight` will likely be the common verdict at first; the graduation review should expect it.
- Naming the round-robin (RRDtool-style) retention pattern in code comments.
- A simpler single-machine read (one machine already polls all 14 accounts on Echo) was considered; the fan-out stays because other agents' machines may not all hold every account.
- Replaying the previous cycle's hour-by-hour profile instead of a straight line: a step 5 candidate.

## Full Findings Catalog

Round 1 (42 raised): wrong topology (every machine lists all 14 accounts) → identity merge; unchecked `?account=` id into a filename → validation and path containment; undefined row time → `polledAt` + `measuredAt`; expired-window zeros from the poller → invalid windows; nonexistent signed pool read → bearer fan-out; history riding git-sync → exclusion; dev gate written as a config literal → `resolveDevAgentGate`; unbounded peer payload → summaries; `pollAccount` callers skipping `pollOne` → wrapper; five-hour window rates impossible → weekly and Fable only; busiest-6h "reachable maximum" mislabelled and always 100 → central plus range; `on-track` hiding the 11-17 case → central-forecast verdicts; 8-of-10 gate unsupported and always passing → calibration replay as evidence; retention circular → derived and disclosed; maturation plan missing → added; burn shifting across machines → placement limits; unknown-account bounds crossing → consistent scenarios; storage bound unenforced → hard cap; verdicts overlapping → precedence; awareness misreadable as authority → "forecast, not an instruction".

Round 2 (19 raised): replace-chain spacing never grows → fixed buckets; rows not partitioned by identity → identity per row; ordering lost arrival evidence → arrival-order eligibility, replay knowledge cutoff; demand dropped at exhaustion → unserved demand; merge on the wrong clock → `measuredAt` and live-over-file ranking; fixed-window assumption unverified → rolling check and test-agent verification; fan-out limits wrongly attributed to `poolPeerFetch` → extracted helper; failed reads invisible at the hook → typed wrapper; cycle-end row overwrite → state-aware replacement; migration would delete an operator's `false` → no migration; registries missing → devGatedFeatures and feature-ladders; marker malformed and key wrong → unified posture.

Round 3 (13 raised): exact reset comparison despite drift → shared tolerance; local summary missing fields → complete schema; identity-less slots double-counted → excluded from supply; stale cycle-end outcome → censored; Fable null coerced before the wrapper → sidecar flag; peer validation would drop over-100 forecasts → separate bounds; stale live beating fresh file → freshness first; registry entry impossible → none; ladder metrics with no durable source → tick log; streaming claim wrong → whole-body check unchanged.

## Convergence verdict

Converged at round 3, the cap for a Tier 1 change. Round 3's design findings were applied directly; none concerned safety, security or data loss. About 27 precision items are left behind and carried to the build. The spec is ready for approval and build.
