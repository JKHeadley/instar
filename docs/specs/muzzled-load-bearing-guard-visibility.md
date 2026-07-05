---
kind: "spec"
id: "muzzled-load-bearing-guard-visibility"
title: "Muzzled Load-Bearing Guard Visibility + Dev-Agent Coherence — a critical guard that is ON but silent (dry-run/observe-only) must be visibly flagged, and dev-agent status must be coherent across an agent's machines"
summary: "Incident (2026-07-04, topic 30823): the Mac Mini — the machine doing all the dev work and holding the serving lease — had `developmentAgent` UNSET while the Laptop had it SET. `developmentAgent` is the ROOT coherence-critical flag ('root of the F4 class' — every omitted dev-gated flag flips with it), so the Mini silently ran ~20 dev-gated features OFF, including the just-shipped veto-backoff reap-flood fix. The machine-coherence guard EXISTS to catch exactly this divergence and WAS live on the Laptop — but it ships in a second observe-only stage (dryRun:true) even on dev agents, where the code detects+logs the divergence but raises NO alert (verified: it speaks only when `enabled && !dryRun`, machineCoherenceEpisodeManager.js:85). Worse: the guard is NOT tagged `loadBearing`, so the existing G3 'dark-but-load-bearing' machinery never surfaced that a critical guard was sitting muzzled. Net: a guard that had almost certainly already detected the problem stayed silent, and nothing flagged that it was silenced. This is the observe-only-muzzle arm of 'A Dark Feature Guards Nothing' (sibling to enable-path-integrity RC7, which covers the can't-be-switched-on arm)."
status: draft
author: Echo (self-inflicted-loops / standards-enforcement program; operator directive topic 30823)
date: 2026-07-04
risk-class: "mostly additive. (A) Tagging critical guards loadBearing + promoting the machine-coherence guard out of dry-run is behavior-changing toward correctness (it will now RAISE on a real divergence) — bounded by the guard's own NEVER_AUTO_PROPOSE (developmentAgent never auto-flips; it surfaces to the operator) and the version-skew grace-gate (won't cry wolf on a rolling update). (B) Dev-agent coherence is a surfacing+one-tap-resolve change, explicitly NOT a silent auto-sync (auto-flipping a machine into a dev box is forbidden for good reason)."
parent-principle: "'A Dark Feature Guards Nothing' (G3) — observe-only-muzzle arm. Plus 'Single Coherent Agent' (the agent, not the machine, is the dev agent; a coherence-critical trait must not drift per-machine). Plus Structure > Willpower (surface the muzzle structurally; don't rely on someone remembering to graduate a guard)."
lessons-engaged:
  - "Verified-from-code, not assumed (2026-07-04): the muzzle is real — machineCoherenceEpisodeManager.js:85 gates every alert on `enabled && !dryRun`; in dry-run wouldRaise++ but itemsRaised stays 0 (no attention item). The advert is emitted UNCONDITIONALLY (server.js:17076, no dev-gate) so a non-dev machine DOES broadcast its value — the Laptop's live guard could see the divergence; only the dry-run muzzle kept it silent."
  - "developmentAgent is COHERENCE_CRITICAL + NEVER_AUTO_PROPOSE (machineCoherenceManifest.js:128, machineCoherenceEpisodeManager.js:39): the design already models dev-agent status as an agent-level trait that must agree across machines AND already refuses to auto-flip it (surfaces to operator instead). The gap is not the model — it's that the surfacing was muzzled (dry-run) and invisible (not loadBearing)."
  - "G3 already exists (CLAUDE.md 'Dark-but-Load-Bearing Guards'): a loadBearing guard in dry-run/dark is classified loadBearingGap (LOUD) / loadBearingSoaking (bounded window) / loadBearingAccepted (owned). The machine-coherence guard simply was never tagged loadBearing, so G3 could not see it. LEVERAGE G3; do not build a parallel surface."
  - "Sibling-not-duplicate of enable-path-integrity-standard.md (RC7): RC7 = 'the ON switch doesn't connect' (reachability). THIS = 'the ON switch connected but only to observe-only, and nothing flags the muzzle' (graduation-visibility). Both are 'A Dark Feature Guards Nothing'; keep them as two arms of one standard, not two overlapping specs."
  - "Do-not-over-reach (2026-07-04 operator correction): the first framing called per-machine dev-status 'by design' — WRONG; it defended the incoherence. The agent is one being across machines. This spec must NOT re-encode per-machine-ness as acceptable."
  - "4 OTHER loadBearing guards are currently in dry-run/off (testRunnerCap, preferredCaptainHandback, meshTransport recoveryProbe, staleOwnerRelease) — a muzzle audit must sweep ALL coherence/safety-critical guards, not just machine-coherence."
