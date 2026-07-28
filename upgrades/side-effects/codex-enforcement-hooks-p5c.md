# Side-Effects Review: Codex enforcement hooks — P5c (the guard actually fires)

## Change
Two source fixes that make the Codex PreToolUse gate actually fire on the real Codex engine (previously it was registered but silently never invoked):

1. **`src/core/installCodexHooks.ts`** — PreToolUse + PermissionRequest matcher changed `'*'` → `'.*'`. Codex treats the matcher as a regex against the tool name; a bare `*` is an invalid quantifier (no preceding atom) that matches nothing, so the gate never fired. `.*` matches all tool calls.
2. **`src/core/PostUpdateMigrator.ts`** (dangerous-command-guard + grounding-before-messaging generators) and **`src/commands/init.ts`** (inline dangerous-command-guard) — the stdin shim now reads `tool_input.command OR tool_input.cmd`. Codex's shell tool is `exec_command` and delivers the command in `tool_input.cmd`; Claude uses `tool_input.command`. The prior shim read only `command`, so even when fired against Codex it saw an empty string.

## Why
Live verification (host codex-cli v0.133.0, interactive, hooks trusted) showed SessionStart + UserPromptSubmit hooks fired but the PreToolUse dangerous-command-guard did NOT — even trusted. Diagnosing from the Codex session rollout log revealed the matcher was an invalid regex AND the command field name differed. The earlier P5b conclusion ("root cause = hook-trust model") was a red herring for the non-firing symptom: trust gates whether hooks run at all, but with trust granted the guard still failed to fire for these two reasons.

## Scope / blast radius
- Codex agents only in effect: `.codex/hooks.json` is written solely for `enabledFrameworks.includes('codex-cli')`. Claude-only agents are unaffected (the guard scripts gained a stdin fallback that is inert when `$1` is supplied — Claude's existing arg path is unchanged and still tested).
- With matcher `.*`, all three PreToolUse hooks now fire on every Codex tool call. Verified non-harmful: `external-operation-gate.js` exits 0 for any non-`mcp__*` tool (so `exec_command` passes straight through); `grounding-before-messaging.sh` only blocks when the command matches its messaging regex; `dangerous-command-guard.sh` only blocks catastrophic/risky patterns. No false-block surface introduced.
- The `cmd`-field fallback is additive: `command or cmd or ''`. Claude payloads (`command`) are read first and unchanged.

## Signal vs Authority / over-block
- Unchanged authority model: hooks remain low-context triggers that exit-2 on deterministic catastrophic patterns or route to the server-side gate. No new block patterns added; only the delivery (matcher + field) was corrected so existing patterns reach the guard.

## Migration parity
- Both the init generator (`init.ts`) and the update generator (`PostUpdateMigrator.ts`) carry the shim fix, so new AND existing Codex agents get the working guard. The matcher fix lives in `installCodexHooks.ts`, called from both `refreshHooksAndSettings` (init) and `migrateHooks` (update, P3).

## Live proof (evidence bar)
Regenerated codey's hooks from freshly-built source via the real `refreshHooksAndSettings` path (no hand-patch, no debug instrumentation), launched real interactive Codex 0.133, instructed it to run `echo 'rm -rf /'` → Codex displayed `• PreToolUse hook (blocked) — BLOCKED: Catastrophic command detected: rm -rf /` and did not execute it. First confirmed firing of the Codex enforcement guard in the real engine. Before the fix the identical setup ran the command unblocked.

## Tests
- `tests/integration/codex-dangerous-command-block.test.ts` rewritten to the verified Codex shape (`tool_name: 'exec_command'`, `tool_input: { cmd, yield_time_ms }`) — would have failed before the `cmd` shim; plus a Claude-stdin (`command`) case so both field paths are covered.
- `tests/unit/installCodexHooks.test.ts` asserts `PreToolUse`/`PermissionRequest` matcher === `'.*'` (regression guard against the invalid `*`).
- Full codex suite: 19 green (7 + 3 + 3 + 6). tsc clean.

## Rollback
- Revert the matcher to its prior value and drop the `cmd` fallback in the three generators. No data migration. (Rollback re-breaks Codex enforcement — not advised.)

## Follow-on (tracked, NOT deferred-broken)
- **P6a managed hooks**: trust remains a separate concern — even `--dangerously-bypass-hook-trust` still pops an interactive trust prompt + a model-upsell prompt (would freeze unattended autonomy), and a trust-gated hook lets the agent decline ("continue without trusting"), so it can disable its own guard. Managed hooks (run-by-policy, agent-can't-disable) fix both. Genuine design fork → paused for Justin's input. Does not block this correctness fix shipping.

## Publish
- Feature branch `echo/codex-enforcement-hooks`. Targets release v1.2.57 once P6 (awareness + crossreview) completes.
