# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Fixes a severe regression in codex-routed INTERNAL LLM calls introduced by upgrading the host `codex` CLI from 0.137.0 to 0.144.0 (2026-07-09). codex 0.144's `codex exec --json` emits its final `agent_message` and `turn.completed` events, then LINGERS ~16-30s before writing the `--output-last-message` file and exiting — a shutdown-linger regression that scales with host concurrency. Because `CodexCliIntelligenceProvider.evaluateExecJson` waited for the child process to exit before accepting a result, the 30s `DEFAULT_TIMEOUT_MS` was firing on ALREADY-COMPLETED calls, recording them as timeout errors (many carrying real token usage, since `turn.completed` had already been parsed). On this host the TopicIntentExtractor went from ~28% errors to 46/50 in an hour (~92%). The lingering processes also held host spawn-cap slots for the entire linger, backing up the queue and pushing even more calls past 30s.

The fix adds an early-terminal-settle path to the codex adapter transport (`spawnCodexExecJson`): the provider now captures the agent's final answer from the structured `item.completed` → `agent_message` → `text` event, and once BOTH that answer and `turn.completed` are observed, settles the call using the result already in hand rather than waiting for codex's deferred exit. A brief grace (default 750ms) lets a promptly-exiting CLI settle the old way (file-authority, byte-for-byte unchanged); only when the process is still lingering past the grace does the adapter settle from the event and reap the lingering child, freeing the spawn-cap slot immediately. The change is confined to the codex adapter layer — no routing/gating semantics change. It cannot mask real failures: only codex's own `turn.completed` success signal triggers the early settle, so a `turn.failed` (or a call that never completes) still fails through the existing error path.

## What to Tell Your User

- **Faster, far more reliable background thinking on codex**: "After the codex tool updated, a lot of my quick behind-the-scenes checks were failing because the tool started dawdling for half a minute after it had already finished answering, and my cutoff was killing those finished calls. I now grab the answer the instant the tool says it's done, so those checks work again and finish sooner."
- **Nothing for you to do**: "This is automatic and on by default. Real failures still fail honestly — I only take the early answer when the tool actually reports success."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| codex exec-json early-terminal-settle (0.144 linger fix) | automatic |
| Revert codex calls to plain-output mode | set intelligence.codexExecJson to false (or env INSTAR_CODEX_EXEC_JSON=0) |

## Evidence

Reproduced live on the affected host (codex-cli 0.144.0 at `/Users/justin/.asdf/shims/codex`) with instar's EXACT internal spawn (same argv, `buildCodexChildEnv` allowlist, empty mkdtemp `--cd`, prompt on stdin):

- Live metrics BEFORE the fix — `GET /metrics/features?feature=TopicIntentExtractor` (last hour): `errors: 46 / 50`, `p50LatencyMs: 30027`, `p95: 30227`, `maxLatencyMs: 30586` (pinned at the 30s DEFAULT_TIMEOUT_MS = timing out), byModel `gpt-5.4-mini/codex-cli`: 32 errors, `errorRowsWithUsage: 18` (turn.completed had been parsed — the API fully answered, then the call errored).
- Root-cause measurement: emitting `turn.completed` and process `close` were timestamped. At N=2 concurrency, POST-TURN-GAP was 9.6s and 13.4s (both exit 0, file written); at N=3, 16-18s. The `--output-last-message` file was observed to be written only at `close` (~25s AFTER turn.completed), NOT at turn.completed time — so the result is not in the file when the timeout fires, but the identical text IS in the `agent_message` event.
- After the fix (fixed transport logic validated against REAL codex 0.144, N=4 concurrent): all four calls settled with `terminalCompletion: true` and correct results at ~turn.completed time (reaped at turn.completed + 750ms) instead of waiting out the 16-30s linger; no call was discarded as a timeout on a completed turn.
- Failing-test-first: three new tests fail against the pre-fix code (transport linger test settles at 5155ms > the 2500ms bound; the two provider linger tests time out at 15000ms) and pass after the fix. A negative test asserts a `turn.failed` stream is still a failure. Full affected suites green (`codex-exec-json-spawn` 15/15, `codex-cli-provider-execjson` 19/19, plus the codex usage/env/attribution suites 67/67).