program: "self-inflicted-loops → enforced standards. Sibling to RC7 (enable-path-integrity). Provisionally RC9."
single-run-completable: false
---

# Muzzled Load-Bearing Guard Visibility + Dev-Agent Coherence

**Status:** DRAFT (pre-convergence — needs a spec-converge round before /instar-dev)
**Owner:** Echo · **Created:** 2026-07-04 · **Driver:** operator directive, topic 30823

## 1. Problem statement

Two coupled defects, both surfaced by one incident.

**1a. The observe-only muzzle (the systemic one).** A guard can be correctly enabled and STILL be structurally silent. The machine-coherence guard is dev-gated (live on a dev agent) but ships `dryRun: true` even there. In dry-run it runs the full comparison, detects a coherence-critical divergence, increments `wouldRaise`, writes a log line — and raises NO operator alert (`canSpeak = enabled && !dryRun && raiser===self`, machineCoherenceEpisodeManager.js:85). "Live on dev" bought only silent-watching. Nobody had performed the second, separate promotion (`dryRun:false`) that turns watching into warning.

**1b. The invisibility of the muzzle.** The G3 "dark-but-load-bearing" system is built to shout when a guard a critical path depends on is sitting dark/dry-run — UNLESS the guard is tagged `loadBearing`. The machine-coherence guard is not tagged, so G3 never classified it as a `loadBearingGap`. A muzzled critical guard was therefore invisible: not alerting, and nothing alerting that it wasn't alerting.

