---
title: "Persistent stuck-input sentinel — closes verifyInjection's restart hole"
slug: "stuck-input-sentinel"
author: "echo"
created: "2026-05-11"
supersedes: "none — backstop layer behind PR #159 (v0.28.92) multi-shot verifyInjection"
review-convergence: "2026-05-12T02:43:00.000Z"
review-iterations: 1
review-completed-at: "2026-05-12T02:43:00.000Z"
approved: true
approved-by: "justin (via 'we need a ROBUST fix that detects when text has been injected in the input field but needs ENTER' authorization on topic 7195, 2026-05-11)"
approved-at: "2026-05-12T02:43:00.000Z"
approval-note: "Justin pushed back twice on the prior in-process recovery (v0.28.87 single-shot, v0.28.92 multi-shot polling) after live-reproducing the bug today. Explicit ask: a robust fix that survives the cases the in-process timers can't cover. Plan posted to topic 7195 before build started; the plan named the StuckInputSentinel architecture, the 10s tick, the persistence-to-disk requirement, and the two-fix scope (sentinel + supervisor-preflight follow-up). Approval is the as-built shape — no design pushback received."
---

# Persistent Stuck-Input Sentinel — Restart-Resilient Recovery

## Problem Statement

PR #159 (v0.28.92) added a multi-shot recovery loop inside `SessionManager.verifyInjection`: after every Telegram/Slack message injection, the server arms four polling checks at 500ms / 1500ms / 3500ms / 6500ms. If the marker text is still at the `❯` prompt at any check, it fires an escalating recovery action (Enter → Enter → C-m → Enter+sleep+Enter), bounded at four attempts. This correctly handles the **in-process race** observed on Claude Code v2.1.105+ where the Enter after bracketed-paste-end is occasionally eaten by the paste-end sequence.

The fix is correct but **in-process**. All four polling callbacks live as `setTimeout` handlers inside the server's Node event loop. If the server process exits anywhere in the 6.5-second recovery window — crash, OOM, lifeline-forced restart, segfault during a native module call — every pending timer dies with the process. Any message that was injected just before the crash sits at the `❯` prompt forever.

**Live reproduction, 2026-05-11.** Justin's agent echo entered a 30+ minute server restart cycle. The proximate cause was the `ServerSupervisor.preflight` rebuild for `better-sqlite3` failing on Node v25.6.1 (`spawnSync ENOENT` against the npm CLI path under the supervisor's restricted PATH). The server came up, registered on port 4042, then crashed within ~30s, repeatedly. During this window, Justin sent messages to three different topics. The Telegram-forward path injected each message into its corresponding tmux session via bracketed paste + Enter, then armed verifyInjection. The server crashed before the 6.5s schedule could complete; the timers died; the messages stayed at the `❯` prompt indefinitely. After server recovery, the sessions were idle (no spinner, no "esc to interrupt" hint) but the input still held the original text. `grep "start the rewrite now" ~/.claude/projects/-Users-justin--instar-agents-echo/*.jsonl` returns empty — proving the messages were never seen by Claude Code despite being delivered to the tmux pane.

The user's previous workaround — manually pressing Enter from the dashboard — was the only path that recovered these sessions. Justin's explicit ask: a fix that doesn't depend on the user finding the stuck dashboard tab.

## Goals

1. Recovery from "text at ❯ that never submitted" must survive any number of server crashes.
2. The fix must not race with the existing in-process `verifyInjection` recovery — the fast path (≤6.5s) is correct and should still own the common case.
3. The fix must not fire Enter against a session that's actively working (would interrupt a tool call or turn in flight).
4. The fix must be bounded — never an unbounded retry loop. Four attempts per stuck event matches the existing escalation.
5. Operator audit: every recovery action records to a JSONL log so the failure mode is observable, not silent.

## Non-goals

