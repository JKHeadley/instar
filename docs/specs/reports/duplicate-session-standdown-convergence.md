# Convergence Report — Duplicate-session stand-down

## Cross-model review: codex-cli:gpt-5.5

A real GPT-tier external pass ran through the agent's codex CLI in BOTH rounds (round 1:
SERIOUS ISSUES, 5 findings, all folded; round 2: SERIOUS ISSUES, 3 findings, all folded).
gemini-cli was attempted both rounds and **degraded (error) both times** — recorded
per-round; the spec-level flag is the clean codex flag because a genuine external opinion
was received in every round.

## Convergence basis — the operator's 80/20 standard, stated plainly

This spec is declared converged on the **operator-directed 80/20 basis** (Justin,
2026-08-16, topic 46473: convergence is "an intelligent holistic check between iterations
that uses intelligence to decide if the spec is converging in a meaningful manner", not
convergence-until-nothing-found), NOT the two-consecutive-clean-rounds bar. The honest
picture:

- **Round 1 → v2**: ~35 findings across 6 internal reviewers + codex + the constitutional
  gate, including several that falsified v1's central claims. v2 was a full rewrite.
- **Round 2 (confirm)**: every round-1 fold was independently verified GENUINE (28/29; one
  partial on latch hygiene, then folded). Round 2's own findings — codex 3, panels ~17 —
  were all narrowing/correction-class against v2's NEW text, with two direction
  corrections (expiry semantics; suspend-first replaced by refuse+attention). All are
  folded in the current text.
- **The round-2 folds are author-applied and NOT verified by a further round.** A round 3
  would primarily re-verify those folds. That is the 20% deliberately not purchased.
- The constitutional gate's two residual flags are the spec's two DECLARED tradeoffs
  (bounded-and-visible spawn/close cycles pending CMT-2027; the per-framework enforcement
  matrix with codex hook coverage tracked), each argued in the spec body — signal
  acknowledged, not silently dropped.

## ELI10 Overview

When two of the operator's machines both run a live copy of the agent for one conversation,
the copies fight — duplicate answers, stalls, churn. The old cleanup couldn't fix it
because its safety rule refuses to close a busy session, and a duplicate is always busy. A
force-kill design was reviewed and rejected (it could kill both copies, loop forever, or
cut the agent off mid-answer). This spec is the operator-chosen replacement: the losing
copy is told to STAND DOWN — it can't start new work of any kind and can't send the user
messages, but nothing it holds is destroyed; when it's genuinely quiet, one narrow,
explicitly-declared close rule ends it. Contested cases (the copy holds real work, or the
records disagree) go to the human, once, with everything frozen and nothing lost. It ships
dark on the fleet and observe-only first even on the dev machine.

## Original vs Converged

- v1 claimed the existing idle cleanup would close the drained copy for free. Review proved
  that cleanup runs only under memory pressure — so the converged spec declares an explicit
  "drained-close" rule and names exactly which three keep-guards it crosses and why, and
  which seven it never crosses. What was a hidden fourth bypass is now the one declared,
  bounded exit.
- v1's muzzle blocked commands and messages but would have let the copy keep EDITING FILES
  (and spawning helpers). Converged: everything except pure reading is blocked, unknown
  tools included.
- v1 keyed the message-refusal on a sender identity that does not exist in the send path.
  Converged: topic-keyed refusal with an ownership re-check at fire time, per-class
  verification of every internal sender (one fresh false claim about the standby was
  caught in round 2 and corrected), and sender-identity stamping tracked as a refinement.
- v1 silently swallowed user messages the muzzled copy held. Converged: three named
  behaviors — re-deliver toward the owner, release-or-divert on fresh messages
  (reachability wins, including when the durable queue is dark), and one honest
  per-episode notice.
- v1 had no answer to churn. Converged: episode latches keyed on ownership epochs, an
  epoch-mint rule, notice caps, TTL-resumes, release hysteresis, and a both-halves-frozen
  terminal state at expiry (round 2 rejected the draft's "tools resume" answer as a silent
  local actor).
- v1 auto-suspended live autonomous runs — a new authority the underlying primitive never
  had (it is consent-gated). Converged: refuse + one attention item; the human decides.
- Missing entirely from v1, added: the Agent Awareness template sections (including the
  muzzled session's own behavioral contract, which is what makes cooperative drain
  converge), migration entries, the framework coverage matrix, marker-file atomicity and
  boot regeneration, a two-directional impossible-state canary, and dryRun honesty
  (no notice, no false alarms, uncoalesced soak evidence).

## Iteration Summary

| Round | Reviewers | DESIGN-class findings | Outcome |
|---|---|---|---|
| 1 | 6 internal + codex (gemini degraded) + conformance gate (2 flags) | ~24 design (incl. 4 falsified claims) + ~11 precision | Full v2 rewrite |
| 2 | 3 combined confirm panels + codex (gemini degraded) + conformance gate (2 residual declared-tradeoff flags) | 28/29 folds GENUINE; 3 codex + ~8 panel design findings on v2's new text, 2 direction corrections | All folded; declared converged on the 80/20 basis |

Standards-Conformance Gate: ran every round (r1: 2 flags, folded; r2 pre-fold: 2, folded;
r2 post-fold: 2 residual = the declared tradeoffs).

Per-round model disclosure: internal reviewers ran as opus-tier subagents of the authoring
session; external = codex-cli:gpt-5.5 both rounds; gemini-3.1-pro-preview degraded (error)
both rounds.

## Full Findings Catalog

The complete round-1 and round-2 finding sets, verbatim with resolutions, are preserved in
the authoring session transcript and summarized per-finding in the spec's own body (every
fold cites its finding inline — search "round-1" / "round-2" in the spec). Key
falsified-claim findings: idle-pipeline close (lessons r1-1), egress funnel category error
(lessons r1-5), migration-freebie (integration r1-1), standby sender path (integration
r2-N1), suspend-first authority (adversarial r2-N3), TTL enforced only one direction
(codex r1-1 on the predecessor, re-checked here).

## Convergence verdict

Converged at round 2 on the operator's 80/20 basis (basis and residuals stated above).
Ready for operator review and approval. The build must treat the spec's inline round-2
folds as binding design text.
