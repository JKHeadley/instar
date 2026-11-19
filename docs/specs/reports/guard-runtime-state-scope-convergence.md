# Convergence Report: The source-tree guard's runtime-state rule matches only an instar checkout's own .instar folder

**Status: NOT converged at the round cap (6). All round-6 design findings are applied but have not been reviewed again. A confirmation round is requested from the Chief of Staff, as the skill requires when the findings left at the cap concern safety.**

## Cross-model review: codex-cli:gpt-6.2-astra

The GPT-tier review ran in all six rounds, with a clean-door Claude read each round. An internal reviewer checked the spec against the code in rounds 1, 2 and 6; round 6's internal check found nothing material. The Standards-Conformance Gate ran in round 1. A static scan of all 284 files that call the delete functions shaped the scope list.

## ELI10 Overview

The file-deletion safety check has a shortcut for the agent's private `.instar` folder. That shortcut is written so loosely that it allows everything inside an agent's folder, because every agent folder sits under `~/.instar/agents/`. This change narrows the shortcut to what it was meant for. It gives the few jobs that relied on the gap their own small named permissions, and it first runs in watch-only mode for two weeks, keeping a durable record of every case where the old and new rules disagree.

## Iteration Summary

| Round | Material / design findings | Outcome |
|---|---|---|
| 1 | codex 4, internal material | All ancestors walked; named scopes; durable ledger; route |
| 2 | codex 3, cc 2, internal | Three-way classifier on the canonical parent; shape-only canary scope; Local Verify scope listed; legacy executed in report |
| 3 | codex 3, cc 2 | Report verdict computed as enforce; marker without git protected; canary fallback; recursive-subtree non-goal filed (fb-6ad01267-11d); scope list from a static scan |
| 4 | codex 3, cc 0 | Nuke path built by the guard; truncation removed; ledger in both directions with dispositions |
| 5 | codex 3, cc 1 | Nuke checked before teardown; one ledger with direction, caller and target shape; ENOENT counts as clean; system-temp truncation removed |
| 6 (cap) | codex 3, cc 2, internal none | Every scope checks its root and refuses git-tracked targets; `nukeHere` and symlinked homes checked before teardown; append-only ledger; observation marked incomplete on overflow. **Not reviewed again.** |

## Proportion

Tier 2, security-sensitive. All 6 of 6 rounds were used. Findings narrowed each round, from the core resolver in round 1 to nuke edge cases and ledger concurrency in round 6.

## Left behind

- **Recursive deletes check the top entry only.** This is a stated non-goal, filed as fb-6ad01267-11d.
- **About 400 call sites were not traced one by one.** Their path arguments are named for `.instar` state. The report-mode ledger is the net for any of them.

## Convergence verdict

Not converged. The round-6 design findings are applied in the spec, but no reviewer has read them. A confirmation round is requested before the tag is written.
