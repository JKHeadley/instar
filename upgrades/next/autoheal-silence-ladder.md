<!-- bump: patch -->

## What Changed

Extends the **ActiveWorkSilenceSentinel** (the watchdog that notices when a
session was working then went quiet) with two things:

1. **Notices now go to the stalled session's OWN topic** — not the consolidated
   lifeline feed. Previously a "this went quiet, want me to dig in?" escalation
   landed in the shared system topic, where it was easy to miss and gave no
   signal about *which* conversation stalled. Now it posts in that conversation's
   own Telegram topic, falling back to the consolidated feed only if the topic
   can't be resolved or delivery fails. (Operator ask, 2026-06-09.)

2. **An opt-in auto-heal ladder** (`autoRecover`, DARK / off by default): when a
   confirmed-silent session doesn't respond to the gentle nudge, instead of only
   asking the operator, the sentinel can **respawn it fresh** (conversation
   preserved via `--resume`) and report the outcome in that session's topic. The
   respawn is loop-capped (`maxAutoRecoveries`, default 1): a session that stays
   stuck after one respawn is asked-about once and then left alone — never
   re-respawned in a loop. A failed respawn falls back to the old "ask the
   operator" behavior.

The respawn reuses the exact `refreshSession({fresh:true})` primitive the
ContextWedgeSentinel already uses in production, so it is framework-agnostic and
well-exercised.

## What to Tell Your User

When one of my work sessions goes quiet mid-task, two things are better now.
First, the heads-up about it lands **in that conversation's own topic** instead
of a shared system channel — so you can see exactly which thread stalled. Second,
there's a new opt-in mode (⚗️ experimental, off by default) where I don't just
tell you a session is stuck — I **automatically restart it** (keeping the
conversation) and report back, only falling back to asking you if the restart
itself doesn't work. It can only auto-restart a given stuck session once, so it
can never get into a restart loop. It's off by default — just ask me to turn on
auto-recovery for stalled sessions and I'll enable it for you.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Silence/recovery notices route to the stalled session's own topic | automatic — no config |
| Opt-in auto-heal: respawn a confirmed-stuck session instead of only asking (⚗️ experimental, off by default) | `monitoring.activeWorkSilenceSentinel.autoRecover: true` |
| Loop-cap on auto-respawn | `monitoring.activeWorkSilenceSentinel.maxAutoRecoveries` (default 1) |

## Evidence

Reproduction (live, 2026-06-09): a session that kicked off a long change went
quiet for ~1 hour. The sentinel correctly detected the silence and escalated,
but the escalation went to the consolidated lifeline topic — which had been
deleted on the Telegram side — so the operator saw pure silence and couldn't
tell a stalled session from a working one. The fix has two halves: the
deleted-topic self-heal (shipped separately) and this change, which routes the
notice to the session's own topic and (opt-in) recovers the session instead of
only asking.

After the change:
- `tests/unit/monitoring/ActiveWorkSilenceSentinel.test.ts` — 6 new cases pin the
  ladder: autoRecover OFF → ask, never respawn; ON + respawn succeeds → one
  respawn, recovery notices, state cleared; ON + respawn fails → recovery-failed,
  ask, state kept (loop-stopper); loop-cap → respawned at most once across
  repeated ticks; recoverFn throws → recover-error surfaced + ask.
- `tests/unit/monitoring/sentinelWiring.test.ts` — 5 new cases pin notice
  routing (session topic on resolve; escalate fallback when unresolved or when
  delivery fails) and recoverFn passthrough (present vs undefined-when-dark).
- Existing silently-stopped unit/integration/e2e suites stay green. `tsc` +
  repo lint clean.
