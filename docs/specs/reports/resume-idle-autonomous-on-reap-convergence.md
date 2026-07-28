# Convergence Report — Resume an idle autonomous run after an age-limit reap

## Cross-model review: codex-cli:gpt-5.5

A real GPT-tier external pass (codex CLI, gpt-5.5) AND a Gemini-tier pass
(gemini-cli, gemini-2.5-pro) ran on BOTH rounds. Both returned MINOR ISSUES
on both rounds; no material new issues in round 2. This is the clean RAN state.

## ELI10 Overview

The agent has a safety net — the "resume queue" — that quietly restarts a
session if it got shut down while doing real work. But it judged "real work" by
looking for something running at the exact moment of shutdown (a build, a queued
message, a sub-task). There's one shutdown that always looks idle: the
**age-limit recycle**. Sessions aren't allowed to run forever, so a long-running
autonomous job that's sitting idle between steps gets recycled — and at that
instant nothing is "running," so the queue saw no evidence and never brought it
back. If that happened while the operator was away, the job sat dead until the
next message woke it.

This change tells the queue: when a recycle hits a topic whose autonomous job is
**still genuinely live** (its run state file shows an un-elapsed window), treat
that live run as the proof of work and bring it back. It reuses ALL the existing
safety rails — one restart at a time, only when the machine is calm and has
spare quota, only on the machine that owns the topic, and a hard cap that gives
up loudly if a job keeps dying. No new restart path was built. The change also
turns the queue from "watch only" to actually-live on the dev agent (Echo), so
it gets exercised on a real two-machine setup, while the rest of the fleet stays
in watch-only mode until a deliberate later switch.

The main tradeoff: on the dev machine this now performs REAL restarts that spend
REAL quota — that's a deliberate, operator-approved choice, classified honestly
as a non-cheap (irreversible-once-done) decision rather than hidden behind a
"it's off everywhere else" label.

## Original vs Converged

Originally the spec described the fix and asserted the four safety invariants
were covered, with the live-on-dev decision tucked into "Residual risks" as
something "mitigated by" the existing gates — i.e. effectively treated as cheap.
After review:

- A **`## Frontloaded Decisions` table** was added (D1–D6), and the live-on-dev
  decision was **reclassified as NON-CHEAP, accepted under a named live phase**,
  with its irreversibility (quota already spent can't be un-spent) stated
  honestly. This was the one MATERIAL finding (decision-completeness reviewer).
- A **drain-time liveness re-check** was added: right before a restart, the
  drainer re-reads the run state; if the run finished in the meantime, it
  invalidates (`autonomous-run-finished`) instead of wasting a restart. This
  structurally closes the "completed-but-state-says-remaining, window already
  elapsed" subset of the stale-marker residual — a consensus point raised by the
  adversarial, lessons-aware, codex, AND gemini reviewers.
- The **`autonomousRunRemainingForTopic` contract** was documented precisely
  (codex finding): "remaining" = last-known-incomplete within an un-elapsed
  duration window; a run past its window returns null and is never revived.
- It was clarified that this gate is **deliberately NOT in `DEV_GATED_FEATURES`**
  (integration finding): it rides `dryRun` (where `true` = observe-only), so
  registering it would make the wiring test assert the inverse of every other
  entry. A dedicated dryRun-resolution test locks it instead.
- The **evidence injection was reframed as a TRUE assertion**, not gate-gaming
  (lessons-aware foundation audit): the run genuinely IS live; the idle-gate
  just can't see it as a process. The reuse-vs-new-signal coupling risk was
  documented and routed to the side-effects Interactions review.
- A **3-tier test plan** was added (unit both-sides + dryRun-gate + drain
  re-check; integration real-composition for all four invariants;
  E2E "feature is alive" on both sides of the dev gate), plus the **fail-open
  guard-ordering invariant**, the **topic-resolution-race residual**, and the
  **poisoned-state-file bounded-residual** were made explicit.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1 | decision-completeness (D1 reclassify), integration (DEV_GATED inverted semantics), lessons-aware (E2E + P3 + truth-assertion), adversarial (drain re-check rec), security (bounded residuals), scalability (guard-ordering/fail-open), codex (contract + stale), gemini (stale residual) | 1 material (D1) + several MEDIUM hardening | Added Frontloaded Decisions table; reclassified D1; added drain-time liveness re-check; documented contract; NOT-in-DEV_GATED rationale + dedicated test; truth-assertion framing; 3-tier test plan; fail-open/guard-ordering invariant; topic-race + poisoned-file residuals |
| 2 | codex (token-coupling note, non-material — already documented), gemini (glossary/terminology, non-material) | 0 material | none |
| 2 | (converged) | 0 | none |

Standards-Conformance Gate: ran round 1 (22 standards checked, 0 findings,
registry canary ok, semantic layer degraded:error — advisory only). Round 2:
unavailable (local vault auth flaked on the loaded dev box; signal-only, never
blocks). The body change between rounds was additive hardening; the registry
canary was already green.

Cross-model: ran (codex-cli:gpt-5.5 + gemini-cli:gemini-2.5-pro), both rounds,
MINOR ISSUES, zero material new findings in round 2.

## Full Findings Catalog

**Round 1 — material:**
- **[MATERIAL] Decision-completeness:** D1 (live-on-dev) mislabeled as
  cheap-equivalent. → RESOLVED: added Frontloaded Decisions table, reclassified
  D1 as non-cheap/accepted/irreversible.

**Round 1 — MEDIUM (folded):**
- **Integration:** dryRun gate must NOT go in `DEV_GATED_FEATURES` (inverted
  semantics). → RESOLVED: documented + dedicated dryRun-resolution test.
- **Lessons-aware:** missing Tier-3 E2E dev-gate test + explicit P3 (no
  migration) statement. → RESOLVED: both added.
- **Adversarial:** recommend drain-time liveness re-check (closes window-elapsed
  stale-marker subset). → RESOLVED: added as `invalidate:autonomous-run-finished`.
- **Adversarial:** requeue-override is the only path past the cap (undocumented).
  → RESOLVED: documented in No-revival-loop invariant.

**Round 1 — LOW/INFO (folded):**
- Security: poisoned state file (bounded, in-trust-boundary). → documented residual.
- Scalability: name the fail-open try/catch + age-limit short-circuit invariant.
  → RESOLVED: documented in Mechanism.
- Lessons-aware: evidence injection is a true assertion, not gaming; second
  origination site justified by re-clamp. → RESOLVED: documented.
- Adversarial: topic-resolution race fails to safe side. → documented residual.
- Codex: define `autonomousRunRemainingForTopic` contract. → RESOLVED: added.

**Round 2 — non-material (no change required):**
- Codex: prefer a dedicated `autonomous-run-remaining` signal OR a comment near
  the enum. The spec adopts the documented-coupling path and routes it to the
  side-effects Interactions review — codex's own stated acceptable alternative.
- Gemini: terminology density / add a glossary. Non-material clarity preference;
  the spec links concepts to the foundation code and STANDARDS-REGISTRY.

## Convergence verdict

Converged at iteration 2. Zero material findings in the final round. Both
mandatory blocker lenses (NO double-spawn, NO revival loop) verified FULLY
COVERED by existing guards across both rounds — the convergence gate's stop
condition (an unresolved blocking finding on either lens) was never triggered.
Zero unresolved open questions. The spec is ready for user review and approval.