- We do **not** persist the per-session recovery state to disk. A server restart restarts the sentinel from a clean slate and the next tick picks up still-stuck sessions. Worst case is `N + M` Enters across a crash boundary; after the first successful Enter the prompt clears and subsequent Enters are no-ops against an idle pane.
- We do **not** attempt to send the original message text again. The sentinel only fires recovery keypresses, not paste-replays. If the text is corrupted at the prompt (e.g., user typed over it), the sentinel will detect the new content as a fresh stuck event.
- We do **not** detect or recover from cases where the Claude Code TUI is in a modal state (e.g., a `[Y/n]` prompt that ate the injection's Enter). Pressing Enter in those states takes the default, which is the same behavior the existing verifyInjection has.

## Design

### Component

`StuckInputSentinel` — a new class at `src/core/StuckInputSentinel.ts`. Constructor takes a `SessionManager` reference and options `{ tickMs, minTicksBeforeFire, maxAttempts, stateDir, noPersist }`. Lifecycle: `start()` arms a `setInterval`; `stop()` clears it. `tick()` is the per-poll operation and is public for unit-test driving.

### Tick loop

```
for each session in sessionManager.listRunningSessions():
  pane = sessionManager.captureOutput(session.tmuxSession, 30)
  if pane shows working indicator (spinner glyph OR "esc to interrupt" OR
                                   "ctrl+t to hide tasks"):
    drop per-session record  →  return
  promptText = extractPromptText(pane)
  if promptText is empty:
    drop per-session record  →  return
  if record missing OR record.lastPromptText != promptText:
    record = { lastPromptText, firstSeenAt: now, consecutiveTicks: 1,
               attempts: 0, exhausted: false }
    return
  record.consecutiveTicks += 1
  if record.exhausted OR record.consecutiveTicks < minTicksBeforeFire:
    return
  if record.attempts >= maxAttempts:
    record.exhausted = true  →  return
  sessionManager.fireStuckInputRecovery(session.tmuxSession, record.attempts)
  record.attempts += 1
  append-event-to-JSONL
```

GC: at end of each tick, drop records for sessions that were not present in `listRunningSessions()`.

### Detector heuristics

`extractPromptText(pane: string): string | null`
- Iterate lines bottom-up
- Find the line containing `❯`; take everything after the last `❯` on that line
- If non-empty: return trimmed text
- If empty AND the next line is non-empty content (not a box-border separator or `⏵⏵` footer): return that wrapped content
- Otherwise: null

`isPaneActivelyWorking(pane: string): boolean`
- `true` if pane includes any of `["esc to interrupt", "ctrl+t to hide tasks", "tokens · esc"]`
- Otherwise: `false`

We deliberately **do not** key on line-start spinner glyphs (`✻ ✶ ✺` etc.). Past-tense markers like `✻ Brewed for 14m 11s` and `✻ Churned for 1m 16s` stick around as visible pane content long after the turn finished. Both of echo's 2026-05-11 stuck sessions held one of these stale lines while genuinely idle — keying on the glyph would silently exclude exactly the cases this sentinel exists to recover. The footer hints, by contrast, are structurally only rendered mid-turn by the Claude Code TUI — they're the precise tell for "actually working." A false-positive Enter against an idle prompt is a no-op against an empty input buffer, so being permissive on the "is idle" side is safe; being conservative on the "is working" side is what could cause an interrupt of in-flight work, and that's the exact failure mode the activity-hint check rules out structurally.

### Escalation

Delegates entirely to `SessionManager.fireStuckInputRecovery(tmuxSession, attempt)`, which already implements the escalation:
- attempt 0, 1 → Enter
- attempt 2 → C-m
- attempt 3 → Enter + 150ms sleep + Enter

Visibility relaxed on that method (private → public) plus on `isMarkerStuckAtPrompt` (used by the sibling verifyInjection path). Behavior unchanged.

### Defaults

- `tickMs`: 10_000 (10s)
- `minTicksBeforeFire`: 2 (≥20s after first sighting before first fire — strictly past verifyInjection's 6.5s window)
- `maxAttempts`: 4 (matches verifyInjection's schedule depth)

### Persistence

Append-only JSONL at `<stateDir>/stuck-input-events.jsonl`. One row per fire:
```json
{"ts":"<ISO>","session":"echo-foo","promptText":"<≤200 chars>","attempt":0,"action":"Enter","outcome":"fired"}
```
Best-effort; write failures are logged and the sentinel continues. Operators can `tail -f` this for live observability.

### Wiring

In `src/commands/server.ts`, after `sessionManager.startMonitoring()`:
```ts
const stuckInputSentinel = new StuckInputSentinel(sessionManager, {
  stateDir: config.stateDir,
});
stuckInputSentinel.start();
```
In the shutdown handler, before `topicMemory.close()`:
```ts
stuckInputSentinel.stop();
```

## Why a separate sentinel, not an extension of `monitorTick`

`SessionManager.monitorTick` already iterates running sessions every 5s. Adding stuck-input logic there would tangle two responsibilities (session-completion detection + stuck-input recovery) in one tight loop. Separation keeps the change auditable, lets the sentinel's tick interval and attempt counts evolve independently of session monitoring, and matches the `// Exposed as a method so the StuckInputSentinel and tests can reuse it.` comment that was already in the codebase (left as a placeholder by PR #159 for exactly this follow-up).

## Acceptance criteria

1. `extractPromptText` returns the text after the last `❯` on the prompt line; returns null on empty prompts; handles wrapped multi-line input; rejects box-drawing separators as fake content.
2. `isPaneActivelyWorking` flags spinner glyphs at line-start, "esc to interrupt", and "ctrl+t to hide tasks"; does NOT flag an idle prompt with `⏵⏵ bypass permissions on (shift+tab to cycle)`.
3. First sighting of stuck text never fires recovery. Second sighting (and beyond) fires.
4. Escalation order matches `SessionManager.fireStuckInputRecovery` exactly across attempts 0, 1, 2, 3.
5. After `maxAttempts` fires, the per-session record is marked exhausted and the sentinel stops firing on the same prompt text.
6. Working state in the pane prevents firing regardless of how many ticks have observed the same prompt.
7. Prompt-text change (new content arrives) resets the per-session record to a fresh first-sighting.
8. Prompt clearing (Enter took, or text was deleted) drops the per-session record entirely.
9. Sessions that disappear from `listRunningSessions()` are GC'd from in-memory state.
10. Multiple stuck sessions are tracked independently.
11. `start()` and `stop()` are idempotent.
12. Type-check clean across the whole codebase.

All twelve cases are covered by `tests/unit/StuckInputSentinel.test.ts`.

## Side-effects review

See `upgrades/side-effects/stuck-input-sentinel.md`. Signal-vs-authority compliance: no blocking surface (action surface is one tmux send-keys per attempt). Second-pass review by an independent subagent: concur with two tight-but-acceptable callouts on past-tense churn-glyph false-negatives and 3+ line wrapped-input edge cases — both documented in the artifact.

## Rollback

Pure code addition. Revert the four files and ship the next patch. No schema migration. No agent state repair. The JSONL events log can simply stop being written. Worst-case in-production misfire is a false-positive Enter against an idle prompt — provable no-op.

## Follow-up (out of scope for this spec)

The same 2026-05-11 incident exposed `ServerSupervisor.preflight`'s better-sqlite3 rebuild path: it does the right thing (detect → spawn npm rebuild → verify) but the spawn fails `ENOENT` on a node binary that demonstrably works when invoked directly, leaving the supervisor in a tight restart loop. The vNEXT `NativeModuleHealer` (PROP-399 rebased, PR #157) covers the in-process memory-subsystem path but NOT the supervisor preflight. A follow-up spec will backport the healer's `process.execPath`-pinning + once-per-process guard to the supervisor preflight. Tracking as a separate PR so this sentinel ships immediately for the operationally-blocking case.
