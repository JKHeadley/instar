# Side-Effects Review — Slopcheck Guard Hook

**Source:** Cherry-pick from GSD-Instar spike (gsd-executor Rule 3 exclusion)
**Author:** Echo · autonomous run · 2026-05-23

## 1. Over-block
Could over-fire on legitimate installs of new-but-real packages. Mitigation: NEVER blocks — signal-only nudge. Worst case is one extra checklist the agent reads and proceeds past. Familiar packages (in any manifest/lockfile) are silently skipped.

## 2. Under-block
Could miss a slopsquat if it happens to share a token with something in a lockfile. Mitigation: the lockfile presence check is deliberately loose (favors NOT nagging on known-safe). The nudge is a backstop, not the only defense — the agent still reasons about each install. Acceptable: under-block here means "no extra nudge", not "install proceeds unchecked" (the agent always sees the command).

## 3. Level-of-abstraction fit
PreToolUse Bash hook alongside dangerous-command-guard, deferral-detector, grounding-before-messaging. Same layer, same idiom, same generator pattern (PostUpdateMigrator getter).

## 4. Signal-vs-authority compliance
Compliant. Pure pattern-match + lockfile lookup = low-context filter emitting a signal (additionalContext). The agent (full-context authority) decides whether to install. Never blocks.

## 5. Cross-feature interactions
- dangerous-command-guard (PreToolUse Bash, blocking) runs first and independently — no overlap (it blocks destructive commands; slopcheck nudges on installs).
- deferral-detector (PreToolUse Bash) matches communication commands — no overlap with install commands.
- The hook reads project manifests read-only; no mutation, no shared state.
- Edge: `echo npm install foo` would trigger the nudge (regex matches anywhere). Harmless — signal-only, rare, and erring toward caution on anything that looks like an install is the safe direction.

## 6. Rollback cost
Trivial. One generator method, one settings-template entry, one migrateSettings ensure-block, one manifest entry, one known-list entry, one test file. Revert the commit; the hook stops generating and existing copies become inert.

## 7. Migration parity
Full coverage:
- New agents: settings-template.json PreToolUse Bash entry.
- Existing agents: explicit ensure-block in migrateSettings() adds the slopcheck entry to the Bash matcher if absent (idempotent — checks `hasSlopcheck` first).
- Hook script: always-overwritten by migrateHooks() (built-in hook).
- builtin-manifest.json: registered.
- known-builtin-hooks list: registered (orphan-cleanup safe).

## Conclusion
Ship. Real supply-chain defense Instar lacked. Signal-only, trivial rollback, full migration parity. Seven-dimension review clean.
