# Convergence Report — Dev-Agent Dark-Gate Enforcement

## ELI10 Overview

Instar ships new features "dark" — off for the whole fleet, but live for
*development agents* (the ones opted in to dogfood unproven features). There's
already machinery enforcing this (a resolver helper, a registry, a test, a lint).
The cartographer features shipped recently **bypassed** it — they hardcoded
themselves off with no marker, so they shipped dark for *everyone*, including the
dev agent meant to be dogfooding them. The lint couldn't catch it because it
can't distinguish "deliberately off for everyone" (a destructive process-killer)
from "forgot to opt in" (cartographer).

This spec does two things: (A) routes cartographer's *zero-cost* surfaces through
the existing gate so they run live on dev agents, while keeping the one
*cost-bearing* surface (a background sweep that pays an outside model) an explicit
opt-in; and (B) closes the lint hole so every "off by default" feature must make a
*declared* choice — dev-gated, or on a documented exclusion list with a category
and a real reason.

## Original vs Converged

The first draft was directionally right but review changed it substantially in
ways that mattered:

- **It would have auto-armed third-party spend on every dev agent.** The original
  draft "neutralized" a separate egress-consent switch and let the dev-gate alone
  turn on the cost-bearing background sweep. Killing the *privacy* framing was
  correct (the agent sends source to an outside model every turn anyway), but that
  switch was *also* the only "I accept the ongoing cost" confirmation. Collapsing
  it meant a routine update would silently start a money-spending background job
  across the whole dev fleet — the exact "runaway background loop" mistake Instar
  has been burned by. **Converged: split privacy from cost.** The free read
  surfaces go live on dev agents; the one spending surface stays an explicit
  one-line opt-in everywhere; the redundant privacy switch is removed.
- **It would have shipped a feature that's dark on a route even after "fixing" it.**
  The conformance audit's route gate uses a strict `!== true` check, so omitting
  the default would 503 on a dev agent while the wiring test passed — a
  green-test/dark-feature divergence. **Converged: every strict gate site is
  converted to the resolver, with a build-time grep-verify and a 200-not-503
  integration test.**
- **It would have gated two dead flags.** Two egress sub-flags
  (`llmEnrichment`, `llmRerank`) have no runtime consumer — registering them would
  assert behavior that doesn't exist. **Converged: excluded as structural stubs.**
- **Its enforcement was gameable and its test was self-defeating.** The exclusion
  list had no quality bar (a one-word reason passed); the path-attribution parser
  was claimed to skip strings when it doesn't; and the "drift canary" test was a
  snapshot regenerated from the very resolver it was meant to check (asserting
  output == output). **Converged: a closed category enum + minimum reason length;
  an honest declaration that the parser only strips comments plus a loud-fail
  guard for the unhandled case; and a hand-authored (never regenerated) golden
  path map.**
- **It left Migration Parity as an open question.** Existing dev agents already
  have the feature hardcoded off on disk, so they'd stay dark after update — the
  motivating agent (Echo) wouldn't light up. **Converged: ship a scoped, one-shot,
  dev-agent-only migration that strips only the zero-cost defaults and never the
  sweep.**

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1 | security, scalability, adversarial, integration, lessons-aware | ~13 (multiple high: auto-armed sweep spend across dev fleet; strict `!== true` route gate darks dev agents; unwired stubs; exclusion-list no quality bar; Migration Parity left open; brace-tracker fragility) | Full v2 rewrite: privacy/cost decoupling (sweep stays explicit opt-in, not dev-gated); route-gate conversion + grep-verify; stubs excluded; category-enum + min-reason quality bar; SHIPPED scoped one-shot migration; declared assertion-C literal-only limit; golden-path drift canary |
| 2 | adversarial (3 new) | 3 (golden-path snapshot self-defeating; codeOnly() string-skip overclaim; destructive-not-gated denylist evadable) | v3 honesty/precision: hand-authored regeneration-forbidden canary; drop false string-skip claim + add loud-fail brace-in-string guard; declare denylist limit + name CODEOWNERS human backstop |
| 3 | (converged) | 0 | none |

