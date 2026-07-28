# Side-Effects Review — Existing-Agent PreToolUse Hook Parity

**Spec:** docs/specs/EXISTING-AGENT-PRETOOLUSE-HOOK-PARITY-SPEC.md (approved: true, internal-adversarial review 2026-05-27)

Closes the dark-guardrail migration gap: `init.ts` wired a full instar Bash PreToolUse hook set for NEW agents, but `PostUpdateMigrator.migrateSettings` only ensured slopcheck-guard + the MCP gate for EXISTING agents — so `deferral-detector.js` (the false-blocker pre-filter; this is Task 3 of the silent-stalls postmortem), `grounding-before-messaging.sh`, `external-communication-guard.js`, and `post-action-reflection.js` shipped to disk on every existing agent but were never switched on in settings. Same failure class as the 2026-05-27 silent-stall incident (looks installed, does nothing).

## What changed
- `src/core/instarSettingsHooks.ts` — NEW. Single source of truth for the canonical instar `Bash` and `mcp__.*` PreToolUse hook ENTRIES (`INSTAR_BASH_PRETOOLUSE_HOOKS`, `INSTAR_MCP_PRETOOLUSE_HOOKS`), a `instarHookFilename()` helper, and the idempotent `ensureInstarBashPreToolUseHooks()`.
- `src/commands/init.ts` — refactored the inline `instarBashHooks` / `instarMcpHooks` literals to consume the shared constants (fresh copies via `.map(h => ({...h}))`). Behavior-preserving: byte-identical settings output for new agents (verified by the existing `hook-installation.test.ts`, all green).
- `src/core/PostUpdateMigrator.ts` — `migrateSettings` now calls `ensureInstarBashPreToolUseHooks(preToolUse)` before the slopcheck block; appends only missing canonical hooks, idempotently, reporting each as a `dark-guardrail wiring` upgrade.
- Tests: `tests/unit/instar-settings-hooks.test.ts` (16) + `tests/unit/PostUpdateMigrator-pretooluse-parity.test.ts` (3).

## Over-block / under-block
- UNDER: a custom hook with the same script filename would be treated as "present" and not re-added. Acceptable — that's the intent (don't duplicate). Custom hooks under `.claude/hooks/custom/` have different filenames, so they're never matched/displaced.
- OVER: none. The function only APPENDS missing canonical hooks; it never reorders or removes existing entries, and it touches only the `Bash` matcher. Slopcheck-guard and all non-Bash matchers are untouched.

## Signal vs authority
N/A for blocking — this wires guardrail hooks into settings. Within the false-blocker design, `deferral-detector` is the SIGNAL (non-blocking checklist injection); `MessagingToneGate` B17 is the AUTHORITY (already live). This change lights up the signal layer on existing agents; it adds no new blocking authority.

## Idempotency / migration parity
- IS a migration-parity fix. New-agent path (init.ts) and existing-agent path (migrateSettings) now consume the SAME constant — drift is impossible by construction; an anti-drift unit test locks the canonical filename set.
- `ensureInstarBashPreToolUseHooks` is idempotent (filename-substring presence check, robust to `${CLAUDE_PROJECT_DIR}` vs absolute path); re-runs are no-ops (verified).
- No config or CLAUDE.md change. No new hook scripts (all four already ship + are ESM-safe).

## Interactions
- Runs before the existing slopcheck ensure-block; since it creates the `Bash` matcher when absent, slopcheck's "no Bash matcher" branch becomes a no-op while its "add slopcheck" branch still fires. Both end states verified together in the parity test.
- Codex hooks (`installCodexHooks.ts`, `.*` matcher) are a separate path, intentionally not governed by this module.

## Rollback
Revert the migrator call + the init refactor + delete the shared module (3 files) and the 2 test files. Worst case: existing agents return to the dark-guardrail state.

## Tests
- `tests/unit/instar-settings-hooks.test.ts` (16) — anti-drift contract, filename extraction, add/idempotent/preserve/no-matcher/no-dup/fresh-copy, init-imports-the-constant.
- `tests/unit/PostUpdateMigrator-pretooluse-parity.test.ts` (3) — real `migrateSettings` against a stale agent home: wires the four, idempotent, reports each.
- Regression-safety: `hook-installation.test.ts`, `installCodexHooks.test.ts`, `codexHookContractCanary.test.ts`, `autonomous-skill-deployment.test.ts`, `capabilities-discoverability.test.ts` all green post-refactor.

## NOT in this commit (tracked)
- Notify-on-stop (Task 2 — separate PR/spec).
- Self-propagation harness (Task 4).
