# Convergence Report — LLM-Decision Provenance Wiring (ACT-562)

## Cross-model review: codex-cli:gpt-5.5

A real GPT-tier external pass ran through the agent's codex CLI (gpt-5.5) on rounds 2 and 3 (status `ok` both rounds). The clean RAN state. The Standards-Conformance Gate ran each round (advisory). Six internal Claude reviewers (security, scalability, adversarial, integration, decision-completeness, lessons-aware) ran on round 1; the three reviewers who raised blockers/material (security+adversarial, integration) re-verified their findings against live source on round 2.

## ELI10 Overview

Instar's AI makes lots of small decisions all day — hold a message, kill a process, keep an autonomous run going. Today it records how *often* each decision fires and what it costs, but not *what it decided on* or *whether it was right*. This spec builds the first, foundational fix from the accountability audit: turn on a durable record of each important AI decision (the context it saw + the choice it made), starting with the three highest-stakes decisions, using a recorder that already exists and is well-built (credential-scrubbed, machine-local, auto-deleted after 14 days, and it never slows the decision). The point of comparison for "done" isn't just wiring the three — it's an automated tripwire that makes coverage only-grow-never-shrink, because the audit existed precisely because a rule was honored in words but unenforced in code.

The main things to weigh: (1) it logs the three highest-stakes points first, and widening later needs your explicit privacy sign-off (more logging = more plaintext context on disk); (2) records are machine-local, locked-down, redacted over the API, and every piece of logged text is treated as untrusted so it can't turn into a hidden instruction that fools a future grader; (3) it never changes a decision — logging failures can't hold a message. After this lands, the next two pieces are the periodic "grade with the strongest model" review and the real-prompt benchmark + real-data reevaluation loop.

## Original vs Converged

The original draft was sound in intent but had real holes the review closed:

- **Injection safety.** Originally the spec logged decision context and handed a redacted view to a future grading model — but the logged context is attacker-influenceable (message bodies, transcript tails), so a crafted context could later steer the grader. The converged spec makes "every logged field is untrusted data, never an instruction" a load-bearing invariant with ONE canonical safe serializer per surface (HTML-escaped for the browser; JSON-string-in-a-fence for LLM replay) and a delimiter-injection test.
- **The tripwire could be disarmed.** Originally the coverage ratchet only caught *adding* an unwired point; you could silently *delete* a point and stay green — reproducing the exact failure the audit found. The converged ratchet is monotonic (a committed floor that can't drop without a reviewed, rationale-bearing PR) and rides the existing LLM-callsite census so new decision points can't hide.
- **"Always logged" depended on remembering.** Originally a high-stakes decision stayed unsampled only if each callsite passed a flag. The converged spec binds the exemption to the decision point's stable identity (`component:kind:v1`), enforced in the recorder, and makes identity drift a red build.
- **"Never slows the decision" was asserted, not proven.** Review found one real path where writing a record could throw into the decision (a fail-closed gate would then hold the message). The converged spec makes the record call total, fixes the substrate throw-path, and adds a negative test.
- **It would have been dead on single-machine agents.** The recorder was constructed only inside the multi-machine pool path, so the fleet-wide decisions it targets would hit a null recorder. The converged spec hoists construction to unconditional and cleanly separates "always constructed" from "recording is dark on the fleet."
- **Wrong multi-machine label.** The draft mislabeled the surface `physical-credential-locality`; the correct posture (matching the parent spec) is `machine-local write, proxied-on-read`.
- **Feedback loop.** The converged spec forbids graded outcomes from feeding back into decisions within this increment or the next, deferring that edge to its own spec with a bias analysis.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes | Cross-model |
|-----------|-----------------------|-------------------|--------------|-------------|
| 1 | security, adversarial, integration, decision-completeness, lessons-aware | 2 blockers + 6 material | full rewrite (§3.1a envelope, §3.2 monotonic ratchet, §3.2a identity-sampling, §3.4 fail-open, §3.5 loop, §3.6 hoist, posture fix, DEV_GATED_FEATURES) | not run (round 1 pre-rewrite) |
| 2 | integration (1 new material: NEW-1) | 1 material + minors | pin flag-consumption (construct vs wire), route semantics, textHead-untrusted | codex-cli:gpt-5.5 `ok` (6 minors) |
| 3 | (codex minors only) | 0 material | serializer canonicalization, production-config allowlist, correlation contract, buffer priority+alert, discovery-inventory | codex-cli:gpt-5.5 `ok` (6 minors, all folded) |

Standards-Conformance Gate: ran each round (advisory, signal-only).

## Full Findings Catalog

**Round 1 (blockers):** (B1) untrusted context feeds future grader/bench replay with no re-fence → §3.1a enveloping invariant. (B2) self-reinforcing loop unaddressed by "observability-only" → §3.5. **(material):** deletable ratchet → §3.2 monotonic; caller-boolean sampling exemption → §3.2a identity; unproven fail-open / clampRow throw → §3.4; PII-in-redacted-view + `?scope=pool` contradicting "never replicated" → §3.1b + posture + pool-cache; pool fan-out unbounded/token-forwarding → §5 shared-cache; construction pool-gated → §3.6 hoist; wrong posture key → posture fix; DEV_GATED_FEATURES unregistered → §5.

**Round 2:** all round-1 blockers/material verified CLOSED against live source. NEW material (NEW-1): §3.6 unconditional-construction vs §5 dark-flag tension → resolved by separating construction (always) from wiring (dark-gated) + route 200-empty semantics. Minors: textHead still untrusted; identity-drift should be CI-caught; stale route message. codex round-2: 6 minors.

**Round 3 (codex, minors only, all folded):** canonical replay serializer + closing-delimiter test; discovery-inventory in the ratchet; production-config allowlist; outcome correlation contract (decisionId/runId/attemptId, idempotent); "never sampled out" wording + `highStakes.bufferDropped>0` alert.

## Convergence verdict

Converged at iteration 3. The final round produced ZERO material findings (codex round 3 returned MINOR-only with "no serious architectural objection"; the round-2 internal re-verification confirmed every round-1 blocker/material closed against live source). All minors are incorporated. Zero unresolved entries in `## Open questions`. The spec is ready for operator review and approval. Note honestly: convergence certifies the DESIGN is sound and complete — the build (and its three test tiers) is the next step, gated on operator `approved: true`.
