# Convergence report — Feature Activation Coherence

**Date:** 2026-05-25 · **Author:** echo · **Round:** iter-1 (internal, one focused independent reviewer) · **Spec:** `docs/specs/feature-activation-coherence.md`

## Method

One independent critical reviewer over the already-grounded draft (the dispositions came from a prior 3-agent code re-assessment, so this pass targeted design coherence / standards / implementability rather than re-verifying facts). All load-bearing claims re-checked against source at v1.2.72. **External cross-model round still recommended before ratification** (per `feedback_external_crossmodel_catches_what_internal_misses`).

## Verdict

Core thesis sound and well-grounded. Two blocking findings (one a factual correction of the author's own evidence) and a recommended split. Not ratified.

## Findings → resolutions

| # | Sev | Finding | Resolution |
|---|---|---|---|
| B1 | Blocking | `response-review` listed as "Class A — flag with no plumbing (Stop-hook never registered)" is **factually wrong**. It IS registered for new agents (`init.ts:4668`, `installCodexHooks.ts:96`, always-overwritten by `PostUpdateMigrator:1726`), gated on `responseReview.enabled` (off by default = correct opt-in). PR1's enableAction-validity test would find its enableAction *valid* (`responseReview` is allowlisted + read), contradicting the spec's "tests go red for response-review." | Corrected in spec (convergence note + evidence line). Verified independently: new agents get it in `Stop[]`; **Echo (existing) shows 0 references → real issue is a migration-parity gap** (existing agents never got it added to `Stop[]`) + off-by-default. Re-justify the MERGE on **redundancy** (CoherenceGate duplicates the always-on `MessagingToneGate`), acknowledging it's a behavior change to a *working* opt-in gate, not removal of dead code. |
| B2 | Blocking | Part 1.1 "single derived state / runtime probe" under-specified — the `/features` route has no handle to the 13 subsystem instances; each probes differently. Unimplementable as written. | Spec note added: introduce `featureRuntimeProbe: Record<featureId, () => boolean>` built in `server.ts` (instances in scope), passed into `RouteContext`; per-feature probe table required. Part 1.5 catalog-truth test reuses this probe (assert new `FeatureDefinition.defaultState` vs probe under empty config) instead of static idiom-inference. |
| M3 | Major | Part 1.5 catalog-truth test via static idiom classification (`new X()` vs `!== false` vs `if(config.x.enabled)`) is brittle — construction sites don't uniformly reference the configPath; regex mis-classifies, full AST is unbudgeted. | Replace with the runtime-probe-under-default-config approach (B2). Keep the genuinely-static, robust checks (configPath resolves to a real `InstarConfig` field; enableAction key allowlisted). Drop idiom inference. |
| M4 | Major | Migration parity for retiring `evolution.enabled` / `evolution.autoImplement` asserted, not designed. `migrateConfig` is additive only. Risks: an agent with `evolution.enabled:false` now silently runs the always-on manager against their stated preference; mapping `autoImplement:true`→`autonomous` would **retroactively grant autonomy** (the key is inert today). | Spec note added: retired keys left on disk untouched; **`autoImplement` NOT mapped** to `evolutionApprovalMode`; catalog ships in-package (reaches existing agents automatically); add a one-time notice if an agent had explicitly set a now-retired flag. |
| M5 | Major (recommended) | Scope too large: a mechanism rebuild + 7 dispositions + 2 safety findings of differing maturity in one spec. The shipped MessageSentinel item is even labeled "highest priority" (contradiction). | **Split** into (1) enable-layer coherence (Part 1 + always-on-three catalog fixes + telemetry deadlock — low-risk, declarative/additive) and (2) a behavior-disposition spec (autonomous-evolution execution retirement + response-review merge — the only surface-reducing changes; need own side-effects + cross-model). Reduce MessageSentinel to a one-line "shipped, see emergency-stop-forward-path-wiring.md." Flagged in convergence note; Justin to confirm the split. |
| m6 | Minor | Part 1.4 hot-reload ignores existing `src/config/LiveConfig.ts` (EventEmitter + watchPaths, already in `ctx.liveConfig`). | Reference `LiveConfig` as the `config-changed` mechanism — de-risks the fallback, may make true hot-reload cheap. Noted in convergence note. |
| m7 | Minor | PR1 "red-first tests across PRs" violates the non-negotiable green-main standard (Husky pre-push + CI branch protection). | Use `.skip`/`it.todo` with the marker (green push, documented gap), un-skipped in each disposition PR — or fold each truth-test into the PR that makes it pass. Noted. |
| m8 | Minor | Agent-Awareness gap correctly flagged for input-guard (verified absent from `templates.ts`) but missed for publishing/response-review changes. | Add Agent-Awareness checklist line to PR3 and PR6. Noted. |
| m9 | Minor | `dispatches` allowlist fix could move the lie from "API rejects" to "API accepts but still dark" if no downstream puller. | Verified the puller exists: `config.dispatches` → constructs `AutoDispatcher` (`server.ts:4778`). So enabling it for downstream agents genuinely wires the puller; for Echo, `config.dispatches` is absent (correct off-state). Lower concern than flagged; note the puller is gated on `config.dispatches` existing. |

## Sound — do not touch

Core thesis (all re-verified: dispatches enableAction non-allowlisted → 400; telemetry boot-gated deadlock; EvolutionManager unconditional; `autoImplement` read by nobody; `processProposalAutonomously` zero callers; publishing/input-guard `!== false` default-on; input-guard absent from template). The enableAction-validity test (strongest, robust). Always-construct/gate-effects for telemetry. Evolution-system retire-the-flag. Autonomous-evolution execution retirement (risk-reducing — path is dead). Signal-vs-authority framing.

## Status

Findings incorporated as a convergence note + evidence correction + `review-convergence` frontmatter tag. **Remaining before implementation:** resolve B2 (probe map design — fold into the spec body or the split's spec-1), apply the M5 split, then ratification (`approved: true` is Justin's act) + recommended external cross-model round.
