# Convergence Report — External-Hog Zombie Auto-Kill Sentinel

## Cross-model review: codex-cli:gpt-5.5 (RAN) — with a STANDING, OPERATOR-OWNED ARCHITECTURE DISSENT

A real GPT-tier external pass (codex, `gpt-5.5`) AND a Gemini-tier pass
(`gemini-2.5-pro`) ran on every round through the agent's own installed CLIs. The
external passes are REAL, not phantom.

**Read this before approving — the external verdict is not a clean "pass."** Across
the final rounds BOTH non-Claude models returned a **SERIOUS-ISSUES verdict**, and
across *five* rounds they independently and repeatedly made the SAME core argument:

> For this narrow v1, the deterministic safety floor is already a complete kill
> predicate, so the AI model can only ever *subtract* (spare something). Both models
> would rather ship the **simpler deterministic-only reaper** — deterministic auto-kill
> within the narrow allowlist, with the AI limited to alert-explanation — and avoid the
> non-determinism, cost, dependency, and the large arming/consent machinery the AI
> decider requires to be contained safely.

This is a genuine, well-argued design dissent from outside the Claude family — exactly
what the cross-model pass exists to surface. It was **NOT adopted**, for one reason:
it contradicts an **explicit operator directive** (Justin, 2026-07-03: "intelligence
makes the judgment call; rigid code doesn't"). Per the process, an operator-ratified,
frontloaded design decision is not a blocking finding — two internal reviewers
(decision-completeness, lessons-aware) independently confirmed the LLM-decider role is
frontloaded, operator-ratified, AND standards-mandated (P7 requires ≥Tier-1 LLM
supervision on a critical pipeline; P2 puts authority with the intelligent gate).

**The design does not just assert the AI earns its keep — it now proves it.** The
watch-only soak (§7) MEASURES the spare-rate (how often the AI spares an in-envelope
process the floor would have killed); the go-live criterion includes a spare-rate
THRESHOLD, and if that rate is ≈ 0, the honest, spec-mandated outcome is to drop the
AI and ship the simpler deterministic-only version the externals prefer. **The
architecture choice therefore remains the operator's, and it is falsifiable by data,
not by assertion.** If you (the operator) prefer the simpler design now, say so — it is
a clean, already-analyzed alternative, not a redesign from scratch.

The externals' other recurring point (make the native `proc_pidinfo` CPU source a v1
prerequisite instead of parsing `ps`) was independently assessed by the internal
scalability reviewer, who concurred the `ps time=` quantization is non-material for
kill-safety (a 2× margin at the kill-time micro-check; the parser is registered with
captured realness fixtures; the native addon remains a named follow-up).

---

## ELI10 Overview

Sometimes a program that has nothing to do with the agent goes haywire and eats the
machine's CPU. The real case: someone closed their code editor, but one of its
background helper processes didn't shut down — it kept running invisibly, burning ~2.2
CPU cores for almost a full day, starving the agent's own server. Today the agent only
watches its OWN processes for this; an outside hog is a blind spot.

This feature closes that blind spot in two halves. The **broad** half just NOTICES any
outside program that's genuinely burning a lot of CPU and surfaces it to you. The
**narrow** half AUTOMATICALLY cleans up exactly one kind of provably-dead leftover — an
orphaned editor extension-host helper (the thing that bit us) — and nothing else, to
start. We widen what it can auto-clean later, slowly, with evidence.

The decision of whether a leftover is safe dead-weight is made by an AI model (a
judgment call), but ending a program can't be undone, so a mechanical "safety floor"
sits underneath: it can only ever STOP a cleanup, never start one, and it refuses to
touch anything owned by the OS, another user, a running app, or anything whose identity
can't be re-confirmed at the instant of action. A cleanup fires only when the rules AND
the model both agree. It ships watch-only on this machine first (logs what it WOULD do,
touches nothing); turning on real cleanup needs your dashboard PIN — not a config flag,
and nothing the agent or a restart can flip on by itself.

## Original vs Converged

- **The decision-maker flipped, then got fenced.** The first draft made rigid rules the
  sole kill authority with the AI as a mere veto. Per operator review this was inverted
  (the AI decides), then re-hardened so the AI's authority is purely *subtractive* — it
  can spare within a set the rules proved safe, never widen it. A kill fires iff
  `deterministic_floor_pass && classifier_verdict === 'kill'`.
- **The foundation it meant to reuse was structurally blind.** Round 1 found the existing
  process reaper can't even SEE the target class (it pre-filters for AI-tool names). The
  sentinel now owns its own uid-scoped host-process discovery.
- **Arming became tamper-proof.** Early drafts let a config edit turn on real killing,
  making a PIN gate decorative. The converged design gates live-killing behind a
  PIN-written server-side marker with a monotonic arm-epoch vs last-disarm-epoch, so no
  config write, `PATCH`, strip-migration, or restart can re-arm without a fresh PIN — and
  the guard-posture row reflects *effective* kill-capability, not a config wish.
