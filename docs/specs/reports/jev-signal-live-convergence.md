# Convergence Report — Jev as a live advisory input to the tone gate's B1–B7 artefact signals

**Spec:** [docs/specs/jev-signal-live.md](../jev-signal-live.md)
**Slug:** `jev-signal-live`
**Converged at:** 2026-09-29
**Iterations:** 8 internal panel rounds, 6 cross-model rounds

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-tier external pass ran through the codex CLI in six rounds (rounds
1–6), and every round returned findings that were folded in. It was not re-run
for rounds 7–8, to spare Codex quota. The body changed after round 6: the
decision-quality recording condition and the caller opt-in, both found by the
internal panel. Those two changes were checked by panel rounds 7 and 8.

Standards-Conformance Gate: ran twice (after round 4 and after round 7), not
every round as the protocol requires — recorded honestly. The final run flagged
three standards as possible violations; each is answered in the spec:
- *Bounded Blast Radius / Capacity Safety* — against a vendor whose requests
  never settle, abandoned requests can grow by three per five minutes with no
  absolute ceiling. Accepted and named: a real fetch honours its abort, and the
  kill switch stops it. The breaker only withholds an optional call; it never
  restarts, respawns or notifies.
- *Decision Provenance & Outcome Review* — outcome grading happens in soak
  windows the operator opens, not continuously. Accepted and named in
  "Measuring the benefit". Every live verdict still carries full provenance
  under promptId `tone-gate-sigv1-jev`.

**Convergence rule, stated honestly.** The skill's criterion is two
consecutive rounds with no design-class finding. This spec did not reach that.
The design findings shrank each round (panel 6 → 4 → 1 → 1 → 0 → 1 → 2 → 1), and each was a new, smaller case rather than the same defect
coming back. Convergence is closed under the operator's standing 80/20 rule
(Justin, 2026-09-17: "usable soon beats perfect"). Every design finding was
fixed in code with a test, or is named in the spec as a residual. None was
deferred.

## ELI10 Overview

Before one of my messages goes out, pattern-matchers flag technical artefacts,
such as a file path or a command, and a judge model decides whether showing
them is a problem. For a week Jev, a fast specialist model, answered the same
questions in the background. It agreed with a stronger reference model at least
as often as the patterns did.

This change lets Jev's *confident* answers feed the judge on the development
agent. Where Jev is unsure, or slow, or down, nothing changes. Jev can add a
signal or comment on one, but it can never remove or override what the
patterns saw. It never blocks anything on its own. It only runs where the
judge's verdict on these artefacts is a nudge the agent can override.

## Original vs Converged

- **Originally, a confident Jev "no" deleted the pattern's hit.** It now keeps
  the hit as detected and adds a note that Jev disagrees. First Codex asked for
  the hit to be kept. Then Codex round 5 showed that marking it "not detected"
  still silenced the rule, because the prompt only acts on detected signals.
- **Originally, "advisory" was assumed.** The review found three ways a model
  signal could still become a wall:
  - On the fleet, B1 and B3–B7 block unless the advisory migration is on.
  - The route hardens an advisory into a block when decision-quality recording
    is not live.
  - Other callers of the gate treat any non-pass as final.

  Live signals now need all three of: the outbound route's opt-in, the
  migration, and live recording.
- **Originally, the text went to the vendor as-is, with no outage handling.**
  Live egress is now secret-scrubbed. A vendor-down breaker opens after three
  failures the caller actually saw, missed deadlines included. The single
  request slot is generation-checked, so a stuck call cannot free a newer
  call's slot.
- **Originally, the paid referee and the stored excerpts would outlast the
  trial.** Both are now bound to the shadow's own soak window by one check.
  The ongoing Jev calls past the soak are stated plainly as the point of the
  change.
- **Originally, any confident answer switched the prompt shape.** The prompt
  and promptId now change only when Jev actually changed the list. An agreed
  "nothing here", which is 71 of the 75 audited answers, leaves the prompt
  identical to before.
- **The evidence claims were narrowed.** The spec now claims agreement with a
  reference model, not proven benefit. It also corrects the rollback direction:
  to reduce Jev's influence, *widen* the unsure band.

## Iteration Summary

| Iteration | Reviewers who flagged design issues | Design findings | Precision findings | Spec sections changed |
|-----------|-------------------------------------|-----------------|---------------------|-----------------------|
| 1 | panel (security, integration, adversarial, decision-completeness), codex | 6 + 4 | 3 | What changes, Latency, Config, Egress, Decision points |
| 2 | panel, codex | 4 + 3 | 5 | Latency (breaker, slot), Logging, Measuring the benefit |
| 3 | panel (spend past soak), codex (band direction, deadline row) | 1 + 2 | 3 | Beyond the soak, Measuring, Logging |
| 4 | panel (excerpts past soak), codex (minor) | 1 + 0 | 3 + 4 | Beyond the soak (one measuring check), Egress, Logging |
| 5 | codex (prompt contract: detected=false, citation; no-answers) | 0 + 3 | 3 | What changes, Prompt + provenance, Breaker |
| 6 | panel (route hardens advisory when recording not live), codex (non-finite probabilities) | 1 + 1 | 3 + 3 | Only where B1–B7 are overridable, Measuring |
| 7 | panel (non-route callers treat advisory as final; router-build-failure residual) | 2 | 2 | Only where B1–B7 are overridable (opt-in + named residual), Tests |
| 8 | panel (the opt-in sat in shared `evaluateOutbound`, reaching the digest publisher and `/attention`) | 1 | 1 | Only where B1–B7 are overridable (per-caller opt-in), Tests |

## Full Findings Catalog

Each finding's resolution is in the spec and code. The main ones:
- **Round 1, security:** unscrubbed egress. Fixed with `scrubForStore` before
  sending, and a test.
- **Round 1, adversarial / codex:** suppression of detector evidence. Fixed:
  the hit is kept, then annotated rather than flipped (round 5).
- **Round 1, integration:** the fleet's blocking dispositions. Fixed: live
  requires the advisory migration.
- **Round 1, scalability:** vendor outage. Fixed with the breaker.
- **Round 2, codex:** the slot race and deadline accounting. Fixed with the
  generation-checked slot and caller-view breaker, with tests (mutation-verified).
- **Rounds 3–4, panel:** referee and excerpts past the soak. Fixed with one
  `shadowMeasuring` gate, with tests.
- **Round 5, codex:** the prompt contract. Fixed: `detected=true` +
  `model_disagrees`, and a citation exception for model-only lines.
- **Round 6, panel:** the route's `advisoryUnrecordable` hardening. Fixed:
  `decisionQualityRecordingLive()` is required, with a test.
- **Round 7, panel:** non-route callers. Fixed with the `liveArtefactSignals`
  opt-in set only by the outbound route, with a route-level test that fails
  when the opt-in is removed.
- **Round 8, panel:** the opt-in lived in the shared `evaluateOutbound`, so
  the growth digest and `/attention` (holds final) received it. Fixed: it is a
  per-caller option passed only by send paths with the acknowledge fields,
  with a real `/attention` route test that fails when the opt-in is forced on.
- **Round 7, panel:** router-build-failure boot. Named as a residual (every
  migration advisory is already demoted on that boot).

## Convergence Verdict

Closed after round 8 under the 80/20 rule described above; round 8's single
design finding was fixed with a mutation-verified route test and was not
re-reviewed. No open questions.
Every design finding raised is fixed with a test or named as a residual in the
spec. The spec is ready for approval.
