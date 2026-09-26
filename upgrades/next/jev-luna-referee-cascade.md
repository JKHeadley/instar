# Jev cascade: unsure answers go to GPT-6 Luna, and both are logged

## What Changed

New shared module `src/core/JevCascade.ts`: `selectEscalations` (default
unsure band 0.30–0.70, per-rule `bands` overrides, one audit draw per state that
escalates every confident answer), `buildRefereePrompt` (text fenced as
untrusted data), `parseRefereeAnswer` (strict — every rule must be a boolean),
and `askReferee` (one bounded call on the `fast` tier, never throws).

`JevSignalShadow` gains `referee` config (`enabled`, `band`, `bands`,
`auditRate`, `timeoutMs`, `maxPerDay` default 300). When enabled and a referee
provider exists, escalated rules produce a `kind: 'referee'` row with
`escalated`, `jev`, `detector`, and `referee` verdicts (or a `reason`). The
text is `scrubForStore`d before it is sent; rows never carry text. The server
builds a dedicated `codex-cli` provider with its own breaker for the referee.

## Evidence

- `tests/unit/JevCascade.test.ts` (10): band edges inclusive, per-rule override
  and invalid-band fallback, audit draw on/off, prompt fencing and clipping,
  strict parse refusals, referee ok/unparseable/error/timeout.
- `tests/unit/JevSignalShadow.test.ts` (+9): absent config makes no call;
  enabled-but-confident makes no call; unsure answer logs referee verdict beside
  Jev and detector without text; audit draw; secret scrubbed before referee;
  slow referee never holds the Jev slot and overlap records `busy`; failing
  referee records its reason; daily cap; null provider is inert.
- `tests/e2e/jev-signal-shadow-lifecycle.test.ts` (+1): production factory,
  live config flip turns the referee on without restart.
- `tests/unit/jev-referee-wiring.test.ts` (2): server builds a real codex
  provider and passes it to the factory.

## What to Tell Your User

When the message-comparison trial runs with the new handoff switched on, any
question the cheap model is unsure about is also put to a smarter light model
(GPT-6 Luna), and both answers are saved side by side. That is how each check's
confidence threshold gets set from real data. It changes nothing about which
messages are sent.

## Summary of New Capabilities

- `intelligence.jevSignalShadow.referee` (dark by default).
- `JevCascade` helper — the default path for future Jev integrations.
