---
title: "Session Idle Preservation for Topic-Bound Agents"
slug: "session-idle-preservation"
author: "echo"
review-iterations: 1
review-convergence: "2026-05-05T01:54:00Z"
review-completed-at: "2026-05-05T01:54:00Z"
approved: true
approved-by: "justin"
approved-at: "2026-05-05T00:55:00Z"
approval-channel: "telegram topic 2169 (session-robustness) — user replied 'yes please' to the high-level two-layer plan after Echo traced the failure end-to-end on Inspec/monroe-workspace logs"
---

# Session Idle Preservation for Topic-Bound Agents

**Status:** spec — converged round 1, approved
**Owner:** Echo
**Date:** 2026-05-05
**Incident origin:** Inspec / topic 72 (monroe-ai), 2026-05-04T23:39:14Z (zombie kill) → 2026-05-05T00:48:16Z (respawn-with-resume crash drops user message). 19 prior occurrences in the same log file going back to 2026-04-28.

## Problem

Telegram-bound (and Slack/iMessage-bound) agents drop the user's first
message after a conversational pause longer than 15 minutes.

Two stages:

**Stage 1 — Healthy idle classified as zombie.** When a Telegram agent
finishes replying, Claude sits at the prompt waiting for the next user
message. SessionManager's zombie-killer interprets "idle at prompt + no
active processes for 15 minutes" as zombie and kills the session
unconditionally. For messaging-bridged agents, "idle at prompt" IS the
healthy waiting state.

**Stage 2 — Stale resume UUIDs drop messages on respawn.** When the user
finally messages, the bridge tries to respawn with `--resume <UUID>`. The
saved UUID was captured at kill time and sometimes crashes Claude during
startup (`Session died during startup`). `waitForClaudeReady` times out, the
initial message is logged "NOT injected", and the user's message is
dropped. Five minutes later, the presence proxy fires its tier-3 "session
appears stopped" warning. The user must send "unstick" or re-send to
recover.

## Root cause

The zombie-killer is structurally unaware of whether a session has a live
bridge consumer waiting on it. It applies the same idle threshold to a
batch-job session that's done its work as it does to a long-lived agent
holding a Telegram conversation.

The respawn path silently treats `--resume` failure as "best effort
inject anyway", but when tmux died during startup there's nothing to
inject into. The message vanishes.

## Design

### Layer A — Topic-binding-aware kill threshold

SessionManager gains an optional `topicBindingChecker` callback (same
shape as the existing `subagentChecker` and `activeRecoveryChecker`). When
the zombie-killer is about to act, it consults the checker; if the session
is bound to a live messaging topic the kill threshold is raised from 15
minutes to a configurable bound threshold (`idlePromptKillMinutesBoundToTopic`,
default 240 minutes / 4h).

The binding lookup is a hard structural fact (is this session ID in the
TelegramAdapter's reverse map?), not a judgment call — exempt from the
signal-vs-authority rule per `docs/signal-vs-authority.md` ("Hard-invariant
validation … structural validators at the boundary of the system are not
decision points").

The default 4h is a deliberate balance:
- Long enough that conversational pauses through a workday don't kill
  healthy bound sessions.
- Short enough that genuinely abandoned bound sessions release their
  ~200-500MB Claude TUI process and Anthropic connection within a
  workday.
- Operators with always-on conversations or memory-constrained hosts
  can override via `idlePromptKillMinutesBoundToTopic`.

### Layer B — Resume-failure fresh-spawn fallback

`SessionManager.spawnInteractiveSession`'s post-readiness path now lives in
a private `handleReadyAndInject`. When the readiness probe fails AND tmux
died during startup AND the spawn was using `--resume`, the method:

1. Marks the failed session `status: 'failed'` in state (BEFORE emitting
   the event, so concurrent monitor ticks read consistent state).
2. Emits a `resumeFailed` event with `{ tmuxSession, resumeSessionId,
   telegramTopicId, slackChannelId }`.
3. Best-effort kills any zombie tmux pane.
4. Recursively calls `spawnInteractiveSession` with the same `name` (so
   the bridge's session→topic mapping still resolves), the same initial
   message, and `resumeSessionId` *omitted* to break the bad-UUID cycle.
5. If the fresh-spawn ALSO fails, emits a structured `DegradationReporter`
   event and returns — single retry only, no infinite loop.

The bridge listens for `resumeFailed` and clears the bad UUID from
`TopicResumeMap` — but gates the `remove()` on UUID-equality. If the
fresh-spawn already saved a new valid UUID via the proactive 8-second
heartbeat, the listener observes the equality miss and skips the wipe.

## Convergence

This spec is a faithful summary of the live design that was implemented,
side-effects-reviewed, and second-pass-audited inside the same /instar-dev
pass. The second-pass reviewer raised five concerns; all five were
resolved in the same PR before commit:

1. Bound-session default lowered from 1440m → 240m (memory/connection
   pressure on multi-topic agents).
2. UUID-equality gate added to the `resumeFailed` listener (prevent
   wiping a freshly-saved UUID under the proactive-save race).
3. Failed-session status update moved BEFORE the `resumeFailed` emit
   (consistency for concurrent monitor ticks).
4. Test coverage gaps closed: "fresh-spawn fallback also fails →
   degradation reported", "mixed bound + unbound sessions on the same
   manager", and the entire UUID-equality gate behaviour (new test file).
5. Fragile `tmuxSession.replace(prefix, '')` reconstruction replaced with
   threading the original `name` parameter through `handleReadyAndInject`
   to the recursive call.

Full review and resolution narrative: `upgrades/side-effects/0.28.77.md`.

## Approval

User approved the high-level two-layer plan on 2026-05-05T00:55:00Z via
Telegram topic 2169 ("yes please"). The approval was scoped to the
two-layer fix as described in Echo's preceding analysis message and is
therefore considered scoped approval per the autonomous handler governance
("scoped approval = full scope; report at phase boundaries, not commit
boundaries"). The convergence-and-resolution loop above happened inside
the /instar-dev skill's own Phase 4-5; the user did not need to be
re-engaged for each round.

## Out of scope (deferred)

- Generalising the bound-threshold to per-channel granularity (Telegram
  topic vs Slack channel vs iMessage thread) — single global default is
  sufficient for the reported failure mode.
- Re-architecting the spawn-and-await path to expose readiness as an
  awaitable promise to all 15 callers — out-of-scope; the in-method
  fallback is contained to one method body.
- Promoting the zombie-killer's idle detection from "regex pattern in
  capture-pane output + process tree" to an LLM-backed authority — that
  belongs to a separate spec on monitoring-quality.
