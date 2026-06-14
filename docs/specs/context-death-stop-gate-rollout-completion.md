---
title: "Context-death stop-gate — rollout completion (wire the hook client, add config dial, flip to shadow→enforce)"
slug: context-death-stop-gate-rollout-completion
status: draft
approved: false
date: 2026-05-24
author: echo
parent-spec: docs/specs/context-death-pitfall-prevention.md
eli16-overview: context-death-stop-gate-rollout-completion.eli16.md
---

# Context-death stop-gate — rollout completion

## One-paragraph summary

The context-death stop-gate was fully designed and approved in `context-death-pitfall-prevention.md` (approved by Justin 2026-04-17, 4 review iterations) and its **server half shipped** — `UnjustifiedStopGate` authority, `StopGateDb` SQLite decision log, and the full `/internal/stop-gate/*` route family (`hot-path`, `evaluate`, `kill-switch`, `mode`, `log`, `annotations`), plus the `instar gate` CLI. But the rollout **silently stopped after the server half**. The keystone that the approved spec calls for — the **hook-side router inside `autonomous-stop-hook.sh`** that detects stop signals and calls `/internal/stop-gate/evaluate` — was never integrated; there is no `unjustifiedStopGate` config type or default; and the mode dial was never flipped past `off` (PR4-shadow / PR5-enforce never happened). The authority sits fully built with **zero callers and zero eval events**. This spec does **not** introduce new design — it completes the approved rollout: (1) integrate the hook router (the unbuilt portion of the parent spec's PR3), (2) add the `unjustifiedStopGate` config field + migration, (3) flip to `shadow`, then (4) flip to `enforce`, both gated by the parent spec's already-approved threshold criteria.

## Why this is not a new spec

Per the instar-dev gate, src/ + hook changes require a converged, user-approved spec. **That spec exists and is approved** (`context-death-pitfall-prevention.md`). Every component named here is specified there:
- Hook router pseudocode: parent spec § "(b) Unified stop-hook — `autonomous-stop-hook.sh` with internal router".
- Config dial (`mode: off|shadow|enforce`): parent § "Config flag — server-mediated".
- Detectors including `mentionsFreshSession`: parent § "Fast path (casual session)".
- Shadow / enforce flip gates: parent § "Rollout" PR4 / PR5 and § "Success criteria".

This document is a **rollout-completion plan** that re-grounds the unfinished PRs against current `main` (v1.2.62) and records *why the gap existed* (no decision was ever recorded; the rollout simply stalled — itself the motivating data point for the sibling Liveness Reconciler spec). It carries no design authority of its own; if any step here contradicts the parent spec, the parent spec wins.

## Verified current state (on JKHeadley/main @ v1.2.62)

| Parent-spec deliverable | Landed? | Evidence |
|---|---|---|
| PR0a server infra (`/internal/stop-gate/hot-path`, kill-switch, version contract) | ✅ | `src/server/routes.ts:1517+`, `src/server/stopGate.ts`; commit #54 |
| PR0d e2e compaction harness | ✅ | commit `1f7f76a07` |
| PR1 identity marker + migration | ✅ | commit `1395c2451` |
| PR2 e2e compaction-recovery assertions | ✅ | commit `2c0c87f25` |
| PR3 authority + SQLite + `evaluate` route | ⚠️ partial | `src/core/UnjustifiedStopGate.ts`, `src/core/StopGateDb.ts`, `routes.ts:1564` (`/internal/stop-gate/evaluate`); commit `42cb9eeef` — **server only; hook router omitted** |
| PR3 **hook router in `autonomous-stop-hook.sh`** | ❌ **never landed** | `grep -rl "stop-gate/evaluate\|hot-path\|UnjustifiedStop"` over `.claude/`, `src/data/`, `src/templates/`, `src/scaffold/` → **zero callers** |
| `unjustifiedStopGate` config type + default | ❌ missing | no match in `src/core/types.ts`, `src/core/Config.ts`, `src/data/` |
| PR4 `instar gate` CLI + mode endpoint | ✅ | commit `737722036`, `routes.ts:1542` (`/internal/stop-gate/mode`) |
| PR4 **flip to shadow** | ❌ never happened | no config default; mode dial absent |
| PR5 **flip to enforce** | ❌ never happened | — |
| StopGateDb eval events | 0 rows expected | authority has no caller |

**Net:** the brain (authority + decision log + routes + CLI) is built; the nerve (hook router client) connecting the Stop event to the brain was never wired, and the on-switch (config dial) does not exist. This is a "built but dark" instance — see `docs/specs/built-but-dark-liveness-reconciler.md`.

## Scope

### In scope (completing the approved rollout)

1. **Hook router (parent PR3, hook portion).** Integrate the router into `autonomous-stop-hook.sh` exactly per the parent spec's router pseudocode and fast-path budget. Key points carried verbatim from the parent:
   - Single batched `GET /internal/stop-gate/hot-path?session=<id>` with 60s mtime-TTL file cache; `mode=off` or `killSwitch` → `exit 0` (zero cost past this point).
   - `compactionInFlight` → fail-open (`exit 0`) with telemetry — never block during compaction.
   - The unjustified-stop-check outcome is **authoritative** for the Stop event; autonomous-mode's pre-existing "block every stop" does **not** separately re-fire (no double-gate path — parent § iter-3 F1 fix).
   - Detectors (signal-only, including `mentionsFreshSession`, `mentionsLaterSession`, `mentionsBreakPoint`, `suspiciouslyQuiet`); only the `UnjustifiedStopGate` LLM authority + deterministic evidence verifier can block.
   - `durableArtifacts` collection via `git ls-files` + `introducingCommit` timestamp vs `sessionStartTs` (parent § F2 fix).
   - On no `sessionStartTs` record → `exit 0` + one-time `DegradationReport` (fail-open).
2. **Config dial.** Add `unjustifiedStopGate?: { mode: 'off' | 'shadow' | 'enforce' }` to config types, default `off`. Server reads it (it already exposes `/internal/stop-gate/mode`); hooks read mode via `/internal/stop-gate/hot-path`, never the file (parent § "Config flag — server-mediated").
3. **Migration parity (CLAUDE.md Migration Parity Standard).**
   - `migrateConfig()` — add `unjustifiedStopGate: { mode: 'off' }` if absent (existence-checked, idempotent).
   - `migrateSettings()` / `migrateHooks()` — ensure the deployed `autonomous-stop-hook.sh` carries the router. Built-in hooks are always-overwritten on migration, so the router ships to existing agents on update. Verify the `feature-delivery-completeness` three-legged-stool test covers the new config block.
   - Backup the existing hook to `.instar/hook-backups/` before overwrite (parent § I205).
4. **Shadow flip (parent PR4).** `instar gate set unjustified-stop --mode shadow` once the hook router is live and the e2e compaction test is green. Shadow = observe-only: detectors fire, authority evaluates, decisions are logged to `StopGateDb`, **nothing blocks**. This generates the machine-side "human-as-detector heat map" the parent spec's measurement section describes.
5. **Enforce flip (parent PR5).** Only after the parent spec's already-approved enforce-flip thresholds are met (≥50 triggered evals, ≥14 days shadow, ≥20 human-reviewed annotations from ≥2 operators, zero `invalidRule`/`invalidEvidence` in last 50, latency budgets, e2e ≥90% for 7 days). `instar gate set unjustified-stop --mode enforce --check-thresholds`.

### Out of scope

- Re-opening any parent-spec design decision. If reality forces a change, that is a parent-spec amendment, reviewed separately.
- The **secondary** dark gate (`response-review.js` / CoherenceGate `responseReview` with `B15_CONTEXT_DEATH_STOP`). It is a separate outbound-message tone gate, also dark, tracked independently — NOT part of this rollout. Wiring it is a distinct decision (it reviews message tone, not Stop events). Noted here only to prevent re-conflation.
- The always-on `deferral-detector.js` "fresh"-vocabulary backstop (cheap signal layer). Small and independent; folded into the Liveness Reconciler spec's signal-layer work or shipped as a trivial standalone change. Does not gate this rollout.

## Testing (Testing Integrity Standard — all three tiers)

- **Unit:** router decision logic (mode routing, kill-switch precedence, compaction fail-open, signal detection incl. `mentionsFreshSession`, `durableArtifacts` classification). Config default present + idempotent migration.
- **Integration:** full HTTP pipeline — hook → `/internal/stop-gate/hot-path` → `/internal/stop-gate/evaluate` → `UnjustifiedStopGate` → `StopGateDb` row written. Mode=off short-circuits; mode=shadow logs-but-allows; mode=enforce blocks on a `continue` decision.
- **E2E:** parent spec's compaction-recovery test (already built, PR2) must stay green; add a lifecycle test asserting `/internal/stop-gate/evaluate` returns 200 (alive) and that a fabricated context-death stop with a pre-session plan artifact yields a `continue` outcome in enforce mode.
- **Wiring-integrity:** assert the deployed `autonomous-stop-hook.sh` actually contains a caller of `/internal/stop-gate/evaluate` (this is the exact regression that produced the dark gate — a test that would have caught it).

## Rollback

Inherits the parent spec's rollback verbatim: kill-switch (`instar gate kill-switch --set`, git-sync fanout), mode flip to `off`, decision log preserved. Additionally: the hook backup in `.instar/hook-backups/` allows reverting the router integration; `mode=off` makes the router a zero-cost no-op regardless.

## Success criteria

- A wiring-integrity test proves the deployed hook calls the evaluate endpoint (no longer dark).
- `StopGateDb` accrues eval events in shadow mode (proof of data-flow, not just existence).
- Parent spec's enforce-flip thresholds met before enforce.
- The sibling Liveness Reconciler, run against this feature, flips it from `DARK` to `VERIFIED` after completion (dogfood cross-check).
