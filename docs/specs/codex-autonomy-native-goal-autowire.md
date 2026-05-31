---
title: Codex autonomous mode — auto-wire native /goal delegation (Claude parity)
slug: codex-autonomy-native-goal-autowire
date: 2026-05-31
author: echo
status: approved
review-convergence: internal-plus-second-pass-2026-05-31
approved: true
approved-by: Justin (Telegram topic 13435, 2026-05-31 08:46Z — "Yes, please proceed. I'll go with your recommendations for all of these")
approval-note: >
  Justin explicitly greenlit this (the headline codex/Claude parity item) with "go with your
  recommendations." FULL Claude/Codex parity is a stated tenet. The fix proved surgical after
  reading the code (verify-don't-infer): the native /goal auto-delegation already exists in
  setup-autonomous.sh but was gated on a Claude-CLI-only version check that excludes codex.
second-pass-required: false
second-pass-status: n/a-additive-codex-branch-claude-path-unchanged
eli16-overview: codex-autonomy-native-goal-autowire.eli16.md
---

# Codex autonomous mode — auto-wire native /goal delegation

## Background — the headline parity gap, grounded

A Claude agent in autonomous mode auto-sustains multi-turn work: the autonomous-stop-hook
re-prompts on each Stop until the goal/duration is met. A **codex** agent could not — `codex
exec` runs one turn and stops. Round 2 proved (live) that codex CAN sustain multi-turn
**natively via `/goal`** (instar's Phase-2 "native /goal delegation": inject `/goal
<condition>` + mark the job `goal_mode:native`; the stop-hook then defers to native /goal).

Reading the code revealed the auto-delegation **already exists** in
`.claude/skills/autonomous/scripts/setup-autonomous.sh` — but it is gated on
`claude --version >= 2.1.139` (lines ~205-213). For a codex agent, `claude --version` is
empty/fails, so `NATIVE_GOAL_OK` stays false and the codex autonomous job falls through to
Phase-1 (the `codexLoopDriver` flag, which ships dark → a no-op). Net: **a codex agent's
autonomous mode silently never sustains multi-turn**, even though codex has native `/goal`.

## Design

In `setup-autonomous.sh`, after the Claude-CLI version gate, add a framework-aware fallback:
if `NATIVE_GOAL_OK` is still false, detect a codex agent via config `enabledFrameworks`
containing `codex-cli` and set `NATIVE_GOAL_OK=true`. The existing delegation block then
POSTs `/autonomous/native-goal/set` (inject `/goal <completion_condition>` + `goal_mode:
native`), and the **already-present** stop-hook `goal_mode:native` branch defers completion
to native `/goal`. So codex autonomous mode now auto-sustains via native `/goal` — Claude
parity — with **no change to the sensitive stop-hook** and **no change to the Claude path**
(the Claude version gate is untouched; codex is an additive fallback).

```
IS_CODEX_AGENT=$(python3 -c "import json;print('1' if 'codex-cli' in
  (json.load(open('.instar/config.json')).get('enabledFrameworks') or []) else '0')" 2>/dev/null || echo "0")
[[ "$IS_CODEX_AGENT" == "1" ]] && NATIVE_GOAL_OK="true"
```

## Migration parity

`setup-autonomous.sh` is skill content; `installAutonomousSkill()` is install-if-missing, so
existing agents only get it through `PostUpdateMigrator.migrateAutonomousStopHookTopicKeyed`,
which overwrites the deployed script from the bundled copy gated on a content marker. The
marker is bumped `native-goal/set` → `IS_CODEX_AGENT`: a prior native-/goal install carries
`native-goal/set` but not `IS_CODEX_AGENT`, so it is re-deployed; customized scripts (no stock
`autonomous-state.local.md` fingerprint) are left untouched; agents already on the new version
skip (idempotent).

## Safety
- Additive codex fallback — the Claude version gate and the entire Claude path are byte-for-byte
  unchanged. Best-effort (`|| echo "0"`); a config read miss → not-codex → prior behavior.
- No change to the stop-hook (the goal_mode:native defer already exists and is proven).
- Worst case (detection fails): codex falls back to prior behavior (Phase-1 no-op) — no regression.

## Test plan
- Unit (`autonomous-codex-native-goal-detection.test.ts`): both sides of the decision boundary —
  codex (enabledFrameworks⊇codex-cli) → enable; Claude / absent → skip; multi-framework⊇codex →
  enable; missing config → best-effort skip.
- Unit (`PostUpdateMigrator-autonomousStopHook.test.ts`, extended): a prior native-/goal setup
  (marker `native-goal/set`, no `IS_CODEX_AGENT`) is re-deployed by the marker bump; existing
  cases (old→per-topic, customized-untouched, idempotent, run()-wired) stay green.
- LIVE-VERIFY (the real proof): drive Codey to run the actual `/autonomous` skill (not a manual
  native-goal call) and confirm setup auto-delegates → codex autonomous sustains multi-turn.
