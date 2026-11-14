# Convergence Report — Native Passwords & keys screen

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-tier pass ran through the agent's codex CLI on all 6 rounds, each on a changed spec and module. Gemini was inactive on this machine. Internal Claude lens subagents could not be spawned in the build session, so the author applied those lenses by hand and a Claude clean-door pass (`--family claude-code`, not cross-model) read the final spec and code as the independent second read.

## ELI10 Overview

The iPhone app gets a native Passwords & keys screen. It shows what the agent is waiting for, the names of the keys it holds, whether its vault opens and whether keys sync. It never carries a value, a length, a one-time token or a link. It's the read half of the row: asking for a key and cancelling one stay in the console.

## Original vs Converged

- **Counts are honest.** `count` is keys held, not names shown. Saved submissions are named in the headline, so a vault of only saved drops doesn't read as empty.
- **Either source can say the vault is broken.** Secret Sync's word now overrides a key list that read fine, and a vault check that fails blocks the all-clear.
- **One bad row spoils the list.** Any unreadable row makes that list "can't tell", because it could be the row that matters.
- **Saved drops and hidden names are separate.** A key name that merely looks like a token is withheld and counted as a key, not called a saved submission.
- **Failures are visible.** Wrong-shaped reads are recorded as degradations, so the graduation metric means something.
- **The scope is stated.** The spec says this is a partial delivery of the row and why.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Spec changes |
|-----------|-----------------------|-----------------|--------------|
| 1 | codex | 2 + 1 precision | true key count, two-source vault, date range |
| 2 | codex | 2 + 1 precision | partial-delivery scope stated, wrong shape reported, stricter-than-console headline stated |
| 3 | codex | 1 + 2 precision | partial lists are unknown, saved drops split from hidden names, vault override moved into the route |
| 4 | codex | 1 + 1 precision | failed vault check blocks the all-clear, truncated means the cap |
| 5 | codex, clean-door | 4 from clean-door | peers read across machines, off has its own words, vault states fail closed, wider token shapes |
| 6 | codex, clean-door | 2 + 3 | peer key failures block the all-clear, stricter peer shape, labels stripped of tokens, unknown vault state recorded |

Standards-Conformance Gate: unavailable: the route answered `specPath escapes specsDir` because the spec lives in a worktree, outside the running server's specs folder.

## Convergence verdict

The Tier 2 cap of 6 rounds was reached. Round 5's codex pass read MINOR ISSUES, then the clean-door pass raised the multi-machine false all-clear, which widened the design; round 6 codex read SERIOUS ISSUES on that new peer code and clean-door read MINOR ISSUES. All round 6 design findings were fixed and tested, but no further review ran after those fixes. Left as accepted: a missing `vaultStatus` method reads as not broken; Echo's live check takes the inventory branch only, and the gate-off branch is covered by e2e.
