# Convergence Report — Resume queue: a stale emergency-stop pause must not silently strand active autonomous runs forever

## Cross-model review: codex-cli:gpt-5.5

A real GPT-tier external pass ran through the agent's codex CLI in every one of the
six convergence rounds (clean `status:ok` each round). The Gemini-tier pass
(`gemini-cli:gemini-2.5-pro`) contributed real reviews in rounds 1, 2, 4 and 5, and
degraded (timeout) in rounds 3 and 6 — a partial pass for those rounds, not a
collapse, since codex carried each round with a successful external opinion. The
spec-level aggregate is therefore the clean RAN flag: the spec received genuine
cross-model (non-Claude) review of its exact converged content. Six internal
reviewer perspectives (security, scalability, adversarial, integration,
decision-completeness, lessons-aware + a one-layer foundation audit) and the live
Standards-Conformance Gate (`POST /spec/conformance-check`, 22 standards, 0 findings)
ran every round.

## ELI10 Overview

Echo runs long "autonomous" sessions. To stay healthy, each terminal process gets
recycled when it gets old — killed and restarted with no work lost. A safety net
called the **resume queue** brings a recycled autonomous run back automatically. That
net has an off switch: when someone sends an "emergency stop," the system pauses the
whole resume queue so nothing it killed gets resurrected against their wishes. Good
idea — for the moment of the stop. The bug: that pause never turned back off. On
2026-06-14 an emergency stop from the *previous day* (about a *different* topic) left
the net switched off for ~18 hours; when Echo's real autonomous run got recycled, the
net correctly caught it but the line was frozen, and the run sat dead for ~4 hours.

