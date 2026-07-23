---
title: "Feature Activation Coherence — make the feature catalog tell the runtime truth, fix the enable layer, and disposition each dark/lying feature"
slug: feature-activation-coherence
status: draft
approved: false
date: 2026-05-24
author: echo
review-convergence: "internal-independent-review-2026-05-25 — one focused critical reviewer over the grounded draft; findings in reports/feature-activation-coherence-convergence.md. NOT YET RATIFIED (approved:false); blocking findings B1/B2 + recommended split (M5) must be resolved before implementation. External cross-model round still recommended."
related:
  - docs/specs/built-but-dark-liveness-reconciler.md
  - docs/specs/context-death-stop-gate-rollout-completion.md
eli16-overview: feature-activation-coherence.eli16.md
---

# Feature Activation Coherence

> **CONVERGENCE NOTE (2026-05-25, iter-1).** An independent critical review found the core thesis sound but flagged must-fix items before implementation (full report: `reports/feature-activation-coherence-convergence.md`):
> - **B1 (factual correction):** `response-review` is NOT "dead/unregistered plumbing." It IS registered as a Stop hook for **new** agents (`init.ts:4668`, codex hooks, always-overwritten by the migrator), gated on `responseReview.enabled` (off by default — correct opt-in). Echo (an **existing** agent) shows zero references → the real issue is a **migration-parity gap** (existing agents never got it added to `Stop[]`), plus off-by-default. So its disposition (MERGE → MessagingToneGate) must be re-justified on **redundancy** grounds (CoherenceGate duplicates the always-on tone gate), acknowledging it is a behavior change to a *working, opt-in* gate — not the removal of a dead path. (This corrects my earlier external-diagnosis error — same class as the MessageSentinel false-negative; verify liveness from the full code path, not the deployed artifact.)
> - **B2 (blocking):** Part 1.1's "runtime probe" is under-specified. Needs a concrete `featureRuntimeProbe: Record<featureId, () => boolean>` map built in `server.ts` (where the 13 subsystem instances are in scope) and passed into `RouteContext`, with a per-feature probe-expression table (e.g. publishing→`ctx.publisher!=null`, telemetry→`ctx.telemetryHeartbeat!=null`, inputGuard→set on sessionManager). Part 1.5's catalog-truth test should reuse this probe (assert a new `FeatureDefinition.defaultState` matches the probe under empty config) rather than brittle static idiom-inference.
> - **M4:** Migration: retired keys (`evolution.enabled`, `evolution.autoImplement`) are left on disk untouched; **`autoImplement` must NOT be mapped to `evolutionApprovalMode`** (it's inert today — mapping it would retroactively grant autonomy the user never had). Catalog ships in-package (reaches existing agents automatically).
> - **M5 (recommended split):** split into (1) **enable-layer coherence** (Part 1 + the always-on-three catalog fixes + telemetry deadlock — low-risk, declarative/additive) and (2) a **behavior-disposition** spec for the only two surface-reducing changes (autonomous-evolution execution retirement + response-review merge), which warrant their own side-effects + cross-model review.
> - **m7:** PR1's "red-first tests across PRs" violates the green-main standard — use `.skip`/`it.todo` (un-skipped in the disposition PR) or fold each truth-test into the PR that makes it pass.
> - **m6/m8:** use existing `LiveConfig` EventEmitter for hot-reload (Part 1.4); add Agent-Awareness template edits for publishing/response-review changes too, not just input-guard.
>
> **Sound (don't touch):** the core thesis, the enableAction-validity test (Part 1.2), always-construct/gate-effects for telemetry (Part 1.3), evolution-system retire-the-flag, autonomous-evolution execution retirement, and the signal-vs-authority framing.

## One-paragraph summary

A live dogfood attempt to "turn on every instar feature" (topic 12702, 2026-05-24) revealed that **the feature-activation layer is incoherent and the `FeatureDefinitions` catalog systematically lies about runtime reality.** Of 7 "off" opt-in features, none could be cleanly turned on, and on deeper inspection the off/on labels themselves were wrong: `input-guard`, `evolution-system`, and `publishing-telegraph` are actually **always-on at runtime** (wired via `SessionManager`/unconditional construction) while advertised as opt-in toggles; `autonomous-evolution`'s toggle writes a config key (`evolution.autoImplement`) that **no code reads** (the real gate is `AutonomyProfileManager.evolutionApprovalMode`); `baseline-telemetry`'s enable endpoint is a **chicken-and-egg deadlock**; and `dispatches` is **architecturally inverted** for a self-hosting maintainer and its enable action targets a non-allowlisted config key. This spec does three things: (1) fix the **enable layer** so a feature's declared state, its config, and its runtime behavior cannot drift apart; (2) apply a **per-feature disposition** (finish / improve / merge / retire) to each feature so the catalog stops advertising switches that do nothing; (3) hand the standing-detector role to the **Liveness Reconciler** (separate spec) so this never silently recurs. It is the one-time cleanup + the coherent mechanism; the reconciler is the watchdog.

## Problem

Justin's directive: dogfood every instar feature so we know it works coherently. Acting on it surfaced that you literally cannot — the activation machinery is broken in at least four ways, and worse, the catalog of "what's on/off" doesn't match what the code does. An agent (or user) reading `/features` is misled: it shows features as off that are running, and offers toggles that change nothing. That is the deepest form of the "built but dark" disease — not just dark features, but a **map that disagrees with the territory.**

## Evidence (all live-verified on main v1.2.62 / the running agent)

**Four enable-path failure classes (from the dogfood autopsy):**
- **A — flag with no plumbing:** `dispatches` (enableAction targets a non-allowlisted key; see D + inversion below). *(Correction per convergence B1: `response-review` was previously listed here in error — it IS registered for new agents and is correctly opt-in/off; its real issue is a migration-parity gap for existing agents + redundancy with the tone gate, not "no plumbing." See the convergence note above.)*
- **B — config ↔ registry desync + no hot-reload:** `PATCH /config {evolution|publishing}` sets the flag on disk but `FeatureRegistry.discoveryState` stays `undiscovered` until a restart re-runs `bootstrap()`; the running subsystem doesn't hot-reload.
- **C — chicken-and-egg:** `POST /telemetry/enable` 503s because `telemetryHeartbeat` is only constructed at boot `if (config.monitoring?.telemetry?.enabled)` (`server.ts:2642`) — it can't be enabled through its own endpoint.
- **D — enableAction targets a non-allowlisted key:** `dispatches`'s `enableAction` patches `dispatches`, absent from the `PATCH /config` allowlist (`routes.ts:11066-11070`) → 400.

**The catalog lies (deeper finding, code-grounded):**
- `input-guard` — constructed `if (config.inputGuard?.enabled !== false)` (default-ON, `server.ts:2570`), wired via `sessionManager.setInputGuard()`, and **actually runs** on `SessionManager.injectMessage()` (3 layers). Advertised in `FeatureDefinitions` as opt-in `network`-consent (off). **Live but labeled off.**
- `evolution-system` — `EvolutionManager` constructed **unconditionally** ("always enabled — the feedback loop infrastructure", `server.ts:5003`); `evolution.enabled` is read by no runtime gate — it only flips a discovery-DB row. **Always-on; the toggle is a fiction.**
- `publishing-telegraph` — `TelegraphService` auto-on (`server.ts:4916`, opt-out), zero-config (auto-creates a Telegraph account). **On by default; the 503 path is vestigial.**
- `autonomous-evolution` — `evolution.autoImplement` is read by **no code**; the runtime authority is `AutonomyProfileManager.evolutionApprovalMode` (from `evolution.approvalMode` / autonomy profile). Three config keys for one concept, two of them dead. And `processProposalAutonomously()` (`EvolutionManager.ts:807`) has **zero callers** — the auto-implement pipeline never runs.

**Two bonus dark systems (adjacent, found during re-assessment):**
- `UnjustifiedStopGate` — `StopGateDb` is **never constructed** in `server.ts` (optional null-default param); no Stop-hook calls `/internal/stop-gate/evaluate`. Darker than first thought (handled by the stop-gate rollout-completion spec).
- `MessageSentinel` — constructed + `/sentinel/classify` route, but **no live inbound-ingress call site** found (only the test route). The emergency-stop / "kill all sessions" classifier may not be wired to actual inbound messages — **safety-relevant; needs its own verification.**

## Root cause

Two sources of truth for "is this feature on" — `config.json` and the `FeatureRegistry` discovery DB — and a third de-facto truth: **what the code actually constructs and invokes.** Nothing keeps them in sync. Features are wired in three different idioms (unconditional construction; `!== false` default-on; `if (config.x.enabled)` opt-in), and the `FeatureDefinitions` catalog was written as if all were uniform opt-in toggles. So the catalog drifts from reality, enable actions target keys that nobody reads or that the API rejects, and "off" is meaningless without checking the code.

## Non-goals

- Not re-deciding the Liveness Reconciler design (separate, converged spec). This spec is the one-time cleanup + the coherent enable mechanism; the reconciler is the ongoing detector.
- Not building auto-remediation. Dispositions are applied by humans/PRs, surfaced by the reconciler.
- Not turning on features that are correctly off for *this* agent (e.g. `dispatches` for the maintainer). Coherence ≠ everything-on; it means the label matches reality and the choice is recorded.

## Design constraints

1. **One truth, derived not duplicated.** A feature's reported state must be derived from (or reconciled against) what the code actually does, not a free-floating flag.
2. **An enable action must actually enable.** If `enableAction` can't make the feature work (wrong key, deadlock, no plumbing), it's a bug, gated by a test.
3. **The catalog must not lie.** A feature advertised as opt-in must actually be gated by its config; a default-on feature must say so. Enforced by a test that cross-checks `FeatureDefinitions` against runtime wiring.
4. **Self-hoster awareness.** A feature can be correctly-off-by-design for the maintainer's own agent; the catalog must express that, not flag it as a gap.

## Design

### Part 1 — Fix the enable layer (the mechanism)

1. **Single derived state.** `/features` reports each feature's `enabled` by reconciling config + the actual runtime probe (is the subsystem constructed/invoked?), not just the discovery-DB row. Where they disagree, the response carries `mismatch: {configSays, runtimeSays}` (and the reconciler flags it). This removes the silent config↔registry drift.
2. **EnableAction validity test.** A unit test asserts every `FeatureDefinition.enableAction`/`disableAction` (a) targets a key in the `PATCH /config` allowlist (or a real endpoint), and (b) targets a key that runtime code actually reads. This catches class A/D bugs (response-review, dispatches) at build time.
3. **Always-construct, gate-the-effects.** Subsystems that today gate *construction* on a config flag (telemetry, `server.ts:2642`) switch to the publishing pattern: construct unconditionally (cheap, pure), gate only the side-effecting `.start()`/submission on `enabled`. Kills the chicken-and-egg (class C). `POST /telemetry/enable` then works.
4. **Hot-reload or honest "restart needed".** Either the subsystem re-reads config on a `config-changed` signal, or the enable response truthfully reports `requiresRestart: true` AND the discovery state is updated immediately so config and registry agree (no class-B limbo). Minimum bar: config and registry never disagree silently.
5. **Catalog-truth test.** A test cross-checks each `FeatureDefinition` against its runtime wiring idiom: a feature constructed unconditionally or `!== false` must be marked default-on in the catalog; a feature gated `if (config.x.enabled)` must be marked opt-in. Fails CI on drift. (This is the build-time companion to the runtime Liveness Reconciler.)

### Part 2 — Per-feature dispositions

| Feature | Disposition | Action |
|---|---|---|
| **input-guard** | **FINISH (tiny)** | It's live + default-on and the *only* inbound cross-topic-injection defense (not redundant with MessageSentinel — different axis). Fix the `FeatureDefinition` to say default-on (not opt-in `network`), and add it to the CLAUDE.md template (Agent Awareness Standard — currently omitted). No core-logic change. |
| **publishing-telegraph** | **MERGE → always-on infra** | Auto-on, zero-config, functional. Retire the vestigial `enabled:false`/503 path and the misleading toggle; treat like `PrivateViewer` (no flag). Fix worktree-vs-agent-home CLAUDE.md Telegraph drift. |
| **evolution-system** | **RETIRE the flag (keep the system)** | `EvolutionManager` is always-on baseline infra; `evolution.enabled` gates nothing. Delete the toggle + its no-op `disableAction`; document as baseline. (Or, if a real off-switch is wanted, add an actual route/construction gate — but (a) is honest + lower-risk since everything depends on it.) |
| **autonomous-evolution** | **MERGE + RETIRE execution** | Collapse the 3-key triplication to the single runtime authority `AutonomyProfileManager.evolutionApprovalMode`; drop the unread `evolution.autoImplement`. RETIRE the auto-implement *execution* (`processProposalAutonomously` has no caller; the self-modification safety surface is large and collides with the instar-dev gate). Keep proposals human-approved via `PATCH /evolution/proposals/:id`. |
| **baseline-telemetry** | **FINISH (deadlock fix)** | Apply the always-construct/gate-effects fix (Part 1.3) so the enable endpoint works for the population. Keep **Echo's own flag off** — low self-value for the maintainer whose "population" is largely their own infra. |
| **dispatches** | **RETIRE for Echo + fix for others** | Architecturally inverted for the maintainer's own agent (Echo authors behavior; receiving Dawn dispatches collides with the instar-dev gate). Encode "maintainer agent leaves `dispatches` unset" as the intended state. Separately add `'dispatches'` to the `PATCH /config` allowlist so the catalog isn't lying to *downstream* agents who can legitimately use it. |
| **response-review** | **MERGE → MessagingToneGate** | CoherenceGate is a heavy opt-in re-implementation of outbound gating that the always-on `MessagingToneGate` (B1–B16, incl. B15_CONTEXT_DEATH_STOP) already performs inline on every send. Port the unique value (claim-provenance / url-validity fact-check, recipient-scoped leakage) into MessagingToneGate as signals; retire the blocking Stop-hook activation path (or keep CoherenceGate strictly `observeOnly`). Do NOT wire it as a second blocking gate. |

**Adjacent (own follow-ups, flagged not fixed here):**
- `UnjustifiedStopGate` / stop-gate → handled by `context-death-stop-gate-rollout-completion.md` (now known to also need `StopGateDb` construction).
- `MessageSentinel` inbound wiring → **✅ DONE — SHIPPED** in PR #377 (`b3a8cf8f6`, released v1.2.72, 2026-05-25) via dedicated spec `emergency-stop-forward-path-wiring.md`. Entry retained for the record. Original finding: **VERIFIED BROKEN for lifeline-owned agents (P0 safety).** The sentinel intercept lived ONLY in `TelegramAdapter.processUpdate()` (`TelegramAdapter.ts:3532`), the adapter's own poll loop. Echo runs **lifeline-owned polling** (`server.ts:1167` names "echo"): the lifeline polls and forwards via `POST /internal/telegram-forward`, which injects directly (`onTopicMessage`/`injectTelegramMessage`) with **zero** sentinel references (`routes.ts:8391–8700`); `src/lifeline/*` does no classification. So "stop everything" is NOT structurally honored for Echo — it's injected as a normal message. The classifier itself is fine (live-tested: "stop everything"/"stop" → emergency-stop). **Fix (P0):** hoist the `processUpdate` sentinel logic into `/internal/telegram-forward` (classify before inject; on emergency-stop kill session + clear autonomous job via existing `onSentinelKillSession`; on pause → pause) so it fires regardless of polling owner + a wiring-integrity test asserting the forward route classifies before injecting + an integration test that an emergency-stop through the forward route kills the session. This is the highest-priority item in this spec.

### Part 3 — Hand off to the Liveness Reconciler

Every issue above is exactly what the Liveness Reconciler (separate, converged spec) detects: config-on-but-runtime-off, runtime-on-but-catalog-off, enable-action-targets-dead-key, subsystem-null. This spec is the **one-time cleanup**; the reconciler is the **standing watchdog** that prevents recurrence. The catalog-truth test (Part 1.5) is the build-time companion.

## Rollout

- **PR1: enable-layer truth tests (red first).** Add the enableAction-validity test (1.2) and the catalog-truth test (1.5). They will FAIL against current code — that's the point; they document every lie. Mark known failures with tracked `// FEATURE-COHERENCE:` markers tied to the disposition PRs.
- **PR2: telemetry deadlock fix** (1.3) — always-construct, gate `.start()`. Green the telemetry portion of PR1's tests.
- **PR3: catalog truth for the always-on three** — input-guard, evolution-system, publishing: fix `FeatureDefinitions` to match reality (default-on / retire fictional toggles), add input-guard to CLAUDE.md template (Agent Awareness Standard). Green their PR1 assertions.
- **PR4: autonomous-evolution merge** — collapse to `evolutionApprovalMode`; drop `autoImplement`; retire the auto-implement execution path (or gate behind explicit, separately-approved enablement). Migration parity for any config key rename.
- **PR5: dispatches** — allowlist fix for downstream + encode maintainer-off posture for Echo.
- **PR6: response-review merge** — port the unique reviewers into MessagingToneGate; retire the blocking Stop-hook path. (Coordinated with the stop-gate rollout-completion so the two context-death surfaces don't both get wired.)
- **`/features` derived-state + mismatch reporting** (1.1, 1.4) lands with PR1/PR2.

Each PR: 3-tier tests + wiring-integrity, leaves `test:push` green, migration parity for any agent-installed change (config defaults, CLAUDE.md template, `FeatureDefinitions`).

## Rollback

Per-PR and independent. The truth tests are additive. The telemetry always-construct is a pure-construction change (no behavior until enabled). Catalog edits are declarative. The autonomous-evolution and response-review merges are the only behavior-affecting changes and each is independently revertable; both reduce surface (retire) rather than add.

## Signal-vs-authority compliance

This spec adds no new gate. It corrects existing ones and removes a redundant blocking gate (response-review's Stop-hook). MessagingToneGate remains the single outbound authority; InputGuard remains the single inbound-injection detector (warn, not block). No detector gains blocking authority.

## Side-effects review

- **Over-reach:** retiring toggles (evolution, publishing) could surprise a user who believes they can turn the system off. Mitigation: if a real off-switch is wanted, Part-2 notes the alternative (add a true gate) — but the honest default is "this is baseline infra," documented.
- **Self-modification safety:** retiring the auto-implement execution *reduces* risk (no silent self-edits); aligns with the instar-dev gate. The MERGE removes a confusing green light that does nothing today.
- **Telemetry egress:** the deadlock fix enables the population feature for users who opt in; Echo stays off. No new default egress.
- **dispatches:** leaving it off for Echo is the safe posture; the allowlist fix only affects downstream agents who explicitly enable it.
- **Catalog edits + migration parity:** `FeatureDefinitions` changes reach existing agents via the normal update path; the catalog-truth test prevents re-drift.

## Success criteria

- `/features` reports state that matches runtime reality for all 13 features (no `mismatch`).
- Every `enableAction` is valid (allowlisted key + read by runtime code) — enforced by test.
- The catalog-truth test passes (no feature advertised opt-in that's actually always-on, and vice-versa).
- `POST /telemetry/enable` works (no deadlock).
- No feature toggle is a no-op (every advertised switch changes real behavior or is removed).
- The Liveness Reconciler, run post-cleanup, reports zero `DARK/unexplained` and zero catalog mismatches.

## Open questions (for /spec-converge)

1. **Off-switch policy:** for always-on infra (evolution, publishing, input-guard), do we want real off-switches (add gates) or accept them as baseline (retire toggles)? Leaning baseline; Justin's call per feature.
2. **response-review fate:** fully retire CoherenceGate, or keep it `observeOnly` as a fact-checking telemetry sink? The unique reviewers (claim-provenance/url-validity) have value the tone gate lacks.
3. **MessageSentinel inbound wiring** — confirm whether the emergency-stop classifier is on the live ingress path; if not, that's a safety bug needing its own spec, prioritized.
4. External cross-model review before ratification (per the reconciler spec's open question).
