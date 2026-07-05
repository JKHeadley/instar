---
kind: "spec"
id: "enable-path-integrity-standard"
title: "Enable-Path Integrity — extend the shipped enable-layer so a bare route flag can't rot, and fix the nested-PATCH root cause (RC7 of the self-inflicted-loops program)"
summary: "A dark feature guards nothing if its ON switch doesn't connect. The action-claim sentinel cannot be enabled: it reads messaging.actionClaim.enabled, but messaging is an adapters ARRAY, so the value is unreachable. Round-1 convergence REFUTED the first draft's greenfield framing: the enable-layer already ships (FeatureRegistry + FeatureDefinitions + the feature-enableaction-validity ratchet, from the approved enable-layer-coherence spec) and monitoring is ALREADY in PATCHABLE_CONFIG_KEYS. This spec is now a FOCUSED EXTENSION: (1) fix the TRUE root cause — the one-level-deep PATCH merge (routes.ts) clobbers sibling keys and can't write an array-shaped nested value — by reusing the existing deepMerge; (2) extend enable-path coverage to bare `liveConfig.get('...enabled')` ROUTE reads (like action-claim) that the catalog-scoped ratchet never sees; (3) model reachability as an executable patch/apply/read round-trip, not a static shape check; (4) repoint action-claim's whole subtree + register it."
status: draft
author: Echo (self-inflicted-loops root-cause program, standards-enforcement mission)
date: 2026-07-03
risk-class: "additive + one genuine bug fix. The nested-merge fix changes PATCH /config semantics (nested writes stop clobbering siblings) — behavior-changing but strictly toward correctness, covered by a regression test. Everything else (coverage extension, executable reachability test, action-claim repoint) is additive or dark-by-default."
parent-principle: "Structure > Willpower (config layer) + 'A Dark Feature Guards Nothing' (G3). Plus P14 root-vs-symptom: the registry-shape rule in the first draft treated the symptom; the nested-merge bug is the root."
lessons-engaged:
  - "Dark-feature-rot (action-claim, 2026-07-03, CMT-768): the deepest rot — the ON switch doesn't connect, so the word≠action loop it guards stays open."
  - "FOUNDATION AUDIT (lessons-aware round 1): the one-level-deep PATCH merge (routes.ts:21654 `fileConfig[key] = {...fileConfig[key], ...value}`) is the deeper defect. A correct recursive deepMerge already exists (ConfigDefaults.ts:1799) and LiveConfig.setNestedValue (LiveConfig:235) — the PATCH route is the ONE place using the shallow merge. Building 'keep flags shallow to dodge the merge' as guidance = Distrust-Temporary-Success. FIX the merge."
  - "Do-not-duplicate (lessons-aware + adversarial round 1): enable-layer-coherence.md (approved by Justin 2026-05-25) already shipped FeatureRegistry + FeatureDefinitions + tests/unit/feature-enableaction-validity.test.ts (the exact 'enableAction targets a patchable surface' ratchet, born from the identical dispatches/feedback bug). EXTEND it; do not build a parallel FeatureFlagRegistry."
  - "Self-consistency ≠ liveness (adversarial + codex round 1): a hand-written wiredProbe colocated with the registry proves internal self-consistency, not that the ON switch works. Reuse the real-construction wiring-test pattern (tests/.../devGatedFeatures-wiring.test.ts): apply real ConfigDefaults, construct the real feature, observe a behavioral delta."
  - "Dev-gate third state (lessons-aware round 1): many monitoring.* flags intentionally OMIT `enabled` so resolveDevAgentGate decides (ConfigDefaults.ts:70-113). A binary enabled/absent model mass-false-positives on exactly the G3-blessed dev-gated flags. Model 'dev-gate' as a first-class enableMechanism."
  - "P20 Fail-direction: the ratchet fails the BUILD (loud, pre-merge) on an unreachable flag; the doctor probe fails toward REPORTING; the nested-merge fix fails toward preserving sibling keys."
  - "Grep foundation before asserting (self-lesson 2026-07-03): every existing-behavior claim in this spec was grep-verified against real code before writing — the first draft's unverified 'add monitoring to PATCHABLE_CONFIG_KEYS' was wrong (it is already there)."
program: "self-inflicted-loops → enforced standards (RC1-RC8). RC4 flood fix shipped (PR #1365). This is RC7."
single-run-completable: true
frontloaded-decisions: 6
cheap-to-change-tags: 4
contested-then-cleared: 2
---

# Enable-Path Integrity Standard (RC7)

