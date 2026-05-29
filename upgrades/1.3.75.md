# Instar Upgrade Guide — NEXT

<!-- bump: patch -->

## What Changed

**Quieter standby on quick replies — no more double-acknowledgement.**

When you message your agent and it fires its quick "Got it, on it" ack, the
background standby helper (PresenceProxy) used to ALSO post a near-duplicate
first-tier update a beat later — e.g. *"<agent> is currently just starting to
respond to <your question, restated>"* — right before the real answer. On a
normal 30–60s task you'd see: **ack → redundant standby echo → answer**, on
every single turn. (Surfaced live while dogfooding the Codey/codex agent over
Telegram.)

Now: if the agent has already acknowledged you since your message arrived, the
**first-tier standby message is suppressed** — the ack already told you the
agent is alive and on it. The safety chain stays fully armed: a genuine
*ack-then-stall* is still caught by the 2-minute progress tier and the stall
tier. Net per-turn experience: **ack → (a progress note only if it's still
silent at 2 minutes) → answer.**

This replaces an earlier narrower mitigation that only worked when the
session's terminal pane showed *nothing but* the ack — which was never true for
**codex** agents (their pane carries tool-call/thinking stream noise), so codex
agents always got the verbose echo. The new behavior keys off the ack itself,
so it's framework-agnostic.

## What to Tell Your User

Conversations with your agent read cleaner now: a quick task is just "got it"
then the answer, instead of "got it" + a redundant "still working on it" + the
answer. If the agent genuinely goes quiet for a couple minutes, you'll still get
the progress and stall updates exactly as before.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Post-ack standby suppression | Automatic — once your agent acks a message, PresenceProxy withholds its redundant first-tier standby but keeps the 2-min / stall tiers armed for real silence. |

## Evidence

- Unit: `tests/unit/presence-proxy-race-guard-ack.test.ts` — new "post-ack
  suppression" cases: codex-pane suppression (ack present, delta NOT ack-only →
  no message, no LLM call), ack-gating (no ack → Tier 1 still fires), and
  stall-detection preservation (after a suppressed Tier 1, Tier 2 still fires).
  `tests/unit/presence-proxy-ack-and-baseline.test.ts` updated to the new
  behavior. Full PresenceProxy suite (88 tests) green.
- Live: observed + fixed during the Codey-over-Telegram dogfooding run; the
  verbose post-ack echo is the exact noise removed.

Spec: `docs/specs/presence-proxy-ack-and-baseline.md` (Layer C amendment).
