# Convergence Report: The worktree reaper archives the repo's own generated files

## Cross-model review: codex-cli:gpt-6-astra

The GPT-tier review ran in all four rounds, through the codex CLI with model gpt-6-astra. A clean-door Claude read (claude-code, claude-opus-5-5) also ran each round; it is a second read, not a cross-model opinion. An internal reviewer checked every version against the code in `src/monitoring/agentWorktreeGit.ts` and `AgentWorktreeReaper.ts`. The Standards-Conformance Gate ran six times.

## ELI10 Overview

The agent makes a lot of working copies of its own code. A cleanup tool is meant to remove old ones, but it keeps almost all of them. Of 278 checked, it would remove one. Most are held back only by small files the build and checking tools write by themselves.

This change lets the cleanup recognise those files, and only when nothing can be lost:
- one file (the rules copy) must match the version saved in git, byte for byte;
- every other listed file is saved to an archive and checked byte for byte before a copy is removed;
- right before removal, everything is checked once more, and any change keeps the copy.

The cleanup still only reports. Real removal is a separate decision, made with the new numbers.

## Original vs Converged

- **The original tried to prove each generated file untouched,** using its record file, the husky install output or its JSON shape. Review showed those proofs are weak: a record can be edited along with its payload. The converged design proves only what git itself holds (the registry copy against the HEAD blob) and archives the rest.
- **Wholly ignored folders** (`.husky/_/`, `.instar/audit/`) come back from git as one entry. They are now read one level deep, with every child checked.
- **The archive is never pruned,** in line with "Archiving May Never Mean Deleting". Its growth is measured: about 1.6 MB per worktree. Copies stream in bounded memory, use a temporary name, and are renamed only once they verify.
- **A final fresh re-check sits right before removal:** a full manifest re-list, a re-hash, then a fresh process scan. The remaining instant is stated as an accepted residual.
- **The expected effect is stated honestly.** At most about 123 worktrees become eligible, because 28 hold a real `node_modules`. This clears part of the backlog; it does not stop the daily growth.

## Iteration Summary

| Round | Standards-Conformance Gate | Material / design findings | Outcome |
|---|---|---|---|
| 1 | ran (2 flags: weak proof, parent), then 1 (quotas) | internal 1 material, codex 3 design, cc 3 design | switched to archiving instead of proving; folder expansion; streaming; cwd audit path |
| 2 | ran (2 flags: free-space margin, writer claim) | internal no material, codex 2 design, cc minor | HEAD-blob proof; husky archived; final re-check; accepted residual |
| 3 | ran (1 flag: closed list, accepted) | codex 1 design (manifest re-list), cc minor | manifest compare; dry-run projections; expected effect |
| 4 | ran (same accepted flag) | internal 1 precision (cached scan), codex minor, cc minor | fresh scans; temp-rename copy; live-removal precondition |

## Left behind (accepted, with reason)

- **Closed path list, one level deep.** This is the fail-closed floor for an irreversible removal. Paths are added only with a named writer and a measurement.
- **An outside writer in the last instant before removal.** The existing gate-record path has the same kind of window. No lock exists that every writer honours.
- **Live removal stays off.** Before it is turned on, the per-removal synchronous process scans must run off the main thread, or the per-pass cap must be lowered with the measured scan time.

## Approval

Waiting for the Chief of Staff (plan approved, msg 366ce3fe).