This change adds two things, both inside the part of the code that runs every ~60
seconds. **Layer 1** tells you, with one calm notice, whenever the net is paused and
sessions are waiting — so the silent 4-hour strand can never recur. **Layer 2** turns
the net back on by itself when the pause is clearly *stale*: if an emergency stop is
old and a *new* active autonomous run has since been recycled and queued (more than an
hour after the stop), the stop obviously wasn't about this newer work, so the queue
auto-resumes. The safety case rests on a finer-grained guard that already exists: any
topic the operator actually stopped stays blocked by a *per-topic* "operator stopped
this" record, even after the queue turns back on. The tradeoff: auto-resume is ON by
default (it's a bug fix for a permanent silent strand, not a speculative feature), with
a one-line off-switch and a clean revert.

## Original vs Converged

The original spec was already sound in design — the convergence process hardened its
*robustness and its evidence*, and surfaced one genuine behavior gap:

- **The emergency-stop semantics went from asserted to PROVEN.** Originally the spec
  *claimed* the global pause was an over-broad artifact and the emergency-stop was
  "really" topic-scoped. Review (codex r1/r3/r4) pressed hard on this — it's the whole
  safety case. The converged spec now CITES the actual `routes.ts` handler code showing
  every emergency-stop action (kill, job-clear, queue-cancel, operator-stop-record,
  reply) is bound to the single topic the "stop" message arrived in, with the global
  pause as the lone over-broad side-effect. A reviewer can now verify the premise.
- **Overlapping pauses became correct, not just "safe."** Review (codex r4/r5, gemini
  r4/r5) asked what happens if a deliberate `autonomous stop-all` arrives while an
  auto-resumable emergency pause is active. Originally `pause()` was first-writer-wins,
  so the later deliberate halt would no-op and the queue could still auto-resume —
  defying the operator. The converged change makes `pause()` *upgrade*: a deliberate
  halt overrides an existing auto-resumable pause (the reverse never downgrades),
  honoring the operator's explicit intent, with a `pause-upgraded` audit row.
- **The brittle substring match got mechanically enforced.** Both models flagged
  `/emergency|sentinel/i` as a fragile authority basis. The converged design centralizes
  it in one tested predicate (`isAutoResumableEmergencyPauseReason`) AND adds a unit
  test that scans `src/` for every `ResumeQueue.pause('…')` callsite and pins each
  reason's verdict — so a future reason can never silently change auto-resume behavior
  (a `pauseKind` enum is the documented future replacement at that single callsite).
- **Layer-1 dedupe got count-aware.** Originally "once per pause episode" — review
  (codex r3) noted that if 10 more entries pile up under the same pause, the drainer
  goes silent again. Now the dedupe key is `(pausedAt, waitingCount)`, so a growing
  backlog re-alerts.
- **Clock + boundary discipline made explicit.** Strict `>` comparison via one injected
  clock; malformed timestamps resolve to the SAFE side (pause stays); single-process
  clock guaranteed by the queue's machine-local design.
- **Multi-machine posture declared:** machine-local by design (one queue per machine,
  single-writer lockfile); no new cross-machine surface, URL, or replicated state.
- **User-facing wording fixed:** the Layer-1 notice carries no raw `POST /…` API
  pointer (that lives in the audit row); plain "ask me to resume it, or resume it from
  the dashboard."

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1 | codex, gemini, internal (scalability, integration, lessons) | 5 | Layer-1 plain-English wording (no raw API); fire-once-per-episode; strict `>` + boundary tests + clock discipline; blast-radius + incident-scope acknowledgments; multi-machine posture; substring brittleness acknowledged + Future path |
| 2 | codex, gemini | 4 | Centralized `isAutoResumableEmergencyPauseReason()` predicate + closed-world test; explicit `operatorStopSince`-dependency statement; precise in-memory dedupe wording; panic-reflex vs deliberate-halt distinction; accepted-tradeoff notes (dry-run silence, contextual age) |
| 3 | codex (SERIOUS→addressed), gemini (degraded) | 2 | Cited the routes.ts code proving topic-scoped emergency-stop intent; count-aware Layer-1 dedupe `(pausedAt\|waitingCount)` + test |
| 4 | codex, gemini | 1 | Documented first-writer-wins overlap semantics + product-semantics statement; count-level dedupe clarified intentional |
| 5 | codex, gemini (same finding) | 1 | `pause()` UPGRADE-on-deliberate-halt (override auto-resumable pause); why-predicate-not-blind-TTL rationale; overlap tests both orderings |
| 6 | codex (no new), gemini (degraded) | 0 (converged) | Bonus hardening: mechanical `pause(` callsite-scan test (codex r6 #2) |

## Full Findings Catalog

**Round 1.**
- *codex #1 / gemini #1 — substring reason match is brittle (MINOR).* Resolution:
  acknowledged; centralized + tested predicate (r2); structured `pauseKind` deferred to
  Future with rationale.
- *codex #5 — Layer-1 body contains raw `POST /…` API pointer (MINOR).* Resolution:
  plain-English notice; endpoint moved to the audit row.
- *internal/scalability — Layer 1 fires every tick.* Resolution: fire-once-per-episode
  (later count-aware).
- *codex #3 / gemini #3 — clock/boundary underspecified (MINOR).* Resolution: strict
  `>` via one injected clock; safe-side on malformed timestamps; boundary tests
  (exactly-at, +1ms, malformed); single-process-clock note.
- *gemini #2 — unpause whole queue (blast radius) (MINOR).* Resolution: documented
  deliberate design; per-topic `operatorStopSince` guards every freed entry.
- *codex #4 — trigger narrowness (MINOR).* Resolution: stated incident-scoped; Layer-1
  audit count is the evidence stream to broaden later.
- *internal/integration — multi-machine posture undeclared.* Resolution: machine-local
  BY DESIGN section added.

**Round 2.**
- *codex r2 #2 — closed-world assumption not executable (MINOR).* Resolution:
  `isAutoResumableEmergencyPauseReason()` helper + pinned unit test for every current
  pause reason.
- *gemini r2 #1 — safety critically depends on `operatorStopSince` (MINOR).* Resolution:
  explicit dependency statement; the per-topic-guardrail-intact test re-asserts it post
  auto-resume.
- *codex r2 #3 — Layer-1 dedupe lost across restart (MINOR).* Resolution: precise
  "once per drainer process per episode; aggregate folds a post-restart repeat."
- *codex r2 #1 — global vs panic-reflex semantics.* Resolution: panic-reflex
  (auto-resumable) vs deliberate halt (never auto-cleared) distinction.
- *codex r2 #4 (dry-run silence), gemini r2 #3 (contextual age) — accepted tradeoffs.*

**Round 3.**
- *codex r3 #1 — emergency-stop semantics under-specified (SERIOUS).* Resolution:
  cited the actual routes.ts handler proving topic-scoped intent; the global pause is
  the lone over-broad artifact. (De-escalated to MINOR in r4.)
- *codex r3 #3 — Layer 1 can go silent within an episode as backlog grows (MINOR).*
  Resolution: count-aware dedupe key `(pausedAt|waitingCount)` + growing-backlog test.
- *codex r3 #2/#4 — repeats (contextual age / pauseKind); accepted/Future.*
- *gemini r3 — degraded (timeout); codex carried the round.*

**Round 4.**
- *codex r4 #3 / gemini r4 #2 — overlapping pause episodes (MINOR, NEW).* Resolution:
  documented first-writer-wins (verified against `pause()`), then UPGRADED in r5.
- *codex r4 #1 — product-semantics doc.* Resolution: explicit topic-scoped definition.
- *codex r4 #4 — count-only dedupe.* Resolution: stated intentional count-level.
- *codex r4 #2, gemini r4 #1 — repeats (pauseKind); Future.*

**Round 5.**
- *codex r5 #1 / gemini r5 #2 — first-writer-wins defies a later deliberate halt
  (MINOR, the same finding from both models).* Resolution: `pause()` now UPGRADES an
  auto-resumable pause when a deliberate non-auto-resumable reason arrives; tests for
  both orderings; `pause-upgraded` audit.
- *gemini r5 #1 — blind pause-TTL alternative.* Resolution: documented why the
  evidence-based predicate is strictly more conservative than a blind timer.
- *codex r5 #2/#3/#4, gemini r5 #3 — repeats; accepted/Future/intentional.*

**Round 6 (converged).**
- *codex r6 — zero new material findings; all items recycled from prior rounds and
  already addressed in the spec.* Bonus adopted: codex r6 #2 → mechanical
  `ResumeQueue.pause(` callsite-scan test (makes the closed-world guarantee structural,
  not comment-dependent).
- *gemini r6 — degraded (timeout); codex carried the round.*

## Convergence verdict

Converged at iteration 6. The final round produced no material findings — every item
in codex's round-6 read is a recycled theme already resolved in the spec text, and the
sole fresh material finding of the prior round (the deliberate-halt pause upgrade) was
implemented and is absent from round 6. The `## Open questions` section is empty (no
live user-decision parked). The spec is ready for user review and approval. Standing
operator pre-approval (Justin, topic 13481) keeps `approved: true`.