Security, scalability, integration, and lessons-aware all reached convergence at
iteration 2 (each verified against live code — including confirming routes.ts:4169
`=== true` is a status field, NOT a gate, and must not be converted). Iteration 3
was driven solely by the adversarial reviewer's three round-2 precision findings;
v3 folded all three as honesty/precision changes (no design change), and both the
adversarial and lessons-aware reviewers confirmed zero material findings.

## Full Findings Catalog

**Iteration 1 (material):**
- *Security:* migrateConfig auto-strip would silently activate the off-Claude
  sweep on existing dev agents at update (→ migration never touches the sweep);
  exclusion reasons unvalidated + nothing stops dev-gating a destructive feature
  (→ category enum + destructive-not-gated test).
- *Scalability:* sweep's only cumulative ceiling is the shared LlmQueue cap →
  auto-enabling crowds out other background work (→ sweep no longer auto-armed);
  per-tick cents-cap vs config mismatch (noted); multi-machine poller cost
  (bounded by lease gate, confirmed).
- *Adversarial:* exclusion list trivial bypass (→ quality bar); egress
  neutralization auto-starts cost sweep (→ decoupled); brace-tracker desync (→
  codeOnly discipline + golden path); 21-way mis-classification unguarded (→
  auditable table + destructive guard).
- *Integration:* conformanceAudit route uses strict `!== true` → 503 on dev agent
  (→ convert all strict gate sites + grep-verify + 200 test); llmEnrichment/
  llmRerank unwired (→ exclude as stubs); egressAcknowledged read at ONE site not
  five (→ named); migration provenance (→ one-shot marker).
- *Lessons-aware:* Migration Parity left open violates P3/P10 (→ shipped);
  auto-live cost sweep repeats background-loop mistake P19 (→ explicit opt-in);
  assertion C literal-only blind spot must be declared not claimed closed P2 (→
  declared); brace-tracker needs drift canary L5 (→ golden path); egressAck
  silently inert = No Silent Degradation (→ upgrade-guide note).

**Iteration 2 (material, all adversarial):**
- Golden-path canary trivially defeated by blind snapshot regeneration (HIGH) →
  hand-authored literal, regeneration forbidden, CODEOWNERS-reviewed.
- Spec falsely claims codeOnly() skips string/template contents (MED) → corrected
  to "strips // comments only" + loud-fail brace-in-string lint guard.
- Destructive-not-gated guard is an evadable marker denylist (MED) → limit
  declared (P2); CODEOWNERS human gate + required per-entry justification named as
  the real backstop.

**Iteration 3:** zero material findings; adversarial + lessons-aware confirmed.

## Convergence verdict

**Converged at iteration 3.** No material findings in the final round, verified
against live source (devAgentGate.ts, devGatedFeatures.ts, the lint, routes.ts,
server.ts, PostUpdateMigrator one-shot-marker pattern). The spec is ready for user
review and approval.

**Convergence method note:** abbreviated convergence — the external cross-model
reviewers (GPT/codex, Gemini, Grok) were unavailable on the host this session, so
the five internal reviewers (security, scalability, adversarial, integration, and
the mandatory lessons-aware pass) ran every round. The lessons-aware reviewer's
one-layer-below foundation audit and the adversarial reviewer's round-2
precision pass carried the convergence — exactly the circular-self-verify defense
they exist to provide, since the spec author ran their own convergence.

**One open decision carried to the operator (does not block convergence):** whether
the cost-bearing freshness sweep should ALSO auto-arm on dev agents. The spec
defaults it to explicit opt-in even on dev agents (the P19-safer choice); flipping
it is a one-line change (move `freshnessSweep.enabled` into `DEV_GATED_FEATURES`).
