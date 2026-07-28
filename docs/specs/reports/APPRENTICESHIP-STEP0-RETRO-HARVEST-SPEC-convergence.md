# Convergence Report — Apprenticeship Step 0: Retro-Harvest

## Cross-model review: codex-cli:gpt-5.5

A real GPT-tier external pass ran through the agent's own installed codex CLI (`gpt-5.5`,
`status:ok`) in rounds 2 and 3 — the clean RAN state. The internal Claude reviewer panel
(security, scalability, adversarial, integration, lessons-aware) plus the constitutional
Standards-Conformance gate (degraded this run — LLM-backed; fail-open, non-authoritative, noted)
also ran each round.

## ELI10 Overview

Step 0 is the "review the last round before you start the next one" prerequisite for the
Apprenticeship Program. It reads everything we learned mentoring Codey (the issue ledger, the
playbook, Echo's memory, the Telegram threads, the shipped PRs) and distills it into a durable,
categorized "retro-harvest" document — plus a prioritized "what the program needs" list that
feeds Step 1. The only code it ships is a small validator that checks the harvest's shape.

The review changed the design materially. The original draft assumed the harvested *meta-lessons*
could be seeded into the existing framework-issue playbook and would show up in
`GET /framework-issues/playbook`. Three independent reviewers, reading the actual ledger code,
proved that's impossible: that store is shaped for *fixed bugs*, a process meta-lesson fits none
of its buckets, freshly-written entries aren't surfaced by the playbook query, and Echo can't
promote its own lessons. So the converged design makes the **harvest document itself** the
authoritative home for meta-lessons, with the bug playbook kept for what it's built for — two
complementary stores. The review also added a hard secret/PII redaction rule (we're mining
private channels), bounded the corpus so a giant thread can't blow the context window, and — per
the just-ratified "Body and the Mind" constitution article — demoted the structural validator to
a *signal* and named an independent LLM fidelity review (with an inspectable audit trail) as the
*authority* for whether the harvest is actually faithful.

The tradeoff: Step 0 deliberately ships *light* (mostly synthesis + one validator) and defers the
enforcement *gate* (that makes a valid harvest required) to Step 1 — a real phase boundary, since
you can't build a gate that requires an artifact before the artifact's schema and validator exist.

## Original vs Converged

- **Originally:** meta-lessons were "seeded to the playbook" and success meant "they appear in
  `GET /playbook`." **After review:** that path can't work against the real ledger; the harvest
  document is the authoritative meta-lesson store; ledger seeding is optional, candidate-only,
  source-framework-tagged, and explicitly does not depend on the known-broken populate path (#50).
- **Originally:** "the harvest is done when the validator passes." **After review:** the validator
  is a structural *signal*; an independent LLM *fidelity review* (sampled pointer resolution,
  watermark-accuracy, rubric, inspectable audit bundle) is the *authority* for faithfulness —
  applying Signal vs Authority / The Body and the Mind.
- **Originally:** no redaction rule. **After review:** pointers-not-payloads, an approved scrubber
  that blocks the write on failure, a secret-pattern backstop, internal-only.
- **Originally:** unbounded corpus read, every retro re-mines all history. **After review:**
  bounded read with coverage-extent, first harvest must be `full`/`complete` (or accept named
  gaps), later retros are incremental.
- **Originally:** "what the program needs" was free-text. **After review:** schematized with
  ids + motivating-insight pointers + priority, count-reconciled, and Step 1 must cite need-ids.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1 | security, adversarial, integration, lessons-aware, scalability | ~7 (incl. 1 load-bearing critical caught by 3 reviewers independently) | Full rewrite: storage model, redaction, validator-as-signal, corpus bounds, programNeeds schema, taxonomy, scope, honesty fixes |
| 2 | cross-model codex (gpt-5.5) | 5 minor | First-harvest=full; count-validation de-brittled; fidelity protocol; pointer URIs; scrubber metadata |
| 3 | cross-model codex (gpt-5.5) | 5 polish | Audit bundle; immutable pointer locators; validPartial/Complete; latest-harvest INDEX; scrub-failure blocks |
| — | (converged) | trajectory critical→minor→polish | none material remaining |

## Full Findings Catalog

**Round 1 — CRITICAL (adversarial + integration + lessons-aware, independently):** the
`/observe`→playbook seed path cannot surface meta-lessons (born `playbook_status='none'`; query
returns only `candidate`/`extracted`; meta-lessons fit no generalizable bucket; Echo can't
self-promote; populate path is open bug #50). **Resolution:** §5 storage model rewrite — harvest
artifact authoritative; ledger seed optional/candidate-only/#50-independent.

**Round 1 — HIGH (security):** secret/PII leak from Telegram+memory into a committed,
cross-agent-seeded artifact. **Resolution:** §7 redaction invariant.

**Round 1 — HIGH (lessons-aware, Structure>Willpower / Signal-vs-Authority):** "validates = done"
is theater (structural-only validator). **Resolution:** §9 validator=signal + LLM fidelity
review=authority.

**Round 1 — HIGH (lessons-aware, Migration Parity):** seeds only hit Echo's local DB.
**Resolution:** §5 honesty — seeds are candidate, unattested, local; cross-agent propagation is a
named open dependency, not a silent claim.

**Round 1 — HIGH (adversarial):** self-reported `sourcesCovered` unfalsifiable. **Resolution:**
§6/§8 coverage-extent + §9 resolvable-pointer + watermark checks.

**Round 1 — MAJOR (scalability):** unbounded corpus / context blow / re-mine-all-every-retro.
**Resolution:** §8 bounding + incremental + budget.

**Round 1 — MEDIUM cluster:** taxonomy single-class brittleness → primary+secondary + anti-skew
(§4); programNeeds free-text → schematized (§10); §9 route coin-flip → pure-CLI no-route; #634
conflation → disambiguated (§5b); Agent-Awareness → explicitly deferred to Step 1 (§12);
Close-the-Loop overclaim → corrected (§13).

**Round 2 — MINOR×5 (codex gpt-5.5):** first-harvest-must-be-full (§8); count-validation
brittleness → watermark-not-live (§9); fidelity-review protocol (§9); pointer URI scheme (§6);
scrubber metadata + limited-backstop label (§7). All resolved.

**Round 3 — POLISH×5 (codex gpt-5.5):** fidelity audit bundle (§9); immutable pointer locators
(§6); validPartial/validComplete (§8); latest-harvest INDEX.json (§6); scrub-failure blocks write
(§7). All resolved.

## Convergence verdict

Converged after round 3's polish refinements were applied. The finding trajectory is monotonically
decreasing in severity (one load-bearing critical → minor → polish), the load-bearing design flaw
(the seed mechanism) was caught and corrected before any code, and the final round produced only
diminishing-returns polish — all incorporated. The spec is ready for user review and approval.
The cross-model posture is the clean `codex-cli:gpt-5.5` (a real external opinion ran). Approval
(`approved: true`) remains the user's step after reading this report.