**Status:** DRAFT (pre-convergence — round 1 complete, this is the round-1 rewrite; needs a clean convergence round before /instar-dev)
**Owner:** Echo · **Created:** 2026-07-03
**Program:** Self-Inflicted Loops → Enforced Standards. This is **RC7**. RC4 (reaper flood) shipped as PR #1365.

## 1. Problem statement

A feature can ship correct, tested, review-passed, yet be **impossible to turn on**. The crystallizing case: the **action-claim follow-through sentinel** — the backstop for the exact "I'll do X" → stall loop the Stop-gate catches — reads `messaging.actionClaim.enabled`. `messaging` is an adapters **ARRAY**, so that value has no reachable path; `PATCH /config` can't write it and no operator/agent can flip it (CMT-768).

Round-1 convergence established two things the first draft got wrong:
- **Most of the enable-layer already exists.** `enable-layer-coherence.md` (approved 2026-05-25) shipped `FeatureRegistry`/`FeatureDefinitions` and `feature-enableaction-validity.test.ts` — a build-time ratchet asserting every catalog feature's enableAction targets a patchable surface, *"so this whole class can't recur."* And `monitoring` is **already** in `PATCHABLE_CONFIG_KEYS`.
- **The true root cause is deeper than shape.** The `PATCH /config` merge is one-level-deep (`routes.ts:21654` `fileConfig[key] = {...fileConfig[key], ...value}`). It (a) can't write a value under an array-shaped parent, and (b) **clobbers sibling keys** on any nested write (a PATCH of `{monitoring:{actionClaim:{perTopicCap:9}}}` erases a sibling `enabled`). A correct recursive `deepMerge` already exists (`ConfigDefaults.ts:1799`); the PATCH route is the lone caller of the shallow one.

So the real RC7 gap is narrow: the existing ratchet only covers **catalog** features (`FeatureDefinitions`). action-claim is a **bare `liveConfig.get('...enabled')` route read** — invisible to that ratchet. And the merge bug is a latent landmine for every future nested flag.

## 2. The standard (constitutional)

> **Enable-Path Integrity.** Every feature flag that gates a shippable capability MUST resolve to an enable mechanism that (a) is *reachable* — the configured PATCH/edit mechanism can actually mutate the value the runtime reads — and (b) provably *flips a wired behavior*. Reachability is proven by an executable patch→apply→read round-trip, never a static shape guess. A flag whose ON switch does not connect is a defect. Enforced by a CI ratchet; regression fails the build.

The config-layer arm of **"A Dark Feature Guards Nothing."** Shipping dark is legitimate; shipping *unable-to-un-dark* is not.

## 3. Design

### 3.1 Fix the root cause — nested PATCH merge (the load-bearing change)
Replace the shallow merge at `routes.ts:21654` with the existing recursive `deepMerge` (`ConfigDefaults.ts:1799`) so a nested PATCH preserves siblings and can write arbitrarily-deep object paths. Regression test: PATCH `{monitoring:{actionClaim:{perTopicCap:9}}}` against an existing `monitoring.actionClaim.enabled:true` and assert `enabled` survives. This is the fix the first draft designed *around*; it is now the centerpiece.

### 3.2 Extend the enable-layer (do NOT build a parallel registry)
Add two optional fields to the existing `FeatureDefinition` (`FeatureRegistry.ts`): `enableMechanism: 'patch' | 'static-restart' | 'dev-gate'` and a real-construction wiring assertion. Register action-claim (and other bare-route flags) as first-class entries. Extend the existing `feature-enableaction-validity.test.ts` rather than adding a second test/registry.

