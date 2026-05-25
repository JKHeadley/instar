---
title: "Built-but-dark Liveness Reconciler — automate verify-claim across the whole feature surface, ledger-informed, flood-free"
slug: built-but-dark-liveness-reconciler
status: draft
approved: false
date: 2026-05-24
author: echo
eli16-overview: built-but-dark-liveness-reconciler.eli16.md
---

# Built-but-dark Liveness Reconciler

## One-paragraph summary

Instar repeatedly ships features that are fully spec'd, coded, tested, and merged — and then never wired into runtime, never enabled in config, or never deployed. The context-death stop-gate is a caught-red-handed instance: the server authority shipped but its hook client and its activation never did, and **nothing noticed for months**. Every existing guard against this (`feature-delivery-completeness` three-legged-stool test, per-component wiring tests, `capabilities-discoverability` lint, E2E "feature is alive" tests, the manual `verify-claim` skill) runs at **build time, per-feature, opt-in**. None is a **runtime, fleet-wide, automatic** reconciler. This spec adds the **Liveness Reconciler**: a scheduled job + `/liveness` endpoint that automates the `verify-claim` 4-tier protocol (existence → substantive → wired → data-flow) across the entire declared feature surface, classifies each feature `VERIFIED` / `DARK` / `HOLLOW` / `DEPLOY-LAG`, and surfaces **only dark features that are unexplained and new** — where "explained" is defined by the **existing `FeatureRegistry` decision ledger** (`discovery.db` + `discovery-events.jsonl`), which already carries server-enforced anti-flood machinery (`MAX_DECLINES`, cooldowns, version-aware re-surfacing). The reconciler never mutates anything (detect-and-surface only; signal-vs-authority). Steady state is silent.

## Problem

On 2026-05-24 (topic 12702), Justin flagged a recurring gravity well: "fully spec'd and built features that either never get deployed or never turn on." Investigation confirmed it with a live example — the context-death stop-gate (`context-death-pitfall-prevention.md`, approved 2026-04-17): server-side `UnjustifiedStopGate` + `StopGateDb` + `/internal/stop-gate/*` routes + `instar gate` CLI all landed, but the hook-router client was never integrated (zero callers), no `unjustifiedStopGate` config dial exists, and it was never flipped past `mode=off`. A second, independent defense for the same hazard (`response-review.js` / CoherenceGate `responseReview` with `B15_CONTEXT_DEATH_STOP`) is *also* dark — file on disk, not in `settings.json Stop[]`, flag absent. Two complete defenses, both off, for months, with no alarm.

Justin's framing requirement: the solution must be **robust but must NOT flood the user with notifications they have to handle**, and should leverage a **ledger of past decisions** (e.g. "the user purposefully disabled this on date X because Y") so the system can make an informed call about whether something is even worth raising.

## Evidence

1. **Live dark feature #1:** context-death stop-gate, server half shipped (commits #54, #56, `42cb9eeef`), hook client never wired (`grep` over `.claude/`, `src/data/`, `src/templates/`, `src/scaffold/` → zero callers of `/internal/stop-gate/evaluate`), `StopGateDb` eval events = 0.
2. **Live dark feature #2:** `response-review.js` written to disk by `PostUpdateMigrator.ts:1428`, absent from `settings.json Stop[]` (`grep -c` = 0), `responseReview.enabled` absent from config.
3. **Guard inventory (all build-time / opt-in):** `tests/unit/feature-delivery-completeness.test.ts` (init↔migrator↔docs parity), `tests/integration/*-wiring.test.ts` (per-component DI), `tests/unit/capabilities-discoverability.test.ts` (route-prefix classification), `tests/e2e/*-lifecycle.test.ts` (Phase-1 "alive"), `.claude/skills/verify-claim/SKILL.md` (manual). **No runtime fleet-wide reconciler exists.**
4. **Ledger substrate already exists:** `src/core/FeatureRegistry.ts` persists `FeatureState` in `discovery.db` (SQLite) + append-only `state/discovery-events.jsonl` (`DiscoveryEvent`: timestamp/userId/featureId/previousState/newState/trigger/surfacedAs/context), with `MAX_DECLINES=3` (permanent quiet), `cooldownAfterSurfaceMs`/`cooldownAfterDeclineMs`, `declinedAtVersion` (version-aware re-surfacing), `VALID_TRANSITIONS` state machine, and `ConsentRecord` for high-tier activations.

## Root cause

