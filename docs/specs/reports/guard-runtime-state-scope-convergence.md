# Convergence Report: The source-tree guard's runtime-state rule matches only an instar checkout's own .instar folder

**Status: Spec A (the core, nuke excluded) after its one approved review round. The internal security review found nothing material. The outside reviewers' small design items are applied but not reviewed again. Brought to the Chief of Staff for approval.**

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

| 7 (confirmation, CoS-approved) | codex 4 design, internal material | **Stopped here, per the Chief of Staff's instruction.** Findings: (1) nuke teardown stops sessions by name prefix, so `echo` would also stop `echo-dev`, a pre-existing nuke bug; (2) the root rule lets a caller pass `<checkout>/src`; (3) the tracked-file rule refuses the whole-home nuke removal; (4) the ledger roll is a cross-process read-modify-write with no lock. Brought back to the Chief of Staff with a recommendation to split the spec. |

| Spec A (cut, CoS-approved, one round) | internal none; codex 2 design; cc 2 design | Small design items, applied but not reviewed again: the cross-disk feedback fallback gets no scope (it never fires in practice, and refusal only leaks); classifier read errors count as indeterminate; the report-mode shadow check is fenced; the tracked check is skipped inside `.git`. Brought to the Chief of Staff for approval. |

## Proportion

Tier 2, security-sensitive. All 6 of 6 rounds were used. Findings narrowed each round, from the core resolver in round 1 to nuke edge cases and ledger concurrency in round 6.

## Left behind

- **Recursive deletes check the top entry only.** This is a stated non-goal, filed as fb-6ad01267-11d.
- **About 400 call sites were not traced one by one.** Their path arguments are named for `.instar` state. The report-mode ledger is the net for any of them.

## Convergence verdict

Not converged. The round-6 design findings are applied in the spec, but no reviewer has read them. A confirmation round is requested before the tag is written.

## Approval

Approved by the Chief of Staff, 2026-11-19 01:11 PT (msg 30c7f163): spec A, as a watch-only build. The last small outside-review items were not reviewed again; watch-only mode cannot affect a real delete, and the build's second-pass review covers them. Switching to enforce is a separate decision after the 14 days and spec B, with the disagreement record in hand.
