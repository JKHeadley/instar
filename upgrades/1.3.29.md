# Instar Upgrade Guide — NEXT

<!-- bump: minor -->

## What Changed

**New building block: agent-to-agent Telegram comms primitive (core logic).** This is the
first piece of a robust, reusable way for two Instar agents to talk over Telegram *knowingly*
— every agent-to-agent message carries a visible marker
(`[a2a:from=… to=… role=… id=… corr=… ts=… v=1]`) so the receiving side can tell it's from
another agent and apply anti-loop machinery, rather than treating it like a human user
message. This increment ships the pure, security-critical core: the strict marker
parser/formatter, the recipient routing decision (with the full drop matrix — malformed,
replay-window, user-spoof, wrong-recipient, unknown-sender, duplicate, and per-source role
admission), and the cycle-detection key. It ships **dark** — nothing wires it yet (the
TelegramAdapter integration and the first consumer, the mentor, land in follow-up PRs).

## What to Tell Your User

- Nothing changes in how your agent behaves today — this is groundwork. It's the foundation
  for agents being able to message each other over Telegram safely (with built-in defenses
  so they can't spoof each other or get stuck in a reply loop), which a later update will
  switch on for the mentor feature.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| `AgentTelegramComms` primitive (core) | Internal `parseMarker` / `formatMarker` / `decideRoute` / `CycleDetector` in `src/messaging/AgentTelegramComms.ts` — pure logic, I/O injected; not wired yet |

## Evidence

**Net-new feature, not a bug fix** — a new pure-logic module that nothing imports yet
(ships dark). Proven by 20 unit tests covering every branch of the security-critical logic:
marker parse/format (valid; no-marker vs malformed incl. missing `corr`/`ts`, charset
violation, no separator; round-trip); the full routing matrix (route + fall-through + every
drop reason, including the **user-spoof defense** — a human typing a marker-shaped string is
dropped even when from/id match an allowlisted bot — and **per-source role acceptance** — a
known role from the wrong source is dropped); and cycle-detection (key never collapses,
trips within window, no false collision). `tsc --noEmit` clean. The integration + e2e tiers
(real TelegramAdapter wiring, the bidirectional contract test, the supervised live cycle)
land with the follow-up PRs per the spec's staged plan.
