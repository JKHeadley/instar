---
title: ContextWedgeSentinel — thinking-block-400 fast-fail wedge detection + fresh-respawn recovery
date: 2026-05-28
author: echo
status: in-flight
review-convergence: diagnosis-2026-05-28
approved: true
approved-by: Justin
approved-via: Telegram topic 15160 ("Sounds good" + graduated-rollout confirmation, 2026-05-28 ~09:50 PDT, in response to the live diagnosis + fix design)
ships-staged: true
rollout-flag-path: monitoring.contextWedgeSentinel.autoRecovery
rollout-criteria: "≥3 distinct sessions auto-recovered (kind:recovered) with zero false-alarm-driven respawns over a ≥7-day live window"
rollout-evidence-type: log-filter
rollout-evidence-ref: logs/sentinel-events.jsonl
rollout-evidence-filter: context-wedge
companion-spec: silently-stopped-trio.md
---

# Spec — ContextWedgeSentinel

**Date:** 2026-05-28 · **Author:** echo · **Status:** in-flight

## Triggering incident

A session (`echo-instar-exo`, topic 13481, the `mm-proof-build` worktree) was
permanently dead but still emitting output. Justin saw only sentinel/standby
replies to "How is this looking?" while the real session fast-failed every
inbound message. The tmux pane showed, on every inject:

```
⎿  Cancelled: parallel tool call Bash(rm -rf /Users/.../echo…) errored
⎿  API Error: 400 messages.9.content.20: `thinking` or `redacted_thinking`
   blocks in the latest assistant message cannot be modified. These blocks
   must remain as they were in the original response.
✻ Cooked for 0s
```

### Root cause

A tool call was cancelled **inside a parallel tool batch** while extended
thinking was on (here the cancelled call was a recursive-delete aimed at the
agent home — correctly blocked by the source-tree guard). When one call in a
parallel batch is denied/cancelled, Claude Code cancels every sibling call, and
that cancellation corrupts the **thinking block on the latest assistant turn**.
The Anthropic API then rejects EVERY resume of that conversation with `400 …
thinking blocks in the latest assistant message cannot be modified`. The session
is permanently dead — but it keeps producing output (the instant 400), so:

- **ActiveWorkSilenceSentinel** misses it — output never goes quiet.
- **SocketDisconnectSentinel** misses it — no disconnect string.
- A send-keys **nudge cannot recover it** — re-engaging just re-sends the
  corrupted turn and hits the same 400.

This is a new member of the "silently-stopped" failure class: *loudly*
fast-failing rather than silent, and unrecoverable by nudge.

## Design

A 4th sentinel in the silently-stopped family (mirrors
`SocketDisconnectSentinel`'s detector + lifecycle shape, wired through the same
`SentinelNotifier` audit + tone-gated escalation path), with two differences
driven by this failure's shape.

### Detector + confirm window

