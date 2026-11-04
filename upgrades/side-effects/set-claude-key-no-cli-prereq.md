# Side-Effects Review — set-claude-key no longer requires the Claude CLI
**Version / slug:** `set-claude-key-no-cli-prereq`
**Date:** `2026-11-04`
**Author:** `Dawn (ci-monitor)`
**Second-pass reviewer:** `not required`

## Summary of the change
Tier 1, 1 file, ~5 LOC. `src/commands/setClaudeKey.ts` derived its state dir via `loadConfig(opts.dir)`, which enforces the framework prereq (Claude CLI binary). It now computes `path.join(opts.dir || detectProjectDir(), '.instar')`, the identical expression `loadConfig` uses. Fixes main CI run 41830360617 (`tests/e2e/claude-key-alive.test.ts`: "Claude CLI not found" on runners without claude). Effort: 1 commit attempt refused by the gate for the missing artifact, then this.

## Decision-point inventory
None added or changed. The key-shape check (`looksLikeClaudeToken`) is untouched.

## 1. Over-block
Removes an over-block: setting a key was refused on a machine without the Claude CLI.

## 2. Under-block
`loadConfig` also validated the config file (secret placeholders etc.). The command only writes one field through `writeClaudeKeyToConfig`, which reads and rewrites the JSON itself, so that validation was never load-bearing here.

## 3. Level-of-abstraction fit
Yes: the command needs a path, not a booted config.

## 4. Signal vs authority compliance
No blocking authority added.

## 4b. Judgment-point check (Judgment Within Floors standard)
No heuristic added.

## 5. Interactions
A running server still picks the key up from config.json as before.

## 6. External surfaces
CLI behaviour only: the command now succeeds where it used to throw.

## 6b. Operator-surface quality (Operator-Surface Quality standard)
Not an operator surface.

## 7. Multi-machine posture (Cross-Machine Coherence)
Per-machine config write, unchanged.

## 8. Rollback cost
Revert the one commit.

## Conclusion
Safe, narrow fix for a red main.
