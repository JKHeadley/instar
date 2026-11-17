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
