<!-- bump: patch -->

## What Changed

Fixed the "session paused" hang: an autonomous session would freeze indefinitely the first time a helper sub-agent (spawned via the Task/Agent tool) ran a shell command. Root cause: a sub-agent does NOT inherit the parent session's `--dangerously-skip-permissions` MODE — confirmed against Claude Code docs, it inherits only the permission RULES from `.claude/settings.json`. With no allow-rules configured, the sub-agent's first `Bash` call surfaced the interactive "This command requires approval" dialog, and in an unattended run there was no human to answer it, so the session sat modal-blocked forever (indistinguishable from "paused"). It affected the whole fleet because every agent shipped with an empty permissions block.

`PostUpdateMigrator.ensurePermissionAllowRules()` now runs inside `migrateSettings()` and adds a `permissions.allow` list for the built-in tools a sub-agent uses (`Bash`, `Read`, `Edit`, `Write`, `Glob`, `Grep`, `Task`, `NotebookEdit`, `WebFetch`, `WebSearch`, `TodoWrite`). Sub-agents inherit permission rules, so the allow-rule is the structural lever that reliably applies — unlike the existing `PermissionRequest` auto-approve hook, which does not reliably fire for sub-agent calls. The migration is idempotent (adds only missing tool names), never touches the operator's `deny`/`ask` lists, and deliberately excludes MCP tools (`mcp__*`) so external/network operations keep their external-operation-gate approval posture. Because it rides `migrateSettings()`, every existing agent picks it up on its next update and every new agent gets it at init (Migration Parity).

Safety is unchanged: the allow-rules only skip the duplicative human-in-the-loop prompt. The PreToolUse guard chain (`dangerous-command-guard`, `external-operation-gate`, `external-communication-guard`, `self-stop-guard`, …) still runs on every tool call and can still block — and the same `migrateSettings()` pass that adds the allow-rules also wires that guard chain (via `ensureInstarBashPreToolUseHooks`, before the allow-rules), so the guards and the allow-rules always arrive together.

## What to Tell Your User

If your agent ever seemed to "pause" mid-task during an unattended/autonomous run — silently stuck and only resuming when you messaged it — this is a common cause: a helper it spawned hit an approval prompt nobody was there to answer. After this update (and a session restart so the new settings load), helper tasks no longer stall on those prompts, so autonomous runs keep moving. Your safety guards are unchanged — every command still passes the same pre-action checks; the only thing removed is the approval pop-up that had no one to answer it.

## Summary of New Capabilities

- `PostUpdateMigrator.ensurePermissionAllowRules()` — adds inherited `permissions.allow` rules for sub-agent built-in tools to every agent's `.claude/settings.json` via the migration path (new agents at init, existing agents on update). Idempotent, non-clobbering of operator `deny`/`ask`, and scoped to local tools (MCP stays gated by the external-operation-gate).

## Evidence

- **Reproduction (2026-06-24):** an unattended autonomous run sat silent for ~68 min; a screenshot showed the session modal-blocked on a sub-agent's `Bash` "This command requires approval" dialog. Confirmed the same class on a second agent (AI Guy). Settings inspection showed the `permissions` block was entirely absent (no allow-rules for sub-agents to inherit).
- **Mechanism confirmed:** Claude Code docs — sub-agents inherit permission RULES but not the permission MODE; PreToolUse hooks run BEFORE permission-rule evaluation and a hook exiting 2 blocks the call even for an allowed tool (so allow-rules cannot weaken the guards).
- **Tests:** `tests/unit/PostUpdateMigrator-permissionAllowRules.test.ts` — 6 tests: adds all sub-agent tools when absent; includes Bash; does NOT blanket-allow MCP; preserves operator allow entries with no duplicates; never touches deny/ask; idempotent on second pass. All passing. Adjacent `PostUpdateMigrator-cleanupPeriodDays.test.ts` (same migrateSettings path) still green. `npm run build` green.
- **Second-pass review:** independent reviewer concurred; verified the safety argument against the docs and confirmed the guard chain is wired in the same migration pass, before the allow-rules.
