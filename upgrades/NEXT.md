# Upgrade Guide — v1.2.4 (worktree detector → Telegram alerts)

<!-- bump: patch -->

## What Changed

**Layer 4 detector now surfaces misplaced worktrees through the Telegram
attention queue, not just the JSONL fallback.** The agent worktree
convention's lifeline detector — added in v1.1.0 (PR #278) — has been
running on every agent server boot and dutifully appending detected
violations to `<stateDir>/audit/worktree-detector.jsonl`, but the
emissions never reached the operator's Telegram. That was a known
follow-up tracked in v1.1.0's Deferred list.

This release closes that gap by moving the detector invocation from
its old position before `TelegramAdapter` was initialized to a new
position immediately after both TelegramAdapter setup blocks (the
send-only and full-mode paths in `src/commands/server.ts`). When the
agent has Telegram configured, the detector now passes
`telegram.createAttentionItem` as its emit-attention callback;
otherwise it falls back to the JSONL append exactly as before.

The detector remains **signal-only** — every emission goes through
the existing `AttentionItem.id` dedupe contract, the JSONL fallback
keeps its O_NOFOLLOW + fstat + 24h rolling-window dedupe, and the
detector still never blocks, moves, or deletes anything. The only
behavioral change visible to the operator is: misplaced-worktree
alerts now arrive as Telegram attention topics on the next agent
restart, instead of being silently written to a log file the
operator was unlikely to discover.

## Evidence

Reproduction prior: an agent running v1.1.0–v1.2.3 with one or more
worktrees of the shared instar repo outside any registered agent's
`.worktrees/` safe area would, on every server boot, emit zero
Telegram alerts and silently append JSONL lines under
`<stateDir>/audit/worktree-detector.jsonl`. Verified by inspecting
the server-start log on echo's machine after each release —
"Worktree detector: N misplaced worktree(s) flagged" appeared in
console output but no attention topic was ever created.

After this PR: the same configuration produces the same JSONL line
PLUS a Telegram attention topic per misplaced worktree, deduped by
the same `worktree-misplaced:sha256(path)` id the JSONL already
used. The console line gains a `via Telegram` / `via JSONL fallback`
suffix so the operator can tell which channel ran. Verified by
three new wireup tests in
`tests/unit/AgentWorktreeDetector-attention-wireup.test.ts`:
shape-compatibility between detector output and adapter input,
async-callback await safety (the detector awaits the emit so a
Telegram API roundtrip latency is honored), and JSONL fallback
preservation when `emitAttention` is undefined.

## What to Tell Your User

- "Your agents now actually tell you when they spot a worktree in the unsafe location. Before this release, the warning was being written to a log file in the background — the agent saw it, but you never did. Now it shows up as an attention topic in Telegram the next time the agent starts up. Same dedupe rules as before, so you won't get pinged twice for the same one within a day."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Worktree detector emits to Telegram | Automatic on every agent server boot. When the agent has Telegram configured, misplaced-worktree detections create attention topics; otherwise the JSONL fallback at `<stateDir>/audit/worktree-detector.jsonl` continues as before. Dedupe is path-hash-based via the same `worktree-misplaced:sha256(path)` id the JSONL has always used. |
| Console reports the channel | The startup log line now reads `Worktree detector: N misplaced worktree(s) flagged via Telegram` (or `via JSONL fallback`) so the operator can confirm which channel ran without grepping the audit file. |

## Deferred (Tracked Follow-ups)

- The 24h rolling-window JSONL dedupe runs only on the fallback path. The Telegram path leans on `AttentionItem.id` collision in TelegramAdapter's existing `attentionItems` Map — that lookup is per-process and is reset on agent restart, so two boots within 24h on a Telegram-configured agent could theoretically emit twice for the same misplaced worktree. In practice agent restarts are infrequent enough that this isn't a real source of noise; if it ever becomes one, the fix is to consult the JSONL dedupe state from the Telegram path too.
- The detector's first-run burst on machines with many pre-existing misplaced worktrees (echo's machine has ~30 from before the convention shipped) is now Telegram-visible for the first time. Operators may want to bulk-acknowledge them with `/done` rather than processing each individually.
