## What Changed

Added **`GrowthMilestoneAnalyst`** — a new proactive growth & milestone analyst
(`src/monitoring/`). It composes the existing tracking surfaces (`InitiativeTracker`
rollout stages + staleness, `ApprovalLedger` approve-vs-change, `CorrectionLedger`
recurrence) into one opinionated digest with five explicit notify-rules:

- **R1** promotion-ready (a feature past its incubation window that proved itself)
- **R2** incubation-expired-unproven (past window, never proved itself → extend/repair/retire)
- **R3** initiative-stalling (reuses `tracker.digest()`)
- **R4** spec approve-vs-change pattern
- **R5** recurring-correction pattern

The key lever is a TIGHT incubation window (3d low-risk / 7d standard) whose **expiry
is itself the trigger**, so a feature can never be silently left behind. Promotion
requires real proof-of-life, never elapsed time alone (a feature whose evidence
source isn't wired is surfaced honestly as `proved:'unknown'` and can never be
promotion-ready).

Wires four read-only routes — `GET /growth/digest`, `GET /growth/findings`,
`GET /growth/status`, `POST /growth/tick` — plus a `monitoring.growthAnalyst` config
block (defaults OFF). Ships **DARK**: this slice computes and exposes findings only;
it does NOT send to Telegram. Cadence/event-delivery and enabling the muted
analyzers ride a later, flood-sensitive slice.

## Evidence

Not a bug fix and not reproducible in dev — this is a new, dark-by-default capability,
so there is no before/after to reproduce. It changes no existing behavior: with the
flag off (the default) every new route returns 503 and nothing else references the
analyst. Behavior is covered by 41 tests across all three tiers (unit semantic
coverage on both sides of every window/proof boundary, integration route gating,
wiring against a real InitiativeTracker, and an e2e "feature is alive" lifecycle).

## What to Tell Your User

Nothing yet — this ships dark and disabled by default, and is agent-only. It does not
message the user, change any existing behavior, or turn on any new surface until it
is explicitly enabled in a later promotion slice. When asked "is anything checking on
my initiatives, feature maturity, or patterns?", you can note the analyst exists and
is being rolled out carefully from dark to live, and that you will be able to read its
computed digest once it is turned on.

## Summary of New Capabilities

- New monitoring component `GrowthMilestoneAnalyst` (observe-only; no new sensors).
- New read routes `GET /growth/digest|findings|status`, `POST /growth/tick`
  (503 when disabled — the dark default).
- New config block `monitoring.growthAnalyst` (ships disabled; tunable incubation
  windows, proof-of-life threshold, per-rule flags) — auto-applies to existing
  agents via ConfigDefaults deep-merge.
- CLAUDE.md template documents the routes (Agent Awareness Standard).
