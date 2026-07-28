# Instar Upgrade Guide — NEXT

<!-- bump: patch -->

## What Changed

`SourceTreeGuard` `sourceTreeReadOk` opt extended to `readSync` (defense-in-depth source-tree check on the read path) + `SOURCE_TREE_READ_TIER_VERBS` expanded to cover the canonical-ref read path the watchdog and reconciler use (`rev-parse`, `ls-tree`, `show`, `log`, `cat-file`, `merge-base`, `remote`). Caught dogfooding Echo on v1.3.38: the previous fix only opened `execSync` to `fetch`, but every downstream readonly verb still tripped the guard. With this PR landed, the watchdog completes a real tick against the agent's own instar source.

## What to Tell Your User

- I can finally complete a real release-readiness watchdog tick against my own checkout. The first dogfood attempt caught a real safety-guard interaction; this update closes the loop so the watchdog can read what it needs without bypassing the broader policy.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| SourceTreeGuard `sourceTreeReadOk` on readSync | Pass `sourceTreeReadOk: true` to `SafeGitExecutor.run` / `readSync` for the read-tier verbs in `SOURCE_TREE_READ_TIER_VERBS` (now `fetch`, `rev-parse`, `ls-tree`, `show`, `log`, `cat-file`, `merge-base`, `remote`) |

## Evidence

7 unit tests covering both `execSync` and `readSync` paths with + without the opt, the closed-set invariant (10 destructive verbs explicitly NOT in the set), and the verbs the canonical-ref read path actually uses. Side-effects: `upgrades/side-effects/source-tree-guard-readsync-bypass.md`.
