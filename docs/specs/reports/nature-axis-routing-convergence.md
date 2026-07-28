# Convergence Report — Nature-Axis Routing (Task-4 S4)

## Cross-model review: codex-cli:gpt-5.5

A real GPT-tier external pass ran through the agent's own `codex` CLI on **every one of the 10 rounds**
(gpt-5.5), and a Gemini-tier pass (`gemini-cli`, gemini-2.5-pro) ran on 8 of 10 (degraded/timeout on
rounds 2 and 8). At least one — in fact every — round received a genuine non-Claude external opinion, so
the spec-level flag is the clean **`codex-cli:gpt-5.5`** (not `degraded-all-rounds`). This convergence was
NOT a Claude-only echo chamber.

## ELI10 Overview

When a background part of the agent needs an AI to answer a question (is this an emergency stop? is this
reply safe to send? summarize this?), it currently picks *which* AI service to use based on a coarse label
("this is a sentinel"). We benchmarked reality with ~2,200 real calls and found the label is the wrong
thing to pick on. What actually matters is the **nature of the task** — because the *same* model can be the
best choice for one kind of task and the worst for another. The headline example: the exact same Opus model
scores 99% through a clean API but only 82% (as low as 35% on judgment) through the "coding assistant"
door, whose 20,000-word "you are a helpful coding agent" wrapper turns a careful judge into a gullible
yes-man — yet that same gullible door is the *best* choice for creative writing.

This spec makes the agent pick the right door *and* model by task nature, safely. It ships behind a switch
that is off on the fleet and on-but-observing (dry-run) on a development machine first; when unset,
behavior is byte-for-byte like today (with one deliberate exception — a standalone safety fix that stops a
fallback from ever sending a safety judgment to the gullible Opus route, which is always on because it only
makes things safer). Safety judgments are routed only through clean doors, never the gullible one — enforced
by an *allowlist* in code (three independent layers), not just documentation. Paid routing can never be
turned on by the agent itself: the agent proposes a spending cap and the operator approves it with a PIN,
and on a multi-machine setup paid routing stays off until there's a shared spend counter so two machines
can't each spend a full budget.

The main tradeoff is complexity: routing-by-nature with safety + money + multi-machine coherence is
genuinely a multi-concern feature, and both external reviewers repeatedly noted that. We addressed it
structurally — a clean two-increment split (CLI-only core first, metered doors + money governance second),
a stateless-fold core with the fancy damper deferred and off by default, an exact deliverables checklist,
and a decision-tree diagram — rather than by pretending the problem is simpler than it is.

## Original vs Converged

The **original seed** correctly framed nature-axis routing and front-loaded the operator decisions, but the
review process changed a great deal of substance:

- **The harness-door ban went from a documented rule to a structural, un-bypassable guarantee.** Originally
  a build lint + a tier-string clamp. Review found three independent bypasses: a concrete Opus *model id*
  (not the `capable` tier) slipping past a string check; a *runtime* config edit never re-linted; and — the
  biggest — the reused router's own **binary-missing degrade path fails OPEN to Opus-via-CLI in `main`
  today** (a real pre-existing bug the spec now fixes unconditionally). The ban is now an *allowlist*
  (only the one pinned concrete Sonnet reserve id is permitted on that door), enforced at build-time,
  resolve-time-over-live-config, AND runtime including the degrade path.
- **Injection safety went from a decorative field to an enforced static map.** Originally a per-call caller
  flag (one forgotten callsite silently enables the non-injection Groq door). Now a static, exhaustive,
  ratcheted map defaulting to "exposed" (fail-safe), fingerprinted on input-shape so a caller that starts
  forwarding user content is caught.
- **Money got a real authority boundary.** Originally a config flag the agent could flip. Now a PIN-gated,
  agent-proposes/operator-approves go-live; USD reservation semantics (estimate→reserve→reconcile) so the
  cap is never breached by more than one in-flight call; and a *fail-closed* single-machine test (a
  transiently-dark peer can't trick a machine into thinking it's alone and double-spending).
- **The empty-availability case went from "crash / blanket fall-through" to authority-class routing.**
  A blanket fall-through to legacy routing could re-open the banned door for a safety gate; a blanket
  fail-closed would turn ordinary background calls into hard "denials." Now: unmapped → legacy;
  doc-tree → refuse-to-author; low-stakes → the caller's own heuristic; critical gate → fail closed.
- **The resolver's contract was pinned down.** The chain-derivation (does a tightened nature keep its
  original chain?), the four distinct return outcomes, and a typed fail-closed error were all made explicit
  after repeated internal contradictions were caught.
- **The last fix** (round 10, from the comprehensive verifier): FD4 described the emergency-stop classifier
  as "Flash-Lite-pinned" — which reads as routed *to* the one door R8 proves is unsafe for exactly that
  slot. Corrected to "pinned *off* Flash-Lite," matching R8.

## Iteration Summary

