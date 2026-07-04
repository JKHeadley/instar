# Convergence Report — Topic-Profile Intent Recognizer: Keyword Regexes → LLM-With-Context

## Cross-model review: codex-cli:gpt-5.5

A real GPT-tier external pass (codex-cli, gpt-5.5) AND a Gemini-tier pass (gemini-cli,
gemini-3.1-pro-preview) ran against this spec through the agent's own installed CLIs — one review
per available family, across two rounds (round 1 on the initial body, round 2 on the addressed
body). Both returned **MINOR ISSUES** only; Gemini's summary: "excellent quality … the identified
issues are minor … rather than any fundamental design flaws." Every finding was folded in. This is
the clean RAN state (no ⚠).

## ELI10 Overview

Each conversation topic can be pinned to a coding framework (Claude, Codex, Gemini, …), a model,
or a thinking depth, and you set that by just talking: "use codex here", "set high thinking on this
topic". The code that decided *"is this message a setting change?"* used a list of trigger regexes —
and a regex fires on words, not meaning, so it can't tell an order ("use codex here") from a
question ("should we use codex here?") or a complaint ("codex here keeps failing"). This is the
same class of bug that, in a sibling piece of code, once ate an operator's message on 2026-07-03.
Instar's constitution now bans keyword lists from deciding what a human meant — that judgment must
be made by the AI reading the message and the recent conversation.

