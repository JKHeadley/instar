# Side-Effects Review — Codex 0.144 internal-call linger (early-terminal-settle)

**Version / slug:** `codex-0144-internal-call-linger`
**Date:** `2026-07-09`
**Author:** Echo (autonomous)
**Tier:** 1 (small, low-risk, adapter-layer-only bug fix; no gating/routing/dev-gate surface)
**Second-pass reviewer:** self (fresh second pass); reviewer-concurred

## Summary of the change

codex-cli 0.144.0 (host upgrade 2026-07-09, needed for GPT-5.6) regressed `codex exec --json` shutdown: the process emits its final `agent_message` + `turn.completed`, then LINGERS ~16-30s (scaling with host concurrency) before writing `--output-last-message` and exiting. `CodexCliIntelligenceProvider.evaluateExecJson` waited for process exit before accepting the result, so the 30s `DEFAULT_TIMEOUT_MS` killed ALREADY-COMPLETED calls (recording ~92% errors on the affected host, 18/32 codex error rows carrying real usage). Lingering processes also held host spawn-cap slots for the whole linger, compounding the backlog.

The fix adds an opt-in early-terminal-settle to the codex adapter transport, driven by the provider:
- `spawnCodexExecJson` gains `settleOnTerminalLine?(line) => boolean` + `terminalSettleGraceMs` (default 750ms) and an `ExecJsonResult.terminalCompletion` flag. On the first true predicate, the child gets the grace to exit on its own; if still running, the promise settles (`terminalCompletion: true`) after the final flush and the lingering child is reaped (SIGTERM → sigkillGrace → SIGKILL, both unref'd).
- `CodexCliIntelligenceProvider.evaluateExecJson` captures the agent's final answer from the structured `item.completed`→`agent_message`→`text` event, passes `settleOnTerminalLine = () => sawTerminalTurn && agentMessageText !== null`, and on `terminalCompletion` returns the captured text (finalizing usage as success) instead of reading the deferred file.

Files modified:
- `src/providers/adapters/openai-codex/transport/codexSpawn.ts` — new `settleOnTerminalLine` + `terminalSettleGraceMs` options, `terminalCompletion` result field, `armTerminalReap()` grace+reap, `settle({terminal})` variant, `emitLine` terminal-detection hook.
- `src/core/CodexCliIntelligenceProvider.ts` — `tryParseCodexResultEvent()` (typed, top-level parse of `turn.completed` / `agent_message.text`), agent-message capture in `onLine`, `settleOnTerminalLine` wiring, and the `terminalCompletion` early-return in `evaluateExecJson`.
- `tests/unit/codex-exec-json-spawn.test.ts` — transport early-settle tests (linger → fast settle + reap; prompt-exit → normal path, `terminalCompletion` false).
- `tests/unit/codex-cli-provider-execjson.test.ts` — provider tests (event-sourced result + fast settle; funnel records SUCCESS/noop with usage, not error; `turn.failed` still fails; `turn.completed` without agent_message falls through to the file path).

## Decision-point inventory

- **Added (transport)**: `spawnCodexExecJson` terminal-line detection in `emitLine` — a *settlement-timing* decision (when to accept a completed result), NOT a message-flow or authority gate. Only fires when the caller supplies `settleOnTerminalLine`; every existing caller that omits it is byte-for-byte unchanged.
- **Added (provider)**: `evaluateExecJson` result-source selection — on `terminalCompletion`, the result comes from the structured `agent_message` event instead of the `--output-last-message` file. This is the one behavior reversal of note (see below); it is confined to the linger regime and to codex's own typed final-answer field.
- **Unchanged**: exit-code classification, file-authority read for prompt-exiting CLIs, the `intelligence.codexExecJson` kill-switch (plain mode), env allowlist (`buildCodexChildEnv`), usage accounting, out-dir lifecycle/sweep, timeout/SIGTERM/SIGKILL machinery for non-terminal paths.

## Signal-vs-Authority note (the one deliberate reversal)

The pre-fix code read the result ONLY from `--output-last-message` ("events are observability signal, the file is authority"). On the early-terminal-settle path the result is instead read from the `item.completed`→`agent_message`→`text` event. This is safe and semantically identical:
- codex writes `--output-last-message` FROM that same last agent message — the bytes are identical.
- Extraction is a TYPED, top-level `JSON.parse` with explicit shape checks (`type === 'item.completed'` && `item.type === 'agent_message'` && `typeof text === 'string'`) — the same trust surface the usage parser already applies to `turn.completed.usage`. It is NOT substring/regex matching over loose stdout (model content embedded in a string field cannot match a top-level parse).
- The file-authority path REMAINS the behavior whenever the process exits within the grace (any non-lingering CLI) and whenever a turn produced no agent_message (falls through). The divergence is confined to the codex-0.144 linger regime.

## Roll-up across the seven review dimensions

1. **Over-block**: none. No gate tightened. A prompt-exiting CLI is unchanged; a `turn.completed`-without-message call still reads the file.
2. **Under-block / masking real failures**: none. Early-settle fires ONLY on codex's own `turn.completed` success event AND a captured answer. `turn.failed` (genuine failure) never emits `turn.completed` → still throws via the existing error path (unit-tested). A call that never completes still hits the timeout and fails.
3. **Idempotency / double-settle**: `armTerminalReap` guarded by `terminalArmed`; `settle()` guarded by `settled`; the child's later exit/close is a no-op once settled. Reap timers are unref'd (never hold the event loop).
4. **Resource safety**: the fix REDUCES footprint — lingering processes are reaped ~16-30s earlier, freeing host spawn-cap slots sooner (the systemic backlog relief). SIGKILL backstop reaps a SIGTERM-ignoring child. Same grandchild-reap posture as the pre-existing timeout kill (no new leak class).
5. **Usage accounting**: `settle()` runs the final flush BEFORE resolving, so `turn.completed`'s usage reaches the accumulator; `finalize({ success: true })` records it — a completed call now correctly books a SUCCESS row with usage instead of an error row.
6. **Concurrency**: validated against real codex 0.144 at N=4 concurrent — all settled `terminalCompletion: true` with correct results.
7. **Rollback**: `intelligence.codexExecJson: false` (or `INSTAR_CODEX_EXEC_JSON=0`) restores plain-output mode (no exec-json, no early-settle) byte-for-byte. Setting `terminalSettleGraceMs` very high effectively disables early-settle (behaves like the old wait-for-exit).

## Tracked follow-ups (NOT in this PR)

- **#1410 non-gating swap-to-pi timeout (5s)**: pi-cli cold-start exceeds the global `swapAttemptTimeoutMs` default (5000, `commands/server.ts`), producing `nongating-swap-attempt-timeout: pi-cli` degradations with zero usage. DEFERRED: the 5s cap applies to BOTH gating and non-gating swaps, so a blanket bump would slow every gating gate's fail-closed (responsiveness) path; a properly-scoped non-gating-only (or per-framework `pi-cli`) timeout needs its own design + soak. This PR's primary fix removes the codex failures that TRIGGER those swap attempts, so their volume drops without touching the timeout.
- **Intelligence calls load `~/.codex/config.toml` MCP servers** (playwright via npx, threadline) per call. Disabling MCP (`-c mcp_servers={}`) did NOT remove the 0.144 linger (still 16-22s), so it is not the root cause; but skipping MCP load for pure text-classification calls remains a worthwhile separate hygiene optimization.

## Class-Closure Declaration (display-only mirror)

- **`defectClass`** — `unbounded-self-action` (the change adds a `child.kill(SIGTERM)` → `SIGKILL` reap in `spawnCodexExecJson.armTerminalReap`, which the Self-Action Convergence gate keys on).
- **`closure`** — `n/a` (negative declaration) — this is NOT a self-triggered control loop, so no convergence guard/ratchet is required.
- **`reason`** — One-shot, per-call child-process reap: when a single `codex exec --json` call's turn completes but its OWN child lingers past the grace, that one child is reaped exactly once (SIGTERM + a single unref'd SIGKILL backstop) at that call's settlement. There is no loop, respawn, retry, or feedback controller — the reap count equals the call count, itself bounded by the host spawn-cap. It cannot storm under sustained pressure because it does not re-arm, re-spawn, or re-drive anything; it only cleans up the one child of the one call that is settling.

## Migration parity

No agent-installed file changes (no `.claude/settings.json` hooks, no `.instar/config.json` defaults, no CLAUDE.md template capability, no hook scripts, no built-in skills). Pure `src/` adapter behavior — reaches every agent on `pnpm build` / update with no `PostUpdateMigrator` entry required.