### 3.3 Reachability as an executable round-trip (replaces the static wiredProbe)
For each registered flag the ratchet, per `enableMechanism`:
- **`patch`:** run the REAL `PATCH /config` merge codepath on a synthetic config, re-read via the REAL accessor, assert the value changed. (This catches array-parent + deep-nest + merge-clobber failures that a shape check misses — the codex + adversarial finding.)
- **`static-restart`:** simulate a cold construction with the flag set and assert a behavioral delta. A doc marker exempts it from the patch-reachability check ONLY — never from the wired-behavior check. (Resolves Open-Q #3.)
- **`dev-gate`:** the flag is intentionally OMITTED so `resolveDevAgentGate` decides; assert the gate resolves live-on-dev / dark-on-fleet. Models the dominant real pattern instead of false-positiving on it.

Liveness reuses the shipped `devGatedFeatures-wiring.test.ts` pattern (apply real `ConfigDefaults`, construct the real feature, observe behavior) — NOT a lambda colocated with the registry (which proves only self-consistency).

### 3.4 Coverage for bare-route flags + the orphan gate
A lint scopes to **config accessors** — `liveConfig.get()/config.get()` call sites with a string-literal path argument ending in `.enabled` (the real count is ~1241 raw `.enabled` reads, most NOT config flags; the accessor-scoped set is far smaller). Each such site must be registry-covered or carry `// enable-path-exempt: <reason>` where `<reason>` is drawn from a **closed enum** (`not-a-feature-flag`, `hardcoded-const`, `test-only`, `dynamically-constructed-path`) — free text is rejected, killing the eslint-disable dodge. The exempt COUNT is itself a ratchet (may only decrease). (Resolves Open-Q #1 + the adversarial exempt-budget finding.)

### 3.5 Runtime doctor probe (signal-only, via existing GuardPosture)
`instar doctor` enumerates the registry and reports any flag whose reachability probe fails on THIS install's config shape; register the unreachable-flag condition through the EXISTING `GuardPosture`/`guardStatus()` inventory rather than a new reporting path. Emits only `{configPath, reachable, wired}` — never sibling config values (security round-1 finding). Non-zero doctor status on an unreachable flag; never blocks runtime.

### 3.6 The action-claim repoint (closes CMT-768)
Repoint the WHOLE subtree — `enabled`, `perTopicCap`, `expiresHours` (all three read from `messaging.actionClaim.*`, routes.ts:22314/22339/22350) — to `monitoring.actionClaim.*`. `monitoring` is already patchable; register action-claim as a `dev-gate` feature (omit `enabled` so the dev-gate decides). `migrateConfig()` is add-if-missing/idempotent (never clobbers an operator value; the old array-shaped key was never reachable so carry-forward is a no-op — it only seeds the object-shaped default) and one-time-clears the dead `messaging.actionClaim.*` residue. Update `templates.ts` + `CapabilityIndex.ts` strings to the new path (Agent Awareness Standard).

## 4. Multi-machine posture
- **The FeatureRegistry** ships in the repo — identical on every machine by build (replicated-by-artifact; no runtime state to unify).
- **The doctor-probe result** is `machine-local-by-design`, `machine-local-justification: hardware-bound-resource` — it deliberately reports THIS install's actual config shape, and a per-machine config divergence is exactly what it must surface; unifying it would defeat its purpose.
- **The action-claim repoint** rides the standard update path + `migrateConfig()` → Mini and Laptop both receive it (Migration Parity).

## 5. Config & rollback
- Feature stays dark-by-default (dev-gate). Rollback of the repoint = revert the commit; rollback of an enable = `PATCH monitoring.actionClaim.enabled:false` (reachable post-fix).
- The nested-merge fix has no knob — it is a correctness fix; its rollback is the revert, guarded by the regression test.

## 6. Frontloaded decisions (were Open Questions — now resolved)
1. **Orphan-lint strictness** → warn-then-ratchet with a frozen checked-in baseline of current accessor sites; HARD-FAIL only on new/newly-uncovered reads; baseline may only shrink. *(cheap: CI-internal.)*
2. **Registry hand-maintained vs decorator** → hand-maintained; the orphan-lint polices drift (a decorator couples to a class-shape many bare-route flags lack). *(cheap.)*
3. **static-restart verification** → require the wired-behavior assertion; doc marker exempts only the patch-reachability check. *(contested-then-cleared: a doc-only guarantee is the exact rot the standard bans.)*
4. **Reachability reference shape** → resolve array-vs-object against the static `ConfigDefaults`/type schema in the repo (deterministic in CI), NOT a live on-disk config. *(cheap.)*
5. **migrateConfig semantics** → add-if-missing, never clobber, one-time-clear the dead key. *(contested-then-cleared: touches durable operator config on two machines — NOT cheap; fully specified here.)*
6. **doctor exit contract** → distinct non-zero doctor status on an unreachable flag; does not block runtime. *(cheap unless wired into another gate — held to signal-only.)*

## 7. Test plan (all three tiers)
- **Unit:** the extended `feature-enableaction-validity` ratchet (patch/static-restart/dev-gate reachability round-trips); the deepMerge sibling-preservation regression; the accessor-scoped orphan-lint + closed-enum exempt.
- **Integration:** `PATCH monitoring.actionClaim.enabled:true` succeeds AND the running feature observes it (end-to-end proof the fixed path is live); a nested PATCH preserves siblings.
- **E2E:** boot with the flag on → the action-claim sentinel is alive (not 503) → a stated-continuation turn opens exactly one follow-through commitment.

## 8. Non-goals
- Not auto-enabling anything. Not forcing every flag runtime-patchable (`static-restart`/`dev-gate` are legitimate). Not covering RC1/RC2/RC3/RC5/RC6/RC8 (own specs; RC4 shipped).
