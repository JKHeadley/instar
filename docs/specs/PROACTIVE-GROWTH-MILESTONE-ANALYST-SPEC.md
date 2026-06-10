# Proactive Growth & Milestone Analyst — SPEC

Status: **Slice 1 implemented** (analyst core + window-expiry + read routes + 3-tier
tests, ships DARK). Sending / cadence / enabling the muted analyzers ride later
slices. Green-lit by Justin 2026-06-06 (topic 21624). Origin commitment: CMT-1151.

## 1. Problem (grounded, verified on disk)

Instar built excellent **sensors** (`InitiativeTracker`, `FeatureRolloutReconciler`,
`ApprovalLedger`, `CorrectionLedger`) and excellent **anti-flood plumbing** — but
never the **analyst layer** in between that reads the tracked data, decides what
crosses from noise into "a concrete milestone or realization worth telling the
operator," and proactively surfaces it. Result: total silence on growth/maturity/
pattern questions. The operator's words: *"I have YET to have an agent proactively
check in with me about ANY of these."*

Verified state at design time:
- Engines exist and are real. Routes: `/initiatives`, `/initiatives/digest`,
  `/rollouts`, `/initiative/attribution`, `/corrections`, `/approvals`.
- `initiative-digest-review` job is ENABLED but designed "near-silent — posts
  ONLY when a genuinely-new decision is waiting." That bar ~never trips → it
  effectively never speaks. No promotion recommendation has ever reached the
  operator.
- The conversation-pattern analyzers are OFF: `correction-analyzer`
  (`monitoring.correctionLearning.enabled:false`) and `failure-analyzer`. The
  approve-vs-change / correction-rate data piles up unread.
- ROOT CAUSE: anti-flood OVERCORRECTION from the topic-flood incidents (sentinel /
  worktree-detector / collaboration-redrive). Everything ships "quiet by default /
  observe-only." The pendulum swung from flood to silence.

The operator's three questions become first-class:
1. Are initiatives being left behind?
2. Are features earning their way through the maturity path (dark → enabled)?
3. Are patterns being extracted from conversation data (approve-vs-change-spec
   rate, correction rate)?

## 2. Goal

A single proactive analyst + **clear, explicit rules** for when something crosses
into "a concrete milestone or realization," delivered on a **regular cadence** AND
on **event triggers** — without re-introducing the flood.

## 3. KEY DESIGN LEVER — the tight incubation window (Justin, 2026-06-06)

The incubation/maturation window must stay **TIGHT: a week MAX, a few days for
low-risk features** — never weeks. The crucial reframe:

> **The window EXPIRING is the trigger itself.** This is the anti-"left behind"
> mechanism — "left behind" becomes structurally impossible because every
> incubating feature carries a deadline that drags it in front of the operator.

Two expiry shapes:
- **Proved itself** (window elapsed AND real activations) → milestone:
  *"`<feature>` incubated `<N>`d with `<M>` real activations and no issues →
  promote?"* (rule **R1**).
- **Never proved itself** (window elapsed, no proof-of-life) → decision:
  *"`<feature>` sat in `<stage>` `<N>`d and never proved itself → extend / fix /
  kill?"* (rule **R2**).