We treat "merged with green CI" as the **authority** on whether a feature is alive. It is only a **signal** — it proves the code and its tests exist, not that the feature is wired, enabled, deployed, and flowing data. The `verify-claim` skill encodes the right four-tier check, but it is manual and per-claim, so it is only ever run when someone already suspects a problem. There is no continuous, whole-surface authority that reconciles *declared intent* against *runtime reality*. Without one, a feature that passes its own tests but is never switched on is invisible.

## Non-goals

- **Not** auto-remediation. The reconciler never edits config, settings, or hooks (posture A; see § Handling posture). Auto-fixing is a possible future spec, earned only after the detector is trusted.
- **Not** a parallel ledger. We reuse `FeatureRegistry`'s `discovery.db` + `discovery-events.jsonl`. Inventing a second decision store would fork the truth.
- **Not** a notifier that nags. Surfacing is gated by the existing anti-flood machinery plus this spec's suppression layers. Steady state is silent.
- **Not** a security boundary. Like the parent stop-gate, this is drift/oversight correction, not adversarial defense.
- **Not** a replacement for the build-time guards. It is the runtime backstop that catches what they miss (the activation/deployment gap downstream of merge).

## Design constraints

1. **Flood-free by construction (Justin's hard requirement).** A finding reaches the user only if it is dark AND unexplained AND new AND severity-warranted, after coalescing. Explained darkness (a recorded decision) is silent forever.
2. **Ledger-informed, not ledger-duplicating.** Reuse `FeatureRegistry`. Extend its subject set and guarantee a reason is captured; do not build a second store.
3. **Detect-only authority.** The reconciler is a signal/visibility surface. It never mutates runtime state. (Signal-vs-authority: detector signals; the human, or a future explicitly-approved gate, acts.)
4. **Near-silent (CLAUDE.md notification standard).** Routine "all live" status goes to a pull surface (`/liveness`, dashboard), never pushed. Only safety-category unexplained-dark is pushed, coalesced into one digest.
5. **Cheap.** Reconciliation is mostly deterministic (filesystem + git + route table + SQLite row counts). LLM use is optional and bounded (only for fuzzy spec↔capability matching, with a daily cap), so the steady-state cost is ~zero.

## Design

### Three sources of truth, reconciled

For every **declared feature**, the reconciler gathers three independent readings and combines them via the `verify-claim` tiers:

| Source | verify-claim tier | Question | Where it reads |
|---|---|---|---|
| **Intent** — what *should* be live | Existence / Substantive | "Is this declared and real?" | approved `docs/specs/*.md` (frontmatter `status: approved`), `FeatureDefinitions`, built-in hook files on disk, built-in skills |
| **Wiring** — is it plugged in? | Wired | "Constructed / registered / mounted / referenced?" | `CapabilityIndex` (`enabled`, non-null `ctx.X`), `settings.json` hook registration, mounted route prefixes, sentinels started in server startup |
| **Activation & flow** — is it doing anything? | Data-flow | "Flag on? Ever exercised?" | config flags, event/row counts (e.g. `StopGateDb` eval rows, review history, `lastSurfacedAt`, last-exercised timestamps) |

### Status taxonomy (mirrors verify-claim's status set)

- **VERIFIED** — declared + wired + enabled + has flow.
- **DARK** — declared + substantive (file/class/route exists) but **not wired** OR **flag-off**. (Both stop-gate instances.)
- **HOLLOW** — wired + enabled but **zero flow ever** (never exercised; the verify-claim "HOLLOW" status).
- **DEPLOY-LAG** — present/merged in source but not reflected in the running artifact (e.g. merged to `main` but `npm view instar version` / running version behind, or a migration that writes a file but never registers it).

### The decision ledger (reuse + close three gaps)

The reconciler's "explained?" question is answered by `FeatureRegistry`. Three targeted extensions:

1. **Guarantee a reason + timestamp on every off-decision (Justin's "note of when and why").**
   - Make `DiscoveryEvent` require a non-empty reason when `newState ∈ {declined, disabled}` (today `context` is optional). Server rejects an off-transition with no reason.
   - When a user disables a feature **conversationally** ("turn off X because Y"), the agent records the reason into the ledger via the feature's `disableAction` path (or a new `POST /features/:id/decision` carrying `{state, reason, actor, topicId}`). This is the agent's responsibility, enforced by the same grounding discipline as other user-facing state writes.
2. **Extend the subject set beyond opt-in `FeatureDefinitions`.** Today the ledger tracks user-facing opt-in features. Add ledger subjects for the other dark classes — unwired hooks, undeployed/lagging code, hollow capabilities — keyed by a stable `subjectId` (e.g. `hook:response-review`, `capability:unjustifiedStopGate`, `route:/internal/stop-gate/evaluate`). These reuse the same `discovery.db` + `discovery-events.jsonl` + state machine + anti-flood counters.
3. **Reconciler writes its own dispositions back.** When a finding is surfaced and the user responds, that response is recorded as a ledger decision (declined/disabled-with-reason, or acknowledged), so the existing `MAX_DECLINES`/cooldown/version-aware machinery suppresses re-surfacing automatically.

### Surfacing pipeline — five suppression layers (flood-free)

A finding passes through, in order; failing any layer means it stays silent:

1. **Explained-darkness filter (the keystone).** Consult the ledger for the `subjectId`. If state ∈ {declined, disabled} **with a recorded reason**, OR `declineCount ≥ MAX_DECLINES` → silent forever. If declined but the feature's version changed since `declinedAtVersion` → eligible (rare).
2. **Novelty filter.** Diff against the previous reconciliation run (persisted). Only newly-dark or newly-escalating subjects pass; steady-state re-confirmation is silent.
3. **Severity gate.** Severity derived from `FeatureDefinitions.category`: `safety`-category unexplained-dark = critical; others = informational. Only critical is eligible to **push** (Telegram); the rest land on the pull surface (dashboard `/liveness`, Attention Queue at low priority).
4. **Coalescing.** If multiple subjects qualify in one run, emit **one** consolidated digest (Attention Queue entry + at most one Telegram message), never N messages (the same fix applied to the sentinel topic-spam flood — CLAUDE.md § Sentinel Notifications).
5. **Acknowledge-once.** Surfacing writes a pending-decision marker; any user response resolves it into a ledger decision → it will not re-surface (layer 1 then suppresses it).

**Net user experience:** normally nothing. You are pinged about a feature at most once — only if it is genuinely dark, has no decision on record, is new, and is safety-relevant — and your answer ("I turned that off because…") is recorded so it never asks again. Everything else is a quiet line on the dashboard. The ledger doubles as institutional memory: "why is X off?" has a recorded answer.

### Mechanism

- **`LivenessReconciler` core class** (`src/monitoring/`). Pure-ish: takes a snapshot of intent/wiring/activation, returns a classified report. Deterministic except for optional bounded LLM spec↔capability fuzzy-matching (daily-capped, fail-open to "unmatched → flag for human" rather than silent-drop).
- **`/liveness` endpoint** (`GET`, authed) — returns the latest report `{ subjectId, status, severity, explained, lastDecision, evidence }[]`. Phase-1 "alive" E2E asserts 200, not 503.
- **Scheduled job** (weekly default; `instar`-job declarative def) runs the reconciler, diffs against the prior run, applies the five-layer pipeline, writes dispositions. Reuses the existing job scheduler + `supervision: tier1` (Haiku validates the surfacing decision before any push — LLM-Supervised Execution standard).
- **Dashboard "Liveness" tab** — the pull surface; lists every subject with status + last decision + reason. This is where "explained" darkness lives visibly without ever pinging.
- **CLI** `instar liveness [--since] [--status dark]` — operator view; shares the report.

### Dogfood gate (non-negotiable)

The reconciler is **not done** until, run against the current tree, it:
1. Classifies the context-death stop-gate (`/internal/stop-gate/evaluate` route exists, zero callers, `StopGateDb` empty) as **DARK / unexplained** and surfaces it exactly once.
2. Classifies `response-review.js` (on disk, not in `Stop[]`) as **DARK / unexplained**.
3. After the rollout-completion spec wires the stop-gate and a decision is recorded, re-classifies it as **VERIFIED** (or explained) and goes silent.

A detector that cannot catch the two bugs that motivated it has failed.

## Rollout

- **PR1: `LivenessReconciler` core + unit tests.** Intent/wiring/activation collectors; status classification; no surfacing yet. Unit tests cover both sides of each tier boundary (verify-claim parity).
- **PR2: `/liveness` endpoint + Phase-1 E2E + dashboard tab + CLI.** Read-only surface. Integration test: route returns 200 with a real report.
- **PR3: Ledger extensions.** Required-reason on off-transitions; extended subject set; `POST /features/:id/decision` (or reuse disableAction) for conversational reason capture. Migration parity for the `discovery.db` schema additions (idempotent). Wiring-integrity test that the reason is actually persisted.
- **PR4: Surfacing pipeline (five layers) + scheduled job, observe-only.** Job runs and writes the report + dispositions but does **not** push; everything to the pull surface. Gather a few cycles of real data; confirm the dogfood gate (both dark gates flagged).
- **PR5: Enable push for safety-category only.** Flip the severity-gate push for `safety` unexplained-dark, coalesced. Gated on: zero false-positive pushes across the observe-only cycles, dogfood gate green.

Migration parity (CLAUDE.md standard) applies throughout: config defaults via `migrateConfig()`, job def installed for existing agents, `discovery.db` schema migration idempotent, any CLAUDE.md template capability section added per the Agent Awareness Standard.

## Rollback

- The reconciler mutates **no** runtime state, so disabling it is inert: remove/disable the scheduled job; `/liveness` becomes a stale-but-harmless read. Ledger extensions are additive (extra rows/columns), reversible by ignoring them. No feature is ever touched by this system, so there is no activation to revert.

## Signal-vs-authority compliance

| Component | Class | Mutates / blocks? | Notes |
|---|---|---|---|
| Intent/wiring/activation collectors | Detector | No | Deterministic readings. |
| Status classifier | Detector | No | Maps readings → {VERIFIED,DARK,HOLLOW,DEPLOY-LAG}. |
| Explained-darkness + 4 suppression layers | Detector | No | Decide whether to surface; never act on the feature. |
| `FeatureRegistry` ledger | State | Appends decisions only | Reused; existing anti-flood authority. |
| Tier1 supervisor (Haiku) on push | Authority (over the *message*) | Gates the notification only | Validates a push is warranted; cannot enable/disable any feature. |

No component in this system enables, disables, wires, or deploys a feature. That authority remains with the human (or a future, separately-approved remediation spec).

## Side-effects review

- **Over-surface risk (the flood Justin fears):** mitigated structurally by five layers, dominated by the explained-darkness filter + the existing `MAX_DECLINES`/cooldown/version-aware machinery. Observe-only PR4 proves the false-positive rate before any push is enabled (PR5 gate).
- **Under-surface risk (missing a real dark feature):** the deterministic collectors err toward flagging (unmatched spec→capability = flag, not silent-drop); HOLLOW/DEPLOY-LAG classes catch the subtler cases build-time guards miss.
- **Ledger-poisoning / wrong-explanation:** decisions are append-only with actor + timestamp + reason; a stale "explained" can be re-opened by a version bump (version-aware re-surfacing) or an operator clearing the decision.
- **Cost:** deterministic core ≈ free; optional LLM fuzzy-match daily-capped (target < $0.05/day). Weekly cadence.
- **Interaction with build-time guards:** complementary, not redundant — they gate *merge*; this gates *liveness after merge*. The `feature-delivery-completeness` test remains the init↔migrator↔docs authority; the reconciler is the runtime backstop.

## Success criteria

- **Dogfood:** both dark gates correctly classified `DARK/unexplained`; after stop-gate rollout-completion + recorded decision, stop-gate re-classifies to `VERIFIED`/explained and goes silent.
- **Flood-free:** across ≥4 observe-only weekly cycles, zero pushes for explained or repeat findings; ≤1 coalesced digest per cycle even with multiple findings.
- **Coverage:** every approved spec maps to a reconciled subject (or is explicitly marked design-only/no-runtime-surface in the ledger).
- **Silence at rest:** a fully-VERIFIED tree produces zero user-facing notifications.
- **Institutional memory:** "why is feature X off?" answerable from the ledger for every disabled/declined subject (reason present).

## Open questions (for /spec-converge)

1. **Subject identity for non-FeatureDefinition classes.** Stable `subjectId` scheme for hooks/routes/capabilities so the ledger and reconciler agree across renames. (Proposed: `class:name`, with a rename-migration map.)
2. **Spec↔capability matching.** Deterministic mapping table (spec frontmatter `slug` → capability key) vs bounded LLM fuzzy-match for un-mapped specs. Lean deterministic table + LLM only for the residual, fail-open to "flag for human."
3. **DEPLOY-LAG detection fidelity.** How far to take the "merged ≠ published ≠ running" check (cheap: `UpdateChecker` version delta; richer: per-feature presence in the running build). Start cheap.
4. **Cadence.** Weekly default vs event-triggered (post-merge / post-update hook). Start weekly; consider a post-update trigger later.