| Round | Reviewers who flagged material issues | Material findings | Spec changes |
|-------|----------------------------------------|-------------------|--------------|
| 1 | gate, codex(SERIOUS), gemini, security, scalability, adversarial, integration, decision-completeness, lessons | ~29 across 9 themes | harness-ban hardening, money go-live, fail-closed, LA4 degrade-path fix, injection gate, R-rules, perf model |
| 2 | gate, codex(MINOR), security, scalability, integration, lessons | ~12 | allowlist ban, PIN go-live, unconditional LA4 clamp, fail-closed N-detection, single-writer counter, migrations, baseline lifecycle, reason codes |
| 3 | gate, codex(SERIOUS), gemini, adversarial, lessons | 6 | empty-set nature-aware fail-closed, static injection map, notice aggregation, FD4-never-WRITE ratchet, pi-cli justification |
| 4 | gate, codex(MINOR), gemini | 4 | glossary, semantic-drift guard, resolution trace, R6 refuse-to-author |
| 5 | codex(MINOR), gemini, combined-safety | 4 | availability-cache split (injection safety), chain-derivation, fingerprint scope, fail-closed contract test |
| 6 | codex(MINOR), safety, lessons | 5 | resolver chain-derivation, authority-class empty-set, budget-not-cached, sticky invariants, degrade predicate |
| 7 | codex(SERIOUS), gemini, verifier | 4 | definitive resolver formula, label→id registry, deferred sticky, 4-outcome signature |
| 8 | gate, codex(SERIOUS) | ~6 | pinned concrete reserve id, no-route contract, maturation+testing prominence |
| 9 | codex(MINOR), gemini | 2 | input-shape fingerprint, Increment-A deliverables checklist |
| 10 | codex(SERIOUS), gemini(MINOR), verifier | 1 material (FD4/R8) + refinements | **FD4/R8 fix**, typed-error contract, reservation semantics, A1/A2 split, OPA/Envoy comparison, decision-tree, traceability |

Trajectory: architecture stable from round 1; rounds 2–10 hardened it and fixed inconsistencies (several
self-introduced by patching). Internal reviewers decision-completeness and lessons-aware returned CONVERGED
at round 5; the final comprehensive all-perspectives verifier (round 10) found exactly one material
contradiction (fixed) and judged the rest sound and internally consistent. The conformance gate is clean.

## Full Findings Catalog (by theme, across all rounds)

**Harness-door ban (safety-critical).** Denylist→allowlist (only the pinned concrete Sonnet reserve id);
three-place enforcement (build lint + resolve-time live-config + runtime clamp); the LA4 unconditional
degrade-path clamp fixing a real fail-open in `main`; a defined clamp predicate when the feature is unset;
FD4/R8 MessageSentinel-pinned-off-Flash-Lite reconciliation; critical-gate-never-WRITE ratchet.

**Injection & bench rules.** Static exhaustive injection-exposure map (fail-safe default) with input-shape
fingerprint; R6 (doc-tree never Claude, defer-then-refuse), R8 (input-classifiers off Flash-Lite),
R3/R4/R5/R7 lints.

**Fail-closed / degradation.** Empty-availability split by authority class; four typed `resolveRoute`
outcomes (`RouterFailClosedError` distinct from ordinary `no-route`); per-critical-gate fail-closed
integration test; No-Silent-Degradation compliance (tracked, never a silent brittle heuristic).

**Money & multi-machine.** PIN-gated agent-proposes go-live; USD reservation semantics; fail-closed
N-detection (configured, not reachable-peers); shared-ledger prerequisite for multi-machine metered;
single-writer spend counter; deleted the phantom no-OpenAI-key door.

**Performance.** In-mem spend counter (budget read fresh, never cached — closes a post-cap overspend
window); async/buffered audit; {reachable,breakerClosed}-only availability cache with policy fresh per call
(closes an injection-cache bypass); sticky-primary deferred + default-off + bounded invariants; provider
memoization.

**Notice / observability.** FD6 per-machine aggregated HIGH drift notice (Bounded Notification Surface +
uncoalesced visibility) with an immediate reserve-landing escalation; baseline lifecycle; structured
availability reason codes; `GET /intelligence/routing` dryRun plan/diff/`?trace`.

**Rollout / migration.** Dev-agent maturation ladder (live-dryRun dev / dark fleet); versioned migration
with a byte-equal-to-prior-default override discriminator; FD8 Fable→Opus content-sniffed migration
(session-restart-gated).

**Decision-completeness.** FD10 cheap-tag contested and narrowed to CLI-only nature-A/D non-gate reordering;
production money cap authorization frontloaded (no mid-build stop); `## Open questions` empty.

**Residual (non-material, documented).** The codex external persistently rated the spec "SERIOUS" on
inherent-complexity grounds and re-raised further-decomposition / CLI-wrapper-dependency / terminology in
fresh wordings each round. These are architectural preference (the CLI-wrapper dependency is a given — the
harness penalty is not instar-fixable) and repeats of already-addressed concerns, which the convergence bar
classifies as non-material. They are addressed as far as reasonable (increment split, A1/A2, deferred
sticky, deliverables checklist, decision tree, OPA/Envoy comparison, evaluator-boundary framing) and the
beyond-scope enhancements (runtime input-provenance audit; continuous door-penalty canary) are tracked in
§Close-the-Loop.

## Convergence verdict

**Converged at round 10.** The design is materially sound and internally consistent: the conformance gate
returns zero findings; the decision-completeness and lessons-aware internal reviewers returned CONVERGED;
the final comprehensive all-perspectives verifier found exactly one material contradiction (FD4/R8), which
is fixed, and judged everything else sound. Every safety-, money-, correctness-, and fail-closed finding
across ten rounds is resolved. The only remaining external findings are architectural-taste re-raises and
beyond-scope enhancements (tracked), which are non-material per the convergence bar. The spec is ready for
operator review and approval.

**This report and the `review-convergence` tag do NOT set `approved: true` — that is the operator's step
after reading this report.**