`detectContextWedge(text)` matches the API-specific phrase ("blocks in the
latest assistant message cannot be modified"). The phrase is unusual enough that
natural prose almost never contains it. The one case that does — **a session
discussing this very bug** (e.g. the session writing this spec) — is defended
two ways:

1. **Tail gate** (`signatureIsTail`): the signature must appear in the live tail
   of the captured frame, not merely somewhere in scrollback. A session that
   mentioned the error and kept working has scrolled it out of the tail.
2. **Confirm window** (default 45s): on first detection the sentinel waits, then
   re-captures. The wedge is confirmed only if the signature is STILL the tail
   (the session made no progress). A transient or a discussing-session clears.

### Recovery — fresh respawn (NOT a nudge)

The corrupted turn is permanent in the transcript, so recovery is a **clean
respawn that does not `--resume` it**. This reuses `SessionRefresh` with a new
`fresh: true` mode: after the kill (which fires `beforeSessionKill` → the
`TopicResumeMap` saves the Claude UUID), the resume entry is **cleared** before
the respawner reads it, so the bridge spawns a brand-new conversation instead of
resuming the corrupted one. Without this, a naive kill would re-wedge on the
next message — the kill saves the UUID, the next inbound message `--resume`s it,
and the same 400 fires (an infinite re-wedge loop). `SessionRefresh`'s existing
rate-guard caps respawns.

### Recovery policy + Graduated Feature Rollout

Detection + audit are **default-ON housekeeping** (they kill nothing). The
destructive respawn is gated by `autoRecovery`, the rollout-staged flag:

| Stage | autoRecovery | behavior |
|-------|-------------|----------|
| dark (default) | `{enabled:false}` | detect + audit + escalate (if Telegram on); no kill |
| dry-run | `{enabled:true, dryRun:true}` | log a would-respawn row; no kill |
| live | `{enabled:true, dryRun:false}` | kill + fresh respawn |
| default-on | shipped default flipped | live for everyone |

**Fleet-wide promotion (Justin's requirement).** `autoRecovery` is DELIBERATELY
omitted from the persisted `ConfigDefaults` block: `applyDefaults()` is
add-missing-only, so persisting `enabled:false` now would freeze it and a later
flip could never reach existing agents. Instead the dark default lives as the
runtime fallback in `server.ts` (`wedgeCfg.autoRecovery ?? {enabled:false,
dryRun:true}`). Promotion to default-on is: (1) flip that runtime literal — every
existing agent without a persisted override inherits it on next update with no
migration; (2) add `autoRecovery:{enabled:true}` to `ConfigDefaults` so new
agents + the rollout observer (which reads `defaultEnabled` from the shipped
default at `rollout-flag-path`) see default-on. Agents that explicitly set their
own value keep it (opt-out preserved). The twice-weekly `initiative-digest-review`
job surfaces this track's stage + evidence and advocates promotion.

### Escalation

Routine transitions (detected / recovered / dry-run / false-alarm) are
housekeeping → logs + `sentinel-events.jsonl` only. A confirmed wedge that is
NOT auto-recovered (detect-only, the default) or whose respawn FAILED is an
`escalated` event — the session is dead and nothing fixed it, exactly when the
user should know. Telegram delivery is gated by the existing
`sentinelTelegramEscalation` master switch (default OFF, coalesced to the system
topic) — same posture as the trio.

### SessionReaper veto

`isRecoveryActive()` feeds `composedRecoveryActive`, so the reaper never kills a
session while a wedge recovery is in flight (SESSION-REAPER-SPEC §4 "compose,
don't replace").

## Files

- `src/monitoring/ContextWedgeSentinel.ts` (new) — detector + confirm-window + lifecycle.
- `src/monitoring/sentinelWiring.ts` — `buildContextWedgeDeps` (recovery policy).
- `src/monitoring/SentinelNotifier.ts` — `dry-run` + `false-alarm` event kinds.
- `src/core/SessionRefresh.ts` — `fresh` mode (clears `TopicResumeMap`).
- `src/core/types.ts` + `src/config/ConfigDefaults.ts` — config shape + default.
- `src/commands/server.ts` — trio-block wiring + veto.

## Tests (all three tiers)

- **unit** `tests/unit/monitoring/ContextWedgeSentinel.test.ts` — detector, tail
  gate, confirm-window false-alarm, all four recovery outcomes; `SessionRefresh.test.ts`
  fresh-mode order (clear after kill, before respawn).
- **integration** `tests/integration/context-wedge-sentinel-wiring.test.ts` —
  full wiring through `SentinelNotifier` across all policies, default Telegram silent.
- **e2e** `tests/e2e/context-wedge-sentinel-lifecycle.test.ts` — production
  assembly writes context-wedge rows to `sentinel-events.jsonl` on disk + a WIRED
  source guard (constructs / starts / veto / fresh-respawn) against dead code.

## Signal-vs-authority

The regex + tail gate + confirm window are detectors. `recoverFn` is a bounded
recovery primitive (rate-guarded by `SessionRefresh`). Escalation routes through
the existing `MessagingToneGate` via `SentinelNotifier`. No new blocking authority.
