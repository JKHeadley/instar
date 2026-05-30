# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**1. The mentor autonomous-fix loop now spawns its per-cycle session with NO
project MCP servers — fixing a headless boot-hang found by dogfooding the loop
live.**

The loop (shipped dark in v1.3.109) starts a full-tool Opus session each cycle. A
headless `claude -p` spawn inherits the project `.mcp.json`, which includes
interactively-authenticated remote MCP servers (Fathom's `mcp-remote`, the
claude.ai connectors). Those can't complete their OAuth handshake headless, so
the session hung on MCP boot — observed live at ~4.5 min, 0.1% CPU, no transcript,
parked event loop — and never ran its cycle. The spawn was otherwise correct
(opus, full tools, the real goal); only MCP-loading jammed it.

The loop session now spawns with `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`
(zero MCP servers). It needs none — it drives the mentee over Telegram and ships
fixes with built-in tools. A headless spawn that stalled now boots in ~9s. The
flag is opt-in (`spawnSession({ disableProjectMcp: true })`); every other spawn
keeps its MCP. The `--allowedTools` and new MCP-disable splices are unified in one
tested pure helper (`claudeHeadlessExtraFlags`).

**2. Throttled sessions can no longer hang forever on a 429 — the RateLimitSentinel
now actually fires.** The sentinel that's supposed to ride out Anthropic's
server-side capacity throttle ("Server is temporarily limiting requests · not
your usage limit") was built, wired, and enabled — but in the field it had fired
**zero** times. Sessions would sit dead for 5–10 minutes after a throttle until
the 15-minute silence fallback limped in with a generic nudge.

Root cause was the detection preconditions, not the recovery machinery. The
watchdog's throttle check demanded a session be "cleanly idle, zero active child
processes, at a prompt, throttle string within the last 20 lines." A busy dev
session almost never satisfies that: it usually has a background shell or MCP
process alive, and Claude Code's input box + footer + task list render 15–25 rows
*below* the "API Error:" line, pushing the throttle string out of the 20-line
window. So the preconditions essentially never held, and the fast recovery never
engaged.

The fix replaces those brittle gates with a **settled-output signal**: the
throttle string is matched in a **widened 45-line window** (covers the input box),
and the pane must be **byte-identical across two consecutive watchdog polls**. An
actively-working Claude session animates its spinner and elapsed-timer every tick,
so byte-identical output across polls is a rock-solid "this turn ended and the
session is stuck" signal — with no process-tree inspection (the gate that made
busy sessions invisible) and no at-prompt heuristic (the input box used to hide
the error). Once detected, the existing lifecycle takes over: immediate user
notice → escalating backoff → neutral re-engage → JSONL-growth verification →
periodic check-ins → escalation. After a recovery cycle gives up (~30s) a
still-stuck pane re-emits, so recovery retries **unboundedly until the throttle
clears** — that is the "a session can never hang forever" guarantee. Every
sentinel lifecycle transition (detected → resuming → recovered/escalated) is now
written to `logs/sentinel-events.jsonl`. Tuned by
`monitoring.watchdog.rateLimitSettleMs` (default 20000ms).

## What to Tell Your User

First, only relevant if you run the (off-by-default) mentor autonomous-fix loop. I
dogfooded it live and found its background worker session was hanging on startup
— it was trying to load login-required tools that can't sign in without a human,
so it froze before doing any work. I fixed it so the loop's worker starts with a
clean, minimal toolset and boots in seconds instead of hanging. Nothing changes
for any other session — they keep all their tools.

Second, mostly invisible and strictly an improvement: if one of your sessions hits
Anthropic's temporary server throttle (a "Server is temporarily limiting requests"
error — their side, not your usage limit), it will now recover on its own instead
of silently sitting dead. You'll get a brief heads-up — "hit a temporary throttle,
I'm backing off, you haven't been dropped" — plus check-ins while it waits and a
"back online" when it clears. It keeps retrying until the throttle lifts, however
long that takes. Nothing for you to do, no configuration needed.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| No-MCP headless spawn option | `spawnSession({ disableProjectMcp: true })` (opt-in; used by the mentor loop) |
| Mentor loop session boots reliably | Automatic when `mentor.autonomousFix.enabled` — no more MCP boot-hang |
| Settled-throttle detection | Automatic — the SessionWatchdog recovers a 429-stuck session via a byte-identical-pane signal over a widened scan window, so busy dev sessions are no longer invisible to the RateLimitSentinel |
| Unbounded throttle retry | Automatic — recovery re-engages after each escalation cycle, guaranteeing a throttled session cannot hang forever |
| `monitoring.watchdog.rateLimitSettleMs` | Optional tuning for how long a throttled pane must be settled before recovery engages (default 20s) |

## Evidence

**Mentor loop no-MCP (#556):**
- **Live reproduction (before):** the first real loop session (`mentor-autoloop-…`)
  spawned as `claude --dangerously-skip-permissions --model opus -p '…'` and sat
  ~4.5 min at 0.1% CPU, no transcript written, main thread in `_pthread_cond_wait`;
  child procs `@playwright/mcp` and `mcp-remote …fathom` alive at 0% CPU.
- **Fix verified (after):** `claude --strict-mcp-config --mcp-config '{"mcpServers":{}}'
  --model haiku -p '…'` in the same project returned in ~9s with no MCP boot.
- **Tests:** `tests/unit/claude-headless-extra-flags.test.ts` (6 cases);
  `tests/e2e/mentor-onboarding-lifecycle.test.ts` (+1).
- Side-effects: `upgrades/side-effects/loop-session-no-mcp.md`. Spec:
  `docs/specs/LOOP-SESSION-NO-MCP-SPEC.md`.

**Settled-throttle detection:**
- **Reproduction (unit):** `tests/unit/rate-limit-detection.test.ts` builds the
  exact stuck-pane shape — the `API Error:` line followed by Claude's input box +
  footer + ~14 trailing blank rows. `detectRateLimited(paneWithInputBox())` is
  **false** with the default 20-line window (the bug) and **true** at 45.
- **Observed before (production, this box, 2026-05-30):** zero RateLimitSentinel
  fires across every server instance overnight (no `rateLimitedAtIdle`, no
  `[RateLimitSentinel] detected`, no `[Watchdog] rate-limited` in `logs/server*.log`)
  while three live sessions sat frozen on `Churned for 7m 43s` / `Sautéed for
  9m 28s` / `Baked for 5m 58s`; only the 15-min `ActiveWorkSilenceSentinel` engaged.
- **After:** settled detection emits → existing backoff/verify lifecycle runs +
  writes `throttle-detected`/`throttle-resuming`/`throttle-recovered`. Live
  end-to-end verification on the deploy box before closing the incident.
- Side-effects: `upgrades/side-effects/throttle-settled-detection.md`. Spec:
  `docs/specs/rate-limit-sentinel.md`.
