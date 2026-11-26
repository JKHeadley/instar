# Convergence report: nuke-c-min

**Spec:** docs/specs/nuke-c-min.md (split from nuke-hardening, which did not converge in 6 rounds).
**Rounds:** 1, as directed by the Chief of Staff (msg 0552571a). Approved by the Chief of Staff (msg 0d86e88d, 2026-11-19 10:55 PT).

## Iteration Summary

- Round 1. Standards-Conformance Gate: ran (5 flags). Cross-model review: codex-cli (gpt-6.2-astra), verdict SERIOUS ISSUES, 3 findings.
  - C1 `git status` may write the index: use `git --no-optional-locks status`; cancellation fixture compares index bytes. Fixed.
  - C2 `status.showUntrackedFiles=no` hides untracked work: pass `--untracked-files=normal`; fixture added. Fixed.
  - C3 "Pushed existing commits" overclaims: report "Git push succeeded"; warn that commits outside the configured push can be lost. Fixed.
  - S1 timeout: today's 30 s push timeout kept unchanged on purpose (strict narrowing). Fixed in text.
  - S2 kept-file notice now offers an agent read-only review with proposals for approval. Fixed.
  - S3 CMT-2025 incident trigger ratified by the Chief of Staff; listed in each stewardship handoff. Fixed.
  - S4 user-role proof on a throwaway agent added. Fixed.
  - S5 parent standards named. Fixed.

## What this spec does, in one paragraph

`instar nuke --here` stops overwriting shared project files with `git checkout HEAD`; it keeps CLAUDE.md, AGENTS.md, GEMINI.md, .gitignore, .claude, .codex, .mcp.json and instar.config.json byte-for-byte and deletes only the checked `.instar` folder. Standalone `instar nuke` stops staging and committing everything before its backup push; it pushes only existing commits and says plainly that uncommitted work is not in the backup. Both changes only remove powers. Nothing new is stopped or deleted.
