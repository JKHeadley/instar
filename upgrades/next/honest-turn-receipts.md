---
bump: patch
---

## What Changed

Honest turn-receipts — the standby (🔭) system now tells the truth about WHY a
turn failed instead of saying "actively working" while a session is dead.

Three incidents in two days had one symptom: a delivered message that never got
a reply, while the standby showed "🔭 actively working." Root: the tier-3
assessment classified a session "working" whenever it had a live child process
— but a rate-limited, policy-wedged, or context-exhausted session HAS a live
process (the model CLI is alive, just failing every turn). The live process
forced the lie. Separately, the "conversation too long" standby fired on that
phrase anywhere in the buffer, so a stale scrolled-past mention surfaced as
noise on healthy sessions.

New `StuckSignatureClassifier` (pure, tail-gated, signal-only) classifies a
live-but-failing session from its LIVE tmux tail — rate-limited / policy-wedge /
context-wedge / context-too-long — and PresenceProxy surfaces the real reason
instead of "working". Tail-gating (the signature must be the live tail, not a
scrollback mention) is the same discriminator that kills the "conversation too
long" noise. The classifier defers to any recovery sentinel that already owns a
session's recovery, so the user always hears one voice. Recovery itself is
unchanged — this only makes the messaging honest.

## What to Tell Your User

When a message of yours goes unanswered, I'll now tell you the real reason if I
can't reply — "I've hit the usage limit, resets 10:30pm", "my session got stuck
on a content-policy error, resend your last message" — instead of a misleading
"actively working." And the "conversation too long" messages that used to pop up
when nothing was wrong are gone: that only fires now when it's actually
happening.

## Summary of New Capabilities

- `StuckSignatureClassifier` — tail-gated classification of a live-but-failing
  session (rate-limited / policy-wedge / context-wedge / context-too-long) with
  an honest user-facing message per kind. Pure + signal-only.
- PresenceProxy tier-3 surfaces the honest reason instead of "working", defers
  to an owning recovery sentinel (`isStuckRecoveryActive`), and no longer fires
  the context-too-long notice on a stale scrollback mention.
- CLAUDE.md "Honest standby (turn-receipts)" section so agents can explain the
  new behavior and the noise fix.

## Evidence

Grounded in the real 2026-06-04/05 incidents (rate-limit, AUP-wedge) using the
verbatim pane text. 30+ new unit tests both sides of every boundary
(honest-when-stuck AND quiet-when-fine, incl. the stale-scrollback noise case
and prose-mentions-a-limit false positive) + a behavioral test driving the real
fireTier3 with a live child process (wedge → honest, NOT "working"; deference →
silent) + migrator add/idempotent + server.ts wiring guard. All 119 existing
presence tests pass; tsc clean; preflight PASS.
