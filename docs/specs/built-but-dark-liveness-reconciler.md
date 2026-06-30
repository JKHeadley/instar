---
title: "Built-but-dark Liveness Reconciler — automate verify-claim across the whole feature surface, intent-modality-aware, baseline-anchored, flood-free"
slug: built-but-dark-liveness-reconciler
status: draft
approved: false
date: 2026-05-24
author: echo
review-iterations: 1
review-convergence: "internal-multi-lens-2026-05-24 (architecture + standards + failure-modes + grounding); see reports/built-but-dark-liveness-reconciler-convergence.md"
eli16-overview: built-but-dark-liveness-reconciler.eli16.md
---

# Built-but-dark Liveness Reconciler

> **Convergence note (iter-1 → this draft).** The first draft overclaimed reuse of three existing systems (`FeatureRegistry`, `CapabilityIndex`, runtime call signals) that do not hold the data it needs, and would have flooded on first run with 100+ false-positive "dark" findings. This revision adds the two missing architectural primitives the reviewers identified — an **intent-modality axis** (`should-be-live` vs `should-be-offerable`) and a **baseline anchor** — and replaces the FeatureRegistry-reuse story with a **dedicated `LivenessLedger` that reuses the anti-flood *patterns*** while keeping `FeatureRegistry` decisions as one (of several) explained-darkness inputs for the subjects it actually owns. Full findings + resolutions: `docs/specs/reports/built-but-dark-liveness-reconciler-convergence.md`.

## One-paragraph summary

Instar repeatedly ships features that are fully spec'd, coded, tested, and merged — and then never wired into runtime, never enabled in config, or never deployed. The context-death stop-gate is the caught-red-handed instance: the server authority shipped but its hook client and activation never did, and nothing noticed for months. Every existing guard runs at **build time, per-feature, opt-in** (`feature-delivery-completeness`, per-component wiring tests, `capabilities-discoverability` lint, E2E "feature is alive" tests, the manual `verify-claim` skill) — none is a **runtime, fleet-wide, automatic** reconciler. This spec adds the **Liveness Reconciler**: a scheduled job + `/liveness` endpoint that classifies every subject in a **declared inventory** by `verify-claim`'s four tiers, but only treats "off/unwired" as a *defect* when the subject's **intent-modality is `should-be-live`** (a defense/infra feature that must run) — opt-in `should-be-offerable` features being correctly off is never a finding. A one-time **baseline anchor** marks the existing state as accepted so the first run is silent except genuine regressions. It surfaces only findings that are **unexplained, new, and severity-warranted**, coalesced, where "explained" is read from a purpose-built **`LivenessLedger`** (system-scoped, append-only, reusing the anti-flood patterns proven in `FeatureRegistry`: surface-caps, cooldowns, content-hash/version-aware re-surfacing) plus, for opt-in subjects it covers, `FeatureRegistry`'s existing decisions. The reconciler **mutates no feature** (detect-and-surface only; signal-vs-authority). Steady state is silent.

## Problem

