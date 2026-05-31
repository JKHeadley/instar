# Side-effects — Codex autonomous native /goal auto-wire

## 1. What files/state does this touch at runtime?
`.claude/skills/autonomous/scripts/setup-autonomous.sh` (skill content). At autonomous-mode
activation on a CODEX agent, it now additionally POSTs `/autonomous/native-goal/set` (which the
script already did for Claude>=2.1.139) — injecting `/goal <completion_condition>` into the
session and marking the job `goal_mode:native` in `<topic>.local.md`. No new files, no config
keys, no schema. The PostUpdateMigrator re-deploys the script to existing agents (marker bump).

## 2. Does it change any functional behavior?
- **Claude agents:** none. The Claude version gate is untouched; the codex check only runs when
  the Claude gate already failed.
- **Codex agents:** a codex autonomous job now auto-delegates to native `/goal` (previously it
  fell through to the dark Phase-1 codexLoopDriver no-op and silently never sustained multi-turn).
  The stop-hook's existing `goal_mode:native` branch then defers to native `/goal`.

## 3. What happens on failure / weird config?
Best-effort: the detection one-liner is `... 2>/dev/null || echo "0"`, so a missing/malformed
config.json or absent python → `0` → not-codex → exactly the prior behavior (no regression). A
codex agent whose native `/goal` POST fails → the script prints "Native /goal: unavailable" and
instar's own completion evaluator drives (the existing fallback).

## 4. Migration parity — do existing agents get it?
Yes. `migrateAutonomousStopHookTopicKeyed` marker bumped `native-goal/set` → `IS_CODEX_AGENT`,
so prior native-/goal installs are re-deployed; customized scripts (no stock fingerprint) are
left untouched; already-updated agents skip (idempotent). New agents get it via installAutonomousSkill.

## 5. Could it spam / flood / burn resources?
No. It adds at most one extra `python3` config read + (for codex) one `native-goal/set` POST,
once, at autonomous-mode activation — the same POST the script already made for Claude.

## 6. Rollback / off-switch?
Revert the PR. The marker would revert too; a reverted-version agent retains `native-goal/set`
(still functional for Claude). No residual state, no flag.

## 7. Concurrency / ordering?
None new. Runs inline in the single setup-autonomous.sh activation flow, after the Claude gate.

## Blast radius
Small + additive, codex-only. One ~5-line fallback in setup-autonomous.sh + one migration marker
bump in PostUpdateMigrator. No change to the sensitive stop-hook (the goal_mode:native defer
already existed), no change to the Claude path. Mirrors the #604/#609 codex framework-additive
pattern. The codexLoopDriver:true config footgun is a separate low-pri follow-up (#40 notes).
