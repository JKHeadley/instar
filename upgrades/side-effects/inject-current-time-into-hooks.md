# Side-Effects Review — inject current time into agent hooks

**Version / slug:** `inject-current-time-into-hooks`
**Date:** `2026-05-21`
**Author:** `echo`
**Second-pass reviewer:** `not required` (Layer 1 hook-template content change, signal-only, no gate authority — Phase 5 trigger inventory below)

## Summary of the change

`PostUpdateMigrator.getSessionStartHook()` and `getTelegramTopicContextHook()` (the inlined bash templates that get unconditionally overwritten onto every agent's disk on update) now each emit a `--- CURRENT TIME ---` block backed by a fresh `date(1)` invocation. The block contains an ISO-formatted wall-clock timestamp with signed offset and timezone abbreviation, plus a one-line instruction to the agent: "Quote this — do not carry stale clock times from prior context."

**Files touched:**
- `src/core/PostUpdateMigrator.ts` — 14 lines added to `getSessionStartHook()` (after the `=== SESSION START ===` echo, before the TOPIC CONTEXT block); 14 lines added to `getTelegramTopicContextHook()` (immediately before the [telegram:N] early-exit, so the block fires on every UserPromptSubmit regardless of prefix).
- `tests/unit/PostUpdateMigrator-time-injection.test.ts` — new file, 13 test cases. Static assertions on the inlined bash (date format string, non-empty guard, delimiter strings, relative ordering within each hook) PLUS end-to-end `execFileSync` of each hook script against a fresh temp dir, asserting the actual emitted output matches the expected `YYYY-MM-DD HH:MM:SS +ZZZZ (TZ)` shape on a non-telegram prompt, a telegram-prefixed prompt, and a session-start invocation.
- `upgrades/NEXT.md` — new vNEXT entry, classified `patch` (behavior fix, no new surface).

## Decision-point inventory

- **Where the time block lands in session-start output** — *modify*. Placed AFTER `=== SESSION START ===` and BEFORE the TOPIC CONTEXT block. Rationale: the wall-clock is generic orientation, not topic-specific — it belongs at the top of the orientation frame, ahead of the per-conversation context. Asserted by test `places the time block BEFORE the TOPIC CONTEXT block`.
- **Where the time block lands in UserPromptSubmit** — *modify*. Placed BEFORE the `[telegram:N]` early-exit. Rationale: the script's filename suggests telegram-only, but UserPromptSubmit fires on every prompt — emitting the time block before the early-exit makes the fix universal (Telegram and direct-CLI sessions both get it). Asserted by test `emits the time block BEFORE the [telegram:N] early-exit`.
- **Output guard against a broken `date(1)`** — *new*. Wrap the emission in `if [ -n "$NOW" ]; then ... fi` so a hypothetical environment where `date(1)` returns empty (extremely unlikely on macOS/Linux) doesn't produce a `--- CURRENT TIME ---` header with no value. Asserted by test `wraps the emission in a non-empty guard`.
- **Date format choice** — *new*. `'%Y-%m-%d %H:%M:%S %z (%Z)'`. Portable across BSD date (macOS) and GNU date (Linux); produces both machine-parseable (`%z`) and human-readable (`%Z`) timezone forms. Verified by the end-to-end test which `execFileSync`s the hook and regex-matches the emitted body.
- **Delimiter style** — *match existing*. `--- CURRENT TIME ---` / `--- END CURRENT TIME ---` mirrors the dashed delimiters already used in session-start for other blocks (`--- CONVERSATION CONTEXT ---`, `--- INTEGRATED-BEING ---`, `--- PROJECT CONTEXT ---`). No new visual convention introduced.

## Level-of-abstraction fit

This is a Layer 1 (hook content) change. It belongs at the migrator level — both because the migrator is the source of truth for hook content (init and update both write from `getSessionStartHook()` / `getTelegramTopicContextHook()`) and because the failure mode (stale clock in long agent sessions) is a cross-cutting infrastructure gap, not a per-agent or per-feature concern. Solving it per-agent (e.g. Iris's memory file `feedback_clock_time_must_call_date.md`) closed the gap for one agent. Lifting it to the framework means every instar agent gets the same anchor without each one having to learn the lesson independently — which matches the **Structure > Willpower** principle stated in CLAUDE.md.

## Signal-vs-authority compliance

The hook injection emits text. It does not gate, block, modify, or veto any agent action. It is pure signal — the agent reads the wall-clock and is told to quote it. Authority over whether to use the time, what time to claim, or whether to call `date` again later remains entirely with the agent. No new blocking authority introduced.

## Interactions

- **Compaction recovery** (`compaction-recovery.sh`): On `compact` event, `session-start.sh` `exec`s away to `compaction-recovery.sh` BEFORE the time block is reached. So the time block does not run during compact-recovery. Compaction-recovery's own injection pipeline is separate and is not regressed by this change. The block DOES run on resume, which fires after compaction completes. No double-emission.
- **Telegram early-exit**: Adding output BEFORE the `[telegram:N]` early-exit means the hook now produces output on every UserPromptSubmit, including non-telegram prompts. This is intentional — direct-CLI sessions need the time anchor too. Effect on Claude Code: an additional ~3-line block in the agent's prompt buffer per turn. Token cost negligible (~30 tokens).
- **Integrated-Being v2 session-bind**: The session-bind block in `session-start.sh` lives AFTER the time block but runs independently. Time injection produces output via stdout; session-bind makes HTTP calls and writes a token file. No shared variables, no ordering dependency.
- **Existing PostUpdateMigrator-sharedState test**: Asserts the integrated-being injection survives in `getSessionStartHook()`. The new time block sits BEFORE the integrated-being block; the existing assertion (`expect(hook).toContain('/shared-state/render?limit=50')`) continues to pass — verified in test run.

## Over/under-block check

- **Under-block**: Could the fix miss any cases where an agent says a clock time?
  - **Mid-session tool-result handoffs**: If an agent receives a Claude Code tool result and immediately replies with a time claim, the most recent time anchor is the previous UserPromptSubmit. Up to 5 minutes stale in fast back-and-forths, less for slow ones. Acceptable — within a single turn, ±a-few-minutes is fine. Worst-case would be a multi-hour autonomous-mode tool loop without user prompts, in which case the agent could go stale. Mitigated separately by autonomous-mode's existing periodic re-orientation; not in scope here.
  - **Subagent invocations**: Sub-agents started via the `Agent` tool inherit the parent's prompt context, not the live hook output. So a subagent's time anchor is the parent's at-spawn time. Acceptable — subagents are short-lived and rarely make wall-clock claims; their job is task execution.
- **Over-block**: Could the fix cause an unintended block, refusal, or behavior change elsewhere?
  - **Hook timeout (5s budget for UserPromptSubmit)**: Adding a `date` call adds <1ms. No timeout risk.
  - **Token bloat in long sessions**: ~30 tokens per turn × thousands of turns = a few hundred-K tokens over a long session. Compared to the existing telegram-topic-context block (~500 tokens / turn for recent history), this is a rounding error.
  - **Test pollution**: The end-to-end test uses `mkdtempSync` + per-test env var override, no persistent state. No effect on parallel test runs.

## Rollback cost

Two-line `git revert` of the migrator edit, plus deleting the new test file. Hooks are unconditionally overwritten on next migration run, so a revert propagates to all deployed agents on their next `npx instar`. No data migration, no persistent state, no fan-out — zero rollback friction.

## Phase 5 trigger check

Was a second-pass reviewer required? No.

- **Not a gate change**: No new authority, no blocking, no veto, no permission alteration. Signal-only.
- **Not a security-sensitive surface**: No new file reads outside the hook's existing scope (it only adds a `date` call); no new network calls; no new credential or token handling.
- **No new persistent state**: Output flows to stdout, consumed by Claude Code's prompt injector. No disk writes, no SQLite, no JSONL.
- **No cross-agent or cross-machine effect**: Per-agent hook content. No threadline message, no shared state, no remote operation.

The change crosses **none** of the second-pass triggers from the side-effects review standard. A single-pass review by the author with this written record is sufficient.