**Evidence gate must be REAL** (maturity honesty, ref keystone-dormancy #905):
promotion requires `daysInStage >= windowFor(riskTier)` **AND** real proof-of-life,
never elapsed time alone. A feature that never ran — or whose evidence source is
not wired, so we *cannot* prove it ran — is a *kill/fix/extend* candidate, NEVER a
*promote* candidate. Default windows (config-tunable): `lowRisk: 3d`,
`standard: 7d`, `highRisk: 7d`.

## 4. Design (as built — Slice 1)

### 4.1 `GrowthMilestoneAnalyst` (`src/monitoring/`)
A pure observer that composes the existing read surfaces. **Adds NO new sensors.**
It keeps ONE piece of minimal internal bookkeeping — a **stage-observation
journal** (`stateDir/state/growth-milestone-analyst/stage-journal.json`) — because
the rollout engines do not cleanly stamp "entered stage X at time T" for every
stage (notably `dark`). The journal records the first time the analyst observed a
feature in its current stage, so "days in stage" is robust and a stage change
(forward promotion OR backward regression) resets the clock.

Inputs (all existing):
- Initiatives + feature rollout: `InitiativeTracker.list()` (each feature's
  `rollout.stage`) and `InitiativeTracker.digest()` (staleness / needs-user).
- Spec approvals: `ApprovalLedger.summarize()` — approvedAsIs vs approvedWithChange
  + dominant divergence category.
- Corrections: `CorrectionLedger.list()` — open recurring corrections (scrubbed
  text only; the internal `learning` field is never read).
- Proof-of-life: an injectable `evidenceCounter(init) → number | undefined`.
  `undefined` ⇒ no evidence source wired ⇒ `proved:'unknown'` ⇒ cannot be
  promotion-ready (honest). Unwired in Slice 1 (so every expiry is R2-unknown
  until an evidence source is plumbed per feature category).

### 4.2 Notify-rules (the explicit "clear rules" the operator asked for)
- **R1 Promotion-ready**: feature past its window, proved → "promote?" (normal).
- **R2 Incubation-expired-unproven**: past window, not proved (or unknown) →
  "extend / fix / kill?" (normal).
- **R3 Initiative-stalling**: reuses `tracker.digest()` — a `stale` or `needs-user`
  initiative → "waiting on you / drifting" (normal).
- **R4 Spec-pattern**: a decision class mostly `approvedWithChange` in one dominant
  divergence dimension → "you keep changing X the same way — bake into the
  default?" (low).
- **R5 Correction-pattern**: an open recurring correction at/over the occurrence
  threshold → routed per the existing CORRECTION-PREFERENCE spec (low). The
  analyst only SURFACES it; the correction loop owns the routing lifecycle.

### 4.3 Read API (Slice 1 — compute + expose, NO sending)
- `GET /growth/digest` → the full digest (calm or has-findings).
- `GET /growth/findings` → `{ findings: [...] }`.
- `GET /growth/status` → `{ enabled, settings, counts, nextWindowClosesInDays }`.
- `POST /growth/tick` → runs the observe + compute pass (updates the journal),
  returns the digest. **Never sends to Telegram in this slice.**

All routes 503 when `monitoring.growthAnalyst.enabled` is false (the dark default).

### 4.4 The calm digest (fixes "near-silent → never speaks")
Even when nothing crosses a rule, the digest renders a short "all healthy — N
incubating, next window closes in Xd" line so the operator *knows the analyst ran*.
This is the deliberate reversal of the over-silence default — bounded to ONE
digest object.

## 5. Cadence + delivery (LATER SLICE — flood-sensitive, its own review)
- **Weekly digest** (`digestCron`, default Mon 11:00): ONE consolidated message;
  supersedes/absorbs `initiative-digest-review` to avoid two voices.
- **Event triggers**: only R1/R2 window-expiry milestones fire ad-hoc, COALESCED,
  into the existing system/updates surface — never one-topic-per-feature.
- **Anti-flood guarantees (non-negotiable — we are reversing an over-silence, must
  not overshoot)**: digest = ONE message/period; event milestones AGGREGATE (one
  summary carrying the list+count); all ad-hoc notifications route through the
  existing budget-guarded attention/post-update surfaces; the burst-invariant CI
  test must cover the aggregation. The analyst's `buildDigest()` already aggregates
  a burst of N expiries into ONE digest + counts (unit-tested at N=500).

## 6. Config (`.instar/config.json` → `monitoring.growthAnalyst`)
```json
{ "enabled": false,
  "digestCron": "0 11 * * 1",
  "incubationWindows": { "lowRisk": 3, "standard": 7, "highRisk": 7 },
  "proofOfLifeMinActivations": 1,
  "rules": { "promotionReady": true, "incubationExpired": true, "initiativeStalling": true, "specPattern": true, "correctionPattern": true },
  "specPatternMinTotal": 3,
  "specPatternMinChangeRatio": 0.6,
  "correctionPatternMinOccurrences": 3,
  "digestEvenWhenCalm": true }
```
Ships dark. Defaults auto-apply to existing agents via `ConfigDefaults` +
`applyDefaults` deep-merge (no separate `migrateConfig` block needed).

Phase B / "week one" (later slice): flip `correctionLearning.enabled` and reconcile
the `failureLearning` job/flag mismatch so the muted analyzers actually speak —
carefully, respecting the Bounded Notification Surface.

## 7. Rollout (Graduated Feature Rollout track)
`dark` → `dry-run` (compute digest, write to a log/dashboard, DON'T send) → `live`
(send to operator) → default-on after it proves itself. Rollout flag-path:
`monitoring.growthAnalyst`. Dogfood on echo first (canary), then fleet. The feature
honors the very maturity path it reports on.

## 8. Test plan (3-tier, as built)
- **Unit** (`tests/unit/GrowthMilestoneAnalyst.test.ts`, 32 tests): window math +
  proof-of-life gate on BOTH sides of every boundary (proved / unproved / unknown,
  in-window / at-boundary / expired, each risk tier); each notify-rule fires iff
  its condition; calm vs has-findings rendering; stage-journal reset + prune; the
  aggregation invariant (500 expiries → one digest).
- **Integration** (`tests/integration/growth-analyst-routes.test.ts`): every route
  200-when-wired / 503-when-dark over the real HTTP pipeline.
- **Wiring-integrity** (`tests/integration/growth-analyst-wiring.test.ts`): the
  analyst delegates to a REAL `InitiativeTracker` (rollout feature → finding; real
  stale initiative → R3) — deps are real, not no-ops.
- **E2E** (`tests/e2e/growth-analyst-lifecycle.test.ts`): "feature is alive" — a
  booted server returns 200 + a real digest; a seeded past-window proved feature
  produces an R1 milestone end-to-end; dark default 503s.

## 9. Migration parity
- Config defaults: `ConfigDefaults` (auto-applies via `applyDefaults` deep-merge). ✅
- CLAUDE.md template (`generateClaudeMd`): documents the `/growth/*` routes + dark
  status (Agent Awareness Standard). ✅
- Later slice: `migrateClaudeMd` content-sniff + the scheduled digest job, added
  when the feature goes live (a dark, route-only feature needs no live agent
  awareness migration).

## 10. Open questions for later slices
- Per-feature proof-of-life signal: the activation-count source differs by category
  (sentinel log-filter vs gate endpoint vs job run) — needs a small uniform "did
  this fire?" read wired into `evidenceCounter`.
- Risk-tier classification: currently heuristic off `rollout.promotionCriteria`;
  consider an explicit per-feature tag.
- Absorb `initiative-digest-review` into the analyst vs supersede/disable it (lean:
  supersede, to avoid two voices).