- **The measurement became sleep-proof and starvation-proof.** The CPU signal moved from
  a decaying average to a cross-tick cumulative-CPU-time delta on a MONOTONIC clock
  (so a laptop sleep/wake or an NTP step can't blind it), off the event loop, with a
  sampler-liveness heartbeat that self-heals and can't read fresh-but-blind.
- **The blast radius shrank and got honest.** A code-defined single-class allowlist; an
  own-uid floor; an ancestor-walk (start-time-aware, with an own-root fallback for the
  launchd-supervised topology) that excludes the agent's own busy build children; P17
  notification coalescing; a P19 respawn breaker; a durable, change-gated audit. And the
  scope is stated plainly: v1 is "auto-clean orphaned editor helpers + notice every
  other external hog," not a general killer.

## Iteration Summary

| Round | Reviewers who flagged | Material findings | Spec changes |
|-------|-----------------------|-------------------|--------------|
| 1 | all internal + codex | 16 | scanner-blindness, wrong CPU measure, loop brakes, code-defined allowlist, dev-machine-first |
| 2 | (fold) | — | folded 16 |
| 3 | operator + adversarial + security | 3 | flipped decision model to intelligence-decides per operator |
| 4–5 | adversarial + security | 3 | fixed 3 regressions the decision-flip introduced |
| 6 | 6 internal + codex | 9 | delta-based candidacy, cadence-decoupled sampler, ownerApp-specific-parent, own-pid exclusion at discovery |
| 7 | (fold) | — | folded round-6 material |
| 8 | 6 internal + codex + gemini | ~14 | arm-path exclusivity, arm-scope snapshot, P19 class-shield, event-loop-stall, same-uid, ancestor-walk, alert durability |
| 9 | 6 internal + codex + gemini | ~17 | armEpoch lifecycle, per-class content-hash, cadence contradiction, start-time-aware walk, monotonic clock, sampler heartbeat, parser realness, undeliverable-alert |
| 10 | 5/6 READY; integration 2 | 2 (+ polish) | own-root fallback, DEV_GATED_FEATURES registration + precedent citation |
| 11 (final confirm) | 6/6 READY | 0 material (wording nits only) | fd-skip gates SIGKILL, heartbeat plausible-parse, armed-pending mapping, honest framing |

## Full Findings Catalog (summary)

Every round's findings and resolutions are recorded in the commit history
(`git log docs/specs/external-hog-zombie-autokill-sentinel.md`), one commit per round
with a full finding→resolution breakdown. Highlights by reviewer lens across the run:

- **Security:** arm-path side-door (config could arm without PIN) → direction-asymmetric
  reads + PIN-written armed marker; silently-widening allowlist consent → per-class
  content-hash arm-scope; marker survived disarm across restart → arm-epoch vs
  last-disarm-epoch (verified AIRTIGHT in the final pass).
- **Adversarial:** P19 command-hash collision let one decoy shield a whole class → stable
  discriminator + honest class-breaker semantics; kill-time cadence contradiction →
  Stage-A admission gate vs Stage-B instantaneous re-checks; slot-starvation → worst-CPU-
  first with a deterministic tie-break; ancestor-walk rationale inverted → corrected to
  anti-evasion.
- **Scalability:** wall-clock blindness across sleep/NTP → monotonic Δwall + guard;
  sampler dead-blind → per-cycle heartbeat on a plausible read + self-heal; event-loop
  stall in the kill lane → worker-side; audit-log blowup → change-gated + retention.
- **Integration:** tmux-only ownership false under launchd → own-root fallback;
  strip-migration misdescription → DEV_GATED_FEATURES registration + negative-invariant
  test + marker-invalidation; guard-posture must read the marker.
- **Lessons-aware:** Sovereignty engaged by name (the targets are the operator's
  processes; the PIN arm is the structural "ask"); alert-delivery silent-death closed;
  the load-bearing `ps` parser registered with realness fixtures; over-engineering
  confirmed standards-mandated, not gratuitous.
- **Decision-completeness:** every mid-build decision frontloaded; zero open user-
  decisions; the LLM-decider role confirmed operator-ratified (not a parked question).

## Convergence verdict

**Converged after 11 review rounds** (10 substantive + 1 targeted final confirmation).
The final confirmation returned all six internal reviewers CONVERGENCE-READY with zero
material findings — only wording reconciliations, all folded. The conformance gate is
clean. The design is stable: no reviewer reopened it across the last two rounds.

The spec carries ONE standing, non-blocking dissent: both external (non-Claude) models
prefer a deterministic-only reaper over the AI-decider. This is the operator's ratified
architecture call, is made falsifiable by the soak spare-rate threshold, and is
surfaced here so the approval decision is fully informed. It is ready for operator
review and approval; the approval step (and the architecture-fork decision it implies)
belongs to the operator, not to this review.
