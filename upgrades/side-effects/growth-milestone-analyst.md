# Side-Effects Review — Growth & Milestone Analyst (slice 1)

**Version / slug:** `growth-milestone-analyst`
**Date:** `2026-06-08`
**Author:** `echo`
**Tier:** `1` (ships dark, flag-off, compute + read-only, fully reversible)
**Second-pass reviewer:** `not required`

## Summary of the change

Adds `GrowthMilestoneAnalyst` (`src/monitoring/`) — a pure observer that composes
the existing `InitiativeTracker` (rollout stages + staleness), `ApprovalLedger`
(approve-vs-change), and `CorrectionLedger` (recurrence) into one digest with five
explicit notify-rules (R1 promotion-ready, R2 incubation-expired-unproven, R3
initiative-stalling, R4 spec-pattern, R5 correction-pattern). It keeps ONE piece of
internal bookkeeping — a stage-observation journal — so "days in stage" is robust
where the rollout engines do not stamp it. Wires four read routes (`GET
/growth/digest|findings|status`, `POST /growth/tick`), a `monitoring.growthAnalyst`
config block (defaults OFF), and the AgentServer construction (guarded; null →
routes 503). Ships DARK: compute + read only, no Telegram sending.

## Decision-point inventory

- **`classifyRollout`** (the window-expiry verdict): in-window / at-boundary /
  expired × proved / unproved / unknown × stage. Both sides of every edge are unit
  tested.
- **Per-rule enable gates** (`settings.rules.*`): each rule suppresses iff its flag
  is false.
- **Construction gate** in AgentServer: analyst built only when
  `monitoring.growthAnalyst.enabled === true` AND a tracker + stateDir exist.

## 1. Over-block

**What legitimate inputs does this change reject?** Nothing user-facing is rejected.
The only "rejection" is structural: when the feature is OFF (the default), every
`/growth/*` route returns 503 — by design, mirroring the established dark-feature
contract (e.g. `correctionLearning`). No existing route, job, message, or gate
changes behavior. The analyst never blocks, delays, or rewrites anything.

## 2. Under-block

**What does this still miss?** Three deliberate gaps, all deferred to later slices:
(a) no Telegram/event delivery — it computes but does not speak, so a real milestone
won't reach the operator until the sending slice; (b) proof-of-life
(`evidenceCounter`) is unwired, so every expiry currently classifies as
R2-unknown rather than R1 until a per-feature activation source is plumbed — this is
surfaced honestly as `proved:'unknown'`, never masked; (c) the muted analyzers
(`correctionLearning`, `failureLearning`) are NOT enabled here — that flood-sensitive
step is its own slice.

## 3. Level-of-abstraction fit

**Right layer?** Yes. The analyst lives in `src/monitoring/` beside the other
observe-only components (TokenLedger, ResourceLedger). It reads through the engines'
public methods (`tracker.list/digest`, `approvalLedger.summarize`,
`correctionLedger.list`) rather than reaching into their storage. The stage journal
is analyst-private state under `stateDir/state/growth-milestone-analyst/`.

## 4. Reversibility

Fully reversible: the feature ships behind `monitoring.growthAnalyst.enabled`
(default false). Disabling it (or removing the construction block) returns the
system to byte-identical prior behavior — the routes 503, nothing else references
the analyst. The only persisted artifact is a small JSON journal that is pruned and
self-heals.

## 5. Anti-flood discipline (relevant because this REVERSES an over-silence)

The whole point is to speak more, so overshooting into a new flood is the risk to
guard. This slice does not send at all. The digest is structurally ONE object — a
burst of N window-expiries aggregates into one digest with counts, never N messages
(unit-tested at N=500). When the sending slice lands it must route through the
existing budget-guarded attention/post-update surfaces and aggregate, never create
one topic per feature. That guardrail is stated here so the next slice inherits it.

## 6. Framework generality

Not framework-specific. The analyst is a server-side monitoring component that reads
instar's own ledgers/trackers; it does not spawn sessions, call an LLM, or route
through any agentic framework (Claude/Codex/Gemini/pi). It behaves identically
regardless of which framework the agent runs on. No per-framework branching exists
or is needed.

## 7. Migration parity

- Config defaults auto-apply to existing agents via `ConfigDefaults` +
  `applyDefaults` deep-merge (the established no-separate-migrateConfig path for a
  new `monitoring.*` sub-key).
- The CLAUDE.md template (`generateClaudeMd`) documents the routes for NEW agents.
- A `migrateClaudeMd` content-sniff + the scheduled digest job are deferred to the
  promotion slice — a dark, route-only feature needs no live agent-awareness
  migration until it actually speaks.
