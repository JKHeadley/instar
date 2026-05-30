---
title: Threadline a2a spawn — byte-cap the history + latest body (fix "command too long")
date: 2026-05-30
author: echo
review-convergence: urgent-fleet-hotfix-2026-05-30
approved: true
approved-by: Justin
approved-via: Standing authorization for urgent fleet bugs — "anything urgent like this should automatically be fixed and deployed please remember this" (Justin, recorded in MEMORY feedback_auto_fix_deploy_urgent_fleet_bugs). This bug breaks multi-agent communication outright on long threads and blocked Echo's own live mentorship session. Reported to Justin in topic 13435 at fix time.
eli16-overview: threadline-a2a-spawn-history-bytecap.eli16.md
---

# Spec — Threadline a2a spawn history byte-cap

**Date:** 2026-05-30
**Author:** echo
**Status:** approved (urgent fleet hotfix)

## Triggering incident

During a live mentorship session, `threadline_send` to a peer agent (instar-codey)
on an active 10-message thread failed with:

```
Spawn denied: Failed to create tmux session: ... command too long
```

The a2a reply-spawn embeds the **entire thread history** plus the latest message
into a one-shot prompt, and that prompt is passed as a **command-line argument**
to `tmux new-session -d -s … <codex/claude exec … PROMPT>` (via
`SessionManager.spawnSession` → `frameworkSessionLaunch` → `execFileSync`). tmux's
`new-session` command length limit is ~16 KB (verified empirically on this host: a
15 KB argument succeeds, 16 KB fails with the literal "command too long"). As a
thread accumulates messages the prompt grows without bound, so once a thread is
long/verbose enough the spawn fails **outright** — silently breaking agent-to-agent
communication on exactly the long-running threads that need it most.

This is the same failure class as the Mentor Stage-A "command too long" bug
(`MentorStageA.ts`, fixed by capping its growing compose context).

## Root cause

`ThreadlineRouter.buildHistoryContext()` capped the history by **message count**
(`maxHistoryMessages`) but embedded each message's **full body** with no byte
bound. Verbose multi-KB messages (and the codex-duplicate-reply bug, which fills a
thread with repeated near-identical closeouts) push the assembled prompt past
tmux's ceiling. `buildPrompt()` likewise embedded the latest message body verbatim
— a second unbounded input (a peer can send an arbitrarily large message).

## Fix

Bound both unbounded inputs so the assembled `tmux new-session` command stays
comfortably under the ~16 KB cliff:

1. **History byte-cap** — `buildBoundedHistorySection()` (pure, exported) walks the
   selected messages newest→oldest, truncates any single message to
   `MAX_HISTORY_MESSAGE_BYTES` (1500), and stops adding older messages once
   `MAX_HISTORY_BYTES` (6000) is reached — always keeping at least the newest
   message. The header reports the included/total counts and notes when older
   messages were omitted. The existing message-count cap is retained; the byte cap
   is the belt-and-suspenders that actually bounds size.
2. **Latest-body cap** — `capMessageBody()` (pure, exported) truncates the latest
   message body to `MAX_LATEST_BODY_BYTES` (3500) with an explicit marker.

Worst-case assembled prompt ≈ 6 KB history + 3.5 KB latest + ~2.5 KB
template/grounding/env ≈ 12 KB — a ~4 KB margin under the 16 KB cliff.

## Why a cap, not the file-based prompt (alternatives considered)

`PipeSessionSpawner` already passes its prompt via a temp file using a
`"$(< file)"` shell expression (no command-line length issue, no context loss).
The architecturally-cleanest fix would route `SessionManager.spawnSession` through
the same file-based mechanism — eliminating the length limit for ALL spawn paths
and preserving full context.

We deliberately defer that to a follow-up <!-- tracked: issue-562 --> (issue #562): it changes the core spawn used by every
session (jobs, mentor, interactive, a2a), so its blast radius is the whole fleet's
session spawning. For an **urgent** hotfix that must unblock multi-agent comms now,
the targeted byte-cap (scoped entirely to `ThreadlineRouter`, zero change to the
core spawn) is the correct low-risk move. The cap's only cost is dropping the
oldest context on very long threads — acceptable, and softened by keeping the
newest messages. Tracked follow-up <!-- tracked: issue-562 --> (issue #562): file-based prompt in `SessionManager.spawnSession`.

## Testing

- **Unit (pure):** `tests/unit/threadline/ThreadlineRouter-history-cap.test.ts` —
  `capMessageBody` (no-op under budget; truncates with accurate marker);
  `buildBoundedHistorySection` (empty; all-included header; over-budget bounds total
  size + keeps newest + drops oldest + "older omitted" header; single oversized
  message truncated; always keeps ≥1 newest even under a tiny budget).
- **Wiring (router):** `tests/unit/threadline/ThreadlineRouter.test.ts` — a 40×2.5 KB
  history + 20 KB latest body flows through `handleInboundMessage` and the captured
  spawn `context` is `< 14000` chars, contains the newest message, drops the oldest,
  and truncates the latest body. Proves the router actually applies the cap.
- **Regression:** existing 32 `ThreadlineRouter` tests pass unchanged.