We replaced the regexes with a small LLM classifier. It reads your latest message plus a few recent
turns and answers a strict, structured question: is this a present command to change this topic's
framework, model, or thinking — and if so, to which allowed value? Two things keep it safe: it can
only pick from the real allowed lists (it can't invent a framework or model), and on any doubt —
provider down, unsure, low confidence, or a value it only inferred from stale earlier chat — it does
nothing and the message passes straight through to the agent, never turning into a session respawn.
It ships OFF for the fleet and, on the development agent, in "dry-run" (it makes the decision and
logs what it *would* have done, but changes nothing) until a deliberate flip after the evidence
shows it's accurate.

## Original vs Converged

The original spec had the right skeleton (LLM classifier, enum guardrail, fail-open, dev-gated
dry-run). Review changed it in four substantive ways:

1. **Closed a real safety hole (the biggest change).** The adversarial reviewer found that a
   context-only affirmative ("yeah go with that", answering a question five turns back) could get a
   value resolved purely from stale context and actuate a session respawn — bypassing the existing
   confirm-slot guards, something the old whole-message regexes could never do. We added a
   deterministic **grounding guard**: the resolved value (or a framework's friendly word) must
   appear in the *latest* message to actuate; a context-only positive passes through instead.
2. **Made the log privacy-safe.** The original soak log stored an 80-char snippet of the operator's
   raw message. Two reviewers flagged it as inconsistent with the codebase's "never persist a raw
   quote" convention. We removed the raw preview entirely — the log now carries only enum-bounded
   fields and the message length.
3. **Made failure a swap-then-safe, not a silent drop.** The LLM call is now tagged `gating:true`,
   so a provider blip swaps to another provider before falling back; and the fall-back is
   pass-through-to-the-agent (a more capable handler), always reported — never a brittle fake check.
4. **Named the multi-machine posture, the graduation evidence, and a concrete calibration bound.**
   Added a "Multi-machine posture" section (machine-local by design, correctly), pointed graduation
   evidence at the auto-aggregated `/metrics/features` surface (no hand-collated logs), and set a
   concrete graduation threshold (≥200 decisions, <1% false-actuation, zero context-resolved
   actuations).

Smaller hardening: symmetric untrusted-data delimiting for context turns, a cleared timeout timer,
de-duplicating the current message out of the context window, and an honest reframe of the bug class
(the old regexes were tightly anchored, so their defect was missing valid paraphrases + the banned
anti-pattern, not rampant false positives).

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1 | Standards-Conformance Gate (3), codex-cli:gpt-5.5, gemini-cli, adversarial/security/decision, lessons/integration/multi-machine | 2 (context-only actuation bypass; missing multi-machine posture) | grounding guard + guardrail tests; multi-machine section; scrubbed log; symmetric delimiting; timeout clear; context dedupe; alternatives-considered; honest bug-class reframe; observability/attribution note |
| 2 | Standards-Conformance Gate (2), codex-cli:gpt-5.5 | 0 material (2 advisory: No-Silent-Degradation composition; No-Manual-Work graduation) | `gating:true` swap-first; fail-open/No-Silent-Degradation composition; graduation via `/metrics/features`; concrete calibration bound; context-only-affirmative flow |
| 3 | Standards-Conformance Gate (2, both non-material) | 0 | none (converged) |

Standards-Conformance Gate: ran each round (round 1: 3 flags; round 2: 2 flags; round 3: 2 flags).
The round-3 flags are non-material: (a) Testing Integrity wants an E2E lifecycle test — but this
change adds NO HTTP route (a pure-logic classifier + a dev-gated branch in the existing inbound
path), ships dev-gated dark (no fleet user-facing change until a deliberate flip), and the
integration test IS the end-to-end ingress-decision proof; the decision-completeness + integration
reviewers explicitly cleared it, matching the merged move-intent exemplar's posture. (b)
Constitutional Traceability reports the parent-principle "Intelligence Infers, Keywords Only Guard"
as unlisted — a stale-server artifact: the running server is on an older branch whose registry
predates the standard; the standard IS present in this spec's registry at
`docs/STANDARDS-REGISTRY.md:124`, which is the copy the pre-commit parent-principle check reads.

## Full Findings Catalog

**Iteration 1 — material:**
- *[adversarial, MATERIAL]* Context-referential affirmatives bypass confirm-slot guards and
  actuate directly. → Resolved: `valueGroundedInLatestMessage` guard requires the value in the
  latest message; context-only positives pass through. Corpus case `guard-context-only-value` +
  unit tests added.
- *[multi-machine, MATERIAL]* Spec silent on multi-machine posture. → Resolved: added
  "Multi-machine posture" section (machine-local by design, `physical-credential-locality`), and
  moved graduation evidence to `/metrics/features`.

**Iteration 1 — minor (all addressed):**
- *[security]* Context turns not delimited as strongly as the message → `JSON.stringify` each turn.
- *[security]* Classifier enum is all SUPPORTED_FRAMEWORKS, not the enabled set → documented: the
  write surface is the availability authority (falls back with a named notice).
- *[security]* Group-topic non-operator context turns → mitigated structurally by the grounding
  guard (a non-operator can't inject the value into the operator's latest message) + documented.
- *[privacy]* Soak log stores raw message content → removed the raw preview; enum fields + length
  only.
- *[correctness]* `Promise.race` timeout never cleared → cleared in `finally`.
- *[cost/accuracy]* Prefilter dominated by common words → documented as inclusive-by-design (safe,
  drop-only; the grounding guard, not the prefilter, bounds actuation); did not break `pi` detection.
- *[justification]* Motivating examples overstated the old regex's false-positive rate → reframed
  honestly (tight `^…$` anchor; defect is miss-direction + the banned anti-pattern).
- *[foundation]* effort/escalationOverride remain regex → argued the boundary (whole-message
  anchored, closed enum, explicit-only mandate form; out of offender #1's scope; tracked in the audit).
- *[correctness]* Latest-message double-feed in context → fetch N+1, drop trailing turn equal to
  the message.
- *[conformance]* Testing Integrity / Observable Intelligence / Token-Audit → attribution.component
  auto-feeds `/metrics/features`; documented; tests double as wiring-integrity.

**Iteration 2 — advisory (addressed):**
- *[codex, minor]* Grounding guard vs natural confirmations → documented context-only-affirmative
  pass-through-by-design flow + corpus proof.
- *[codex, minor]* Global model enum "understood then refused" → documented the framework-scoped
  refusal at the write surface.
- *[codex, minor]* Prompt contract / prefilter coverage / rollout threshold → concrete calibration
  bound added; prompt teaches both directions + untrusted framing (asserted in tests).
- *[conformance]* No-Silent-Degradation → `gating:true` swap-first + composition documented.
- *[conformance]* No-Manual-Work → graduation via auto-aggregated `/metrics/features`.

## Convergence verdict

Converged at iteration 3. No material findings in the final round (the two round-3 conformance flags
are non-material and explained above). Both external families (GPT-tier + Gemini-tier) ran and
returned minor-only. Spec is ready for review and approval.