On 2026-05-24 (topic 12702), Justin flagged a recurring gravity well: "fully spec'd and built features that either never get deployed or never turn on." A live example confirmed it: the context-death stop-gate (`context-death-pitfall-prevention.md`, approved 2026-04-17) shipped its server half (`UnjustifiedStopGate` + `StopGateDb` + `/internal/stop-gate/*` routes + `instar gate` CLI, commits #54/#56/`42cb9eeef`) but the hook-router client was never integrated (zero callers of `/internal/stop-gate/evaluate`), no `unjustifiedStopGate` config dial exists, and it was never flipped past `mode=off`. A second, independent defense for the same hazard (`response-review.js` / CoherenceGate `responseReview` with `B15_CONTEXT_DEATH_STOP`) is *also* dark. Two complete defenses, both off, for months, no alarm.

Justin's hard requirement: **robust but must NOT flood the user with notifications they have to handle**, leveraging a **ledger of past decisions** ("the user purposefully disabled this on date X because Y") so the system makes an informed call about whether something is even worth raising.

## Evidence

1. Dark feature #1: context-death stop-gate — server half shipped, hook client never wired (`grep` over `.claude/`, `src/data/`, `src/templates/`, `src/scaffold/` → 0 callers of `/internal/stop-gate/evaluate`), `StopGateDb` eval events = 0. **`unjustifiedStopGate` is NOT a `FeatureDefinition`** (verified — 0 matches in `FeatureDefinitions.ts`).
2. Dark feature #2: `response-review.js` written to disk by `PostUpdateMigrator.ts:1428`, absent from `settings.json Stop[]` (grep = 0), `responseReview.enabled` absent. **`response-review` IS a `FeatureDefinition`** (safety category) — so the two dogfood targets fall on opposite sides of the FeatureDefinition boundary, which the design must handle.
3. Guard inventory (all build-time / opt-in): `tests/unit/feature-delivery-completeness.test.ts`, `tests/integration/*-wiring.test.ts`, `tests/unit/capabilities-discoverability.test.ts`, `tests/e2e/*-lifecycle.test.ts`, `.claude/skills/verify-claim/SKILL.md`. No runtime fleet-wide reconciler.
4. Surface scale (verified): **194 spec files, ~128 `status: approved`**, **16 hooks**, **13 `FeatureDefinitions` (3 `safety`, mostly off-by-default opt-in)**. Most approved specs are standards/docs with **no runtime surface**. This scale is why naive "every off thing is dark" floods.
5. Ledger substrate (verified, with limits): `FeatureRegistry` (`discovery.db` + `discovery-events.jsonl`) has `MAX_DECLINES=3`, cooldowns, `declinedAtVersion`, `VALID_TRANSITIONS`, `ConsentRecord`. **But:** it is gated on the 13-entry `definitions` map (`getState`/`transition` refuse unknown ids), is keyed per-`userId`, has no `undiscovered→disabled` edge, and its `DiscoveryEvent.context` is the only reason field and is **optional**. The boot-time config-sync path (`bootstrap()`) sets `disabled` with **no reason/actor**.

## Root cause

We treat "merged with green CI" as the **authority** on whether a feature is alive. It is only a **signal**: it proves code + tests exist, not that the feature is wired, enabled, deployed, and flowing. `verify-claim` encodes the right four-tier check but is manual and per-claim. There is no continuous, whole-surface authority reconciling *declared intent* against *runtime reality* — and, crucially, no representation of **what kind of "live" a feature is supposed to be**, so "correctly off" and "wrongly dark" are indistinguishable.

## Non-goals

- **Not** auto-remediation. The reconciler never edits config/settings/hooks (posture A). Auto-fix is a future, separately-approved spec.
- **Not** a security boundary. Drift/oversight correction, not adversarial defense.
- **Not** a nagger. Surfacing is gated by intent-modality + baseline + the suppression layers. Steady state is silent.
- **Not** a replacement for build-time guards. It is the runtime backstop downstream of merge.
- **Not** a claim of detecting "zero callers" purely at runtime. See § "Honest scope of detection."

## Design constraints

1. **Flood-free by construction (hard requirement).** First run is silent except genuine regressions (baseline anchor). Steady state surfaces only `should-be-live` + dark + unexplained + new + severity-warranted, coalesced.
2. **Intent-modality first.** "Off" is only a defect for `should-be-live` subjects. This is the primitive that collapses the 100+ cold-start false-positives to the small set that matters.
3. **Detect-only authority.** The reconciler mutates no feature. (Signal-vs-authority.)
4. **Structural reason-capture, never willpower.** A subject can become "explained" only through a structural path (API requires a reason; config-sync auto-stamps a synthetic reason). The reconciler NEVER assumes the agent remembered to record anything.
5. **Honest reuse.** Reuse `FeatureRegistry` decisions for the FeatureDefinition subjects it owns; reuse the anti-flood *patterns* everywhere; build a dedicated store for non-FeatureDefinition subjects rather than overclaiming.
6. **Cheap & deterministic.** Classification is filesystem/git/route-table/SQLite-count based. LLM use is bounded and optional.
7. **The reconciler watches itself.** A liveness checker that can silently die is the ultimate built-but-dark; an independent heartbeat guards it.

## Design

### 1. The declared inventory + intent-modality (the keystone primitive)

The reconciler operates over a **declared inventory** of subjects. Each subject has a stable `subjectId` and an **intent-modality**:

- **`should-be-live`** — a defense, sentinel, safety hook, or infrastructure feature that is *supposed to be running* whenever the agent is up. Dark = defect. (e.g. the context-death stop-gate, `response-review` stop-hook, monitoring sentinels.)
- **`should-be-offerable`** — an opt-in feature that is *correctly off until the user asks for it*. Off = working as designed; **never a finding** on the off-axis. (e.g. Threadline relay, tunnel, evolution auto-apply, named tunnel.)
- **`design-only`** — a spec/standard/doc with no runtime surface. Excluded from liveness entirely.

**How modality is assigned (deterministic, opt-in, no manual treadmill):**
- A spec declares its runtime surface in frontmatter: `runtime-surface: <subjectId>` (+ `runtime-modality: live|offerable`). **Absence ⇒ `design-only` ⇒ silent.** This *inverts the dangerous default* the reviewers flagged: a spec is a liveness subject only if it opts in. The 100+ doc/standard specs never surface.
- For `FeatureDefinitions`: modality derives from `consentTier` — `consentTier ∈ {network, self-governing}` (consent-required, opt-in) ⇒ `should-be-offerable`; otherwise the feature's spec must mark it `live` explicitly. (No silent promotion to `should-be-live`.)
- For hooks/routes/sentinels not backed by a FeatureDefinition: an explicit, version-controlled **`liveness-manifest`** (`src/data/liveness-subjects.ts`) enumerates `should-be-live` infra subjects with their `subjectId`, severity, and the wiring/activation probes that prove them live. This manifest is small, reviewed, and is itself covered by `feature-delivery-completeness`-style parity (adding a sentinel/safety-hook requires adding its liveness entry — enforced by a test).

Only `should-be-live` subjects can ever produce an off-axis finding. `should-be-offerable` subjects are tracked for HOLLOW/regression only (see taxonomy).

### 2. Three reconciled readings (verify-claim tiers) — with corrected sources

For each subject, gather three independent readings:

| Reading | verify-claim tier | Source (corrected per grounding review) |
|---|---|---|
| **Intent** | Existence / Substantive | declared inventory: opt-in spec `runtime-surface` + `liveness-manifest` + `FeatureDefinitions`. Artifact existence on disk + non-stub check. |
| **Wiring** | Wired | a **dedicated wiring snapshot** the reconciler builds: route-table dump **including `/internal/*`** (CapabilityIndex excludes those, so it is NOT the wiring authority — it is at most one hint), `settings.json` hook registration, and a server-startup **construction registry** (components register themselves at construction so "constructed?" is a runtime fact, not a guess). |
| **Activation & flow** | Data-flow | config flag state; feature-specific activity counters where they exist (e.g. `StopGateDb` eval-event count — add a `countEvents()` accessor; `FeatureRegistry.lastSurfacedAt`); a **lightweight per-route invocation counter** (new, see § honest scope) for the wired-but-never-called case. |

### 3. Honest scope of detection

There is no global per-route call tracker today (verified). Two honest moves:
- **Add a minimal invocation counter** to the route layer (a single in-memory `Map<routePrefix, {count, lastAt}>` flushed periodically to the liveness store). This makes "wired-but-never-called" a genuine runtime signal for routes that opt into counting (cheap; safety/`should-be-live` routes opt in).
- **Where a runtime signal is unavailable**, the wiring reading falls back to a **static reference scan** (does any hook/script/settings entry reference this subject?). This is acknowledged as static analysis run *continuously over the whole surface* — still strictly more than the opt-in/per-feature build-time guards, but the spec does **not** claim it is a runtime signal. The status carries a `evidenceKind: runtime|static` field so consumers know.

### 4. Status taxonomy (mutually exclusive, with precedence)

Evaluated in order; first match wins:

1. **DESIGN-ONLY** — no runtime surface. Excluded.
2. **INTENTIONALLY-OFF** — `should-be-offerable` + off. Correct by design; not a finding (tracked only for later HOLLOW once enabled).
3. **DARK** — `should-be-live` + (not wired OR flag-off). **Defect.** (Both stop-gate instances.)
4. **HOLLOW** — wired + enabled but zero flow where flow is *expected*. Requires an **`expects-flow` predicate** per subject (a sentinel that fires only on failure legitimately has zero flow → not HOLLOW; it sets `expects-flow: on-trigger-only`).
5. **DEPLOY-LAG** — **demoted to a single global advisory**, not per-feature: `UpdateChecker` only exposes one installed-vs-published version delta (verified), so DEPLOY-LAG is one informational line ("running vX, latest vY"), never per-subject.
6. **VERIFIED** — declared + wired + enabled + flow-as-expected.

### 5. The LivenessLedger (dedicated; reuses anti-flood patterns)

A purpose-built, **system-scoped** (no per-user key), append-only ledger — a new table in `discovery.db` (sharing the file, not the `FeatureRegistry` schema) `liveness_dispositions` + an append log `state/liveness-events.jsonl`:

- Row: `{ subjectId, status, modality, disposition, reason, reasonClass, actor, ts, evidenceHash, surfaceCount }`.
- `disposition ∈ { baseline-accepted, acknowledged, declined, snoozed, pending, open }` — a **liveness-specific** state model (resolving the "consent FSM has no undiscovered→disabled edge" finding; we do not reuse `VALID_TRANSITIONS`).
- `reasonClass ∈ { permanent-by-design, conditional }`. **Conditional** explanations carry a re-validation key = `evidenceHash` (content hash of the subject's wiring/code) and re-surface (pull-surface only, never push) when that hash changes — fixing "stale explanation silences a real dark feature forever," and giving versionless subjects (hooks/routes) a re-surfacing key in place of `featureVersion`.
- **Reuses the proven patterns:** a `MAX_SURFACES` cap (analogous to `MAX_DECLINES`) on *surfaces* (not declines, so an ignored finding still ages out — fixing the never-responded gap), cooldowns, and hash/version-aware re-surfacing.
- **For FeatureDefinition subjects**, the reconciler ALSO reads `FeatureRegistry`'s existing `{declined, disabled}` + reason as an explained-darkness input (honest, bounded reuse where it actually fits — e.g. `response-review`).

### 6. The baseline anchor (cold-start flood fix)

On first reconciliation against a tree (idempotent, gated, one-time per `subjectId`):
- Every **`should-be-offerable`** subject currently off → no action (INTENTIONALLY-OFF, silent).
- Every **`should-be-live`** subject currently dark → written as `disposition: baseline-accepted`, `reasonClass: conditional`, `reason: "present-and-dark at baseline <version> <date>; not individually triaged"`, with `evidenceHash` captured. **Silent at baseline**, BUT because it's `conditional` it appears on the pull-surface dashboard as "dark (baselined)" and re-surfaces (pull-surface) if its evidenceHash changes.
- **Exception — the motivating regressions are NOT baseline-silenced:** a `should-be-live` subject whose intent source is a **spec approved AFTER the baseline date** (or explicitly tagged `liveness-priority: enforce`) is treated as an active finding, not baseline-accepted. The context-death stop-gate qualifies (approved 2026-04-17; its rollout is intended to complete) → it surfaces. This is how the dogfood gate stays honest without the baseline burying it.

> **Design tension, surfaced for ratification:** baseline-accept means the *first* deploy of the reconciler does not re-litigate years of accumulated dark infra in one flood — but it also means a genuinely-bad pre-baseline dark feature stays quiet until its code changes. The `liveness-priority: enforce` tag + the post-baseline-approval rule are the escape valves. Justin should confirm this trade is acceptable (alternative: a one-time, paced "baseline review" digest of N-per-week rather than silent-accept).

### 7. Surfacing pipeline (flood-free), in order

A finding must pass every layer:
1. **Modality gate** — only `should-be-live` + DARK (or expected-flow HOLLOW) proceeds. (Kills the opt-in false-positive class.)
2. **Baseline gate** — baseline-accepted subjects are silent unless evidenceHash changed or they carry `liveness-priority: enforce`.
3. **Explained-darkness gate** — `LivenessLedger` (+ `FeatureRegistry` for FD subjects) has a disposition with a reason, or `surfaceCount ≥ MAX_SURFACES` → silent. Config-sync-off subjects carry a synthetic `system` reason → silent.
4. **Novelty gate** — diff vs prior run; only new/regressed proceeds.
5. **Severity gate** — severity from the `liveness-manifest`/FeatureDefinition; only `severity: critical` (safety-critical, explicitly assigned — never inferred from a sparse enum) is eligible to push. Others → pull-surface.
6. **Coalesce** — one digest, one push max per run.
7. **Acknowledge/age** — surfacing increments `surfaceCount` and writes `pending`; a user response → `acknowledged`/`declined` (with reason); unanswered re-enters the next digest up to `MAX_SURFACES`, then ages to `pending-aged` → pull-surface only, never pushed again.

### 8. Reason capture — structural (resolves C2 / no-manual-work)

- The **only** ways a subject becomes "explained": (a) a decision through `POST /liveness/:subjectId/decision` (or the existing feature `disableAction`) which **requires a non-empty reason at the API layer** (server rejects reason-less off-decisions); (b) config-sync auto-stamps a synthetic `system` reason (`"absent/false in config as of <version>"`); (c) baseline-accept's synthetic reason. The agent recording a conversational "turn off X because Y" uses path (a) — but if it forgets, the subject is simply **not explained**, so the reconciler's *first* contact is a low-priority pull-surface "why is this off?" — it **never assumes** capture happened. No willpower dependency.

### 9. Self-liveness (resolves "who watches the reconciler")

`/liveness` exposes `lastReconciliationAt`. The existing `guardian-pulse` meta-monitor (a *different* mechanism than the weekly job) asserts `now - lastReconciliationAt < 2× cadence` and escalates if stale. The reconciler also lists **itself** as a `should-be-live` subject in its own report.

### 10. Mechanism

- **`LivenessReconciler`** core class (`src/monitoring/`), constructed in server startup with real deps (inventory builder, wiring snapshot, `LivenessLedger`, intelligence provider) and **self-registered in the startup construction registry** (so its own wiring is a runtime fact, and a wiring-integrity test asserts it — resolves H1).
- **`GET /liveness`** (authed) — latest report; Phase-1 E2E asserts 200. Mirrors the `/tokens/summary` / `/operations/log` read-only pattern (verified to exist).
- **Scheduled job** (default weekly; **plus a post-update trigger for `severity: critical` subjects** so a safety regression isn't blind for ~7 days — promotes open-question #4). `supervision: tier1` — Haiku supervises only the *surfacing/push decision*; classification is deterministic by design (explicit per the state-detection-robustness standard). Supervisor return type is structurally `{ shouldSurface, severity }` only — no field that could carry a mutation (type-enforces the no-mutation property).
- **Dashboard "Liveness" tab** — the pull surface; every subject + status + disposition + reason + evidenceKind.
- **CLI** `instar liveness [--status dark] [--since]`.

### Dogfood gate (non-negotiable, revised)

Run against the current tree, the reconciler must:
1. Classify the context-death stop-gate (`route:/internal/stop-gate/evaluate` wired:false, `StopGateDb` empty; `should-be-live`; spec approved post-? — tagged `liveness-priority: enforce`) as **DARK / unexplained** and surface it **exactly once**, with `severity: critical` from the liveness-manifest (NOT inferred — resolving the "would detect then not push its own bug" finding).
2. Classify `response-review` (FeatureDefinition, safety; on disk, not in `Stop[]`; `should-be-live`) as **DARK / unexplained**.
3. On the same first run, classify the ~13 opt-in features + the 100+ doc-only specs as **INTENTIONALLY-OFF / DESIGN-ONLY** and produce **zero** additional pushes (the anti-flood proof).
4. After the rollout-completion wires the stop-gate and a decision/baseline is recorded, re-classify it **VERIFIED** and go silent.

A detector that catches its two bugs but buries them among 100 false positives has failed.

## Rollout

- **PR1: declared inventory + intent-modality + `LivenessReconciler` core + unit tests.** Inventory builder (spec frontmatter scan, `liveness-manifest`, FeatureDefinitions), modality assignment, three-reading collectors, status classifier with precedence. Unit tests cover BOTH sides of every boundary (modality live/offerable; each status; evidenceKind runtime/static).
- **PR2: `/liveness` endpoint + Phase-1 E2E + dashboard tab + CLI + `generateClaudeMd` update (resolves C1).** Add `/liveness` to the CLAUDE.md template Capabilities section + a "Registry First" row ("why is X off? → GET /liveness") + a proactive trigger ("user asks 'is X on?' → GET /liveness"). Integration test: route returns 200 with a real report. (`feature-delivery-completeness` will now assert this parity.)
- **PR3: `LivenessLedger` + structural reason-capture.** New `liveness_dispositions` table + `liveness-events.jsonl`; `POST /liveness/:subjectId/decision` with API-layer mandatory reason; config-sync synthetic-reason path; `reason`/`actor`/`reasonClass`/`evidenceHash` as first-class fields. Migration parity **named concretely**: the table is created by an idempotent `CREATE TABLE IF NOT EXISTS` in the ledger's self-migrating init (where `discovery.db` schema is owned), seeded for existing agents; `migrateConfig()` adds any config defaults existence-checked. Tests: integration (decision route over HTTP, reason-rejection), e2e (schema migration idempotent on an existing populated DB), wiring (reason actually persisted).
- **PR4: baseline anchor + invocation counters + wiring snapshot + construction registry.** One-time idempotent baseline; per-route counter; startup construction registry + a **wiring-integrity test that `LivenessReconciler` is constructed with non-null deps and its job is registered** (resolves H1). Semantic-correctness tests for all seven suppression layers (both sides each).
- **PR5: surfacing pipeline, observe-only.** Job runs, writes report + dispositions, **no push**; everything to pull-surface. Run ≥4 cycles; confirm the dogfood gate (both targets flagged, zero other pushes).
- **PR6: enable push for `severity: critical` only + post-update trigger.** Gated on: zero false-positive pushes across observe-only cycles; dogfood gate green; self-liveness heartbeat wired in `guardian-pulse`.

Each PR leaves `npm run test:push`/`test:smoke` green (Zero-Failure Standard). Migration parity applies throughout (config defaults, job install for existing agents, idempotent `discovery.db` migration, CLAUDE.md template per Agent Awareness Standard).

## Rollback

The reconciler mutates **no** feature, so disabling it is inert: disable the scheduled job; `/liveness` becomes a stale-but-harmless read; the `guardian-pulse` heartbeat would (correctly) flag the reconciler itself as stale. Ledger tables are additive. No activation to revert.

## Signal-vs-authority compliance

| Component | Class | Mutates/blocks? | Notes |
|---|---|---|---|
| Inventory builder + collectors + classifier | Detector | No | Deterministic readings + precedence taxonomy. |
| Modality / baseline / explained / novelty / severity gates | Detector | No | Decide *whether to surface*; never act on a feature. |
| `LivenessLedger` | State | Appends dispositions only | Purpose-built; reuses anti-flood patterns; no feature mutation. |
| Tier1 supervisor (Haiku) | Authority over the *message* | Gates the push only | Return type `{shouldSurface,severity}` — structurally cannot carry a remediation action. |

No component enables/disables/wires/deploys any feature. A static test (mirroring `signal-vs-authority.spec.ts`) asserts no block/mutation statement exists outside the enumerated detectors.

## Side-effects review

- **Over-surface (the flood):** killed structurally by the modality gate (opt-in off is never a finding) + baseline anchor (pre-existing dark is accepted) + explained-gate + `MAX_SURFACES` + coalescing. Observe-only PR5 proves false-positive rate before any push (PR6 gate).
- **Under-surface:** `should-be-live` + dark always surfaces (modulo explained); HOLLOW/`expects-flow` catches subtler cases; the `liveness-priority: enforce` tag prevents baseline from hiding the motivating bugs; conditional-reason re-validation (evidenceHash) prevents stale explanations from blindfolding forever.
- **Manual-work audit:** modality is opt-in via frontmatter/manifest (version-controlled, parity-tested), not a per-cycle human treadmill; reason-capture is API-structural; baseline is one-time automatic. No standing manual capture.
- **Self-darkness:** independent `guardian-pulse` heartbeat + self-listing.
- **Cost:** deterministic core ≈ free; optional LLM fuzzy-match daily-capped (<$0.05/day); weekly + post-update-critical cadence.
- **Interaction with build-time guards:** complementary; `feature-delivery-completeness` remains the init↔migrator↔docs authority and will now also assert `/liveness` parity.

## Success criteria

- **Dogfood:** both dark gates classified DARK/unexplained and surfaced (stop-gate `critical`/pushed); after rollout-completion + recorded decision, stop-gate → VERIFIED, silent.
- **Flood-free (the gate that must be truthful):** across ≥4 observe-only cycles, **first run produces ≤2 pushes (the two motivating bugs) and zero others**; opt-in/doc-only subjects produce zero findings; ≤1 coalesced digest per cycle.
- **Coverage:** every `should-be-live` subject in the manifest is reconciled; every opt-in spec either declares `runtime-surface` or is silently design-only (no manual annotation treadmill).
- **Silence at rest:** a fully-VERIFIED tree → zero user-facing notifications.
- **Institutional memory:** "why is X off?" answerable from the `LivenessLedger`/`FeatureRegistry` for every off `should-be-live` subject (reason present, synthetic or human).
- **Self-liveness:** `guardian-pulse` alerts if the reconciler stops running.

## Open questions (for further /spec-converge / external cross-model round)

1. **Baseline trade (flagged above):** silent-accept of pre-existing dark vs a paced "baseline review" digest. Needs Justin's call.
2. **Invocation-counter scope:** which routes opt into counting (all `should-be-live` routes vs a curated set) and the memory cost at scale.
3. **`liveness-manifest` governance:** how adding a sentinel/safety-hook is forced to add a manifest entry (proposed: a parity test like `feature-delivery-completeness`, but defining "every `should-be-live` thing" mechanically is itself the hard problem this spec is about — partial bootstrap risk).
4. **External cross-model review:** per `feedback_external_crossmodel_catches_what_internal_misses`, a GPT/Gemini/Grok round should run before ratification; this convergence was Claude-family only.