**1c. The trigger — dev-agent incoherence.** `developmentAgent` is THE root coherence-critical flag ("every omitted dev-gated flag flips with it"). The Mini had it unset while the Laptop had it set → the two halves of one agent disagreed on its most load-bearing trait, and the Mini silently ran ~20 dev-gated features (including a just-shipped reap-flood fix) OFF. The system already models this as an agent-level trait that must agree (it's in COHERENCE_CRITICAL_FLAGS + NEVER_AUTO_PROPOSE) — but 1a+1b meant the disagreement never surfaced.

## 2. The standard (constitutional — the muzzle arm of "A Dark Feature Guards Nothing")

> **A guard that watches but cannot warn is not guarding.** Any guard a critical path depends on MUST be tagged `loadBearing`, so that whenever it is dark OR in observe-only (dry-run) the existing G3 classification surfaces it (`loadBearingGap`, unless within a bounded `loadBearingSoaking` window or an owned `loadBearingAccepted`). A load-bearing guard may not sit in observe-only indefinitely with no visibility. Graduating a guard out of observe-only is a deliberate, surfaced act — never an omission nobody notices.

Sibling to **Enable-Path Integrity** (RC7): that arm guarantees the ON switch *connects*; this arm guarantees that "on" actually *warns*, and that a still-muzzled critical guard is *visible*.

## 3. Design

### 3.1 Tag the machine-coherence guard loadBearing (the visibility fix — small, high-leverage)
Add `loadBearing: true` + a `criticalPath` label to the machineCoherence entry in the guard registry (devGatedFeatures.js / guard classification source). Immediate effect: while it sits in dry-run, G3 classifies it `loadBearingSoaking` (if within a declared soak window) or `loadBearingGap` (LOUD) — so a muzzled coherence guard can never again be invisible.

### 3.2 Muzzle audit — sweep ALL coherence/safety-critical guards
`developmentAgent`-gated is not the same as `loadBearing`. Audit every guard on a critical path (coherence, session-lifecycle, delivery, safety-floor) and tag the genuinely load-bearing ones. Grounding note: 4 loadBearing guards are ALREADY in dry-run/off today (testRunnerCap, preferredCaptainHandback, meshTransport recoveryProbe, staleOwnerRelease) — the audit must produce a reviewed list of which critical guards are muzzled and why, not a blanket flip.

### 3.3 Graduate the machine-coherence guard out of dry-run (the warning fix)
Promote `dryRun:false` for the machine-coherence guard on dev agents, so a real coherence divergence RAISES to the operator (one HIGH, episode-scoped, deduped item — developmentAgent stays NEVER_AUTO_PROPOSE, so it surfaces, never auto-flips; version-skew stays grace-gated so a rolling update never cries wolf). **Open decision for convergence:** straight flip vs. a bounded declared soak first (loadBearingSoaking). Given the guard already has substantial tick history with zero false episodes, a short declared soak → flip is the likely answer, but this is a graduation decision, not an omission.

### 3.4 Dev-agent coherence (the trigger fix) — surface + one-tap resolve, NOT silent auto-sync
`developmentAgent` MUST agree across an agent's machines, but auto-propagating it is explicitly forbidden (NEVER_AUTO_PROPOSE — turning a machine into a dev box has real blast radius). So "coherent by construction" here means **coherent-by-surfacing-and-cheap-resolution**, not silent replication:
- Once 3.1+3.3 land, a dev-status divergence RAISES a HIGH operator item naming both machines and the ~N features that flip with it.
- Add a one-tap resolve: the item carries the operator action to set the lagging machine to match (PIN-gated, per-machine — respects NEVER_AUTO_PROPOSE by keeping a human in the loop, but makes resolution one tap instead of a hand-edit + restart on the remote box).
- **Open decision for convergence:** is a bounded auto-align of `developmentAgent` across an operator's OWN machines acceptable (with operator notification) as a stronger "single coherent agent" reading, or does the dev-box blast radius mean it must stay operator-confirmed-per-machine? The operator (topic 30823) leans strongly toward "one agent, coherent" — this is the central contested decision to resolve in convergence.

## 4. Multi-machine posture
- The guard registry + loadBearing tags ship in the repo → identical on every machine by build (replicated-by-artifact).
- The dev-status divergence surface is inherently cross-machine and is the whole point — it must compare across the agent's machines (already does).
- The graduation (dryRun:false) is itself per-machine config today → it must be applied to BOTH machines via the update path (Migration Parity), or it half-works (only a live-non-dry-run elected raiser speaks). This is itself an instance of the same per-machine-config drift → strengthens the 3.4 coherent-config direction.

## 5. Config & rollback
- loadBearing tags: no runtime knob (build-time registry); rollback = revert.
- Graduation: rollback = re-set `dryRun:true` (reachable) or `accept-fallback` an owned soak.
- Dev-agent one-tap resolve: additive; rollback = revert; the underlying set-and-restart path is unchanged.

## 6. Open decisions for convergence (front-loaded)
1. Straight dryRun flip vs. bounded declared soak for the coherence guard (3.3).
2. Dev-status: operator-confirmed-per-machine vs. bounded auto-align across own machines (3.4) — the central one.
3. Muzzle-audit scope: which guard families count as "critical path" for mandatory loadBearing tagging (3.2).
4. Does this merge INTO enable-path-integrity-standard.md as its second arm, or ship as a sibling standard cross-referencing it? (Lean: sibling standard, shared parent principle.)
