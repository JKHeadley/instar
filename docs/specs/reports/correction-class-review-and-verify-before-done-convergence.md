# Convergence Report — Correction Class-Review Loop + Verify-Before-Done

## Cross-model review: codex-cli:gpt-5.5

A real GPT-tier external pass ran through the agent's own codex CLI on **every** round (rounds 1–6;
round 6 a targeted repair round folding F1/F2/F3 — see Iteration Summary), each a `status: ok` clean
pass — so this spec received genuine, repeated cross-model review. Gemini
was not on PATH (single supported external family available; the agent is otherwise Claude-family).
The Anthropic clean-door reviewer was config-gated off. The six internal Claude reviewers + the
code-backed Standards-Conformance Gate ran the review rounds.

## ELI10 Overview

We're building two habits into the agent as *structure* instead of hoping it remembers them.

**First habit — every correction changes the system, not just the one thing.** When the operator
corrects the agent, that correction now runs a two-question "class review" *before* anyone fixes the
specific thing: (1) what *standard/rule* is missing or too weak that let this whole class of mistake
through? (2) what in our *dev process* would have caught it? The answers become a proposed rule
change (which only the operator can ratify) and a tracked build item — and the one-off fix is
*blocked* until that class review has at least been attempted. Grounding this against the live system
corrected our own team's assumption: corrections weren't vanishing at capture (24 were sitting
recorded, including the operator's own three notes) — they were being *recorded and then abandoned*,
open forever, with nothing turning them into durable change. This builds the missing part that drains
a captured correction into a real outcome.

**Second habit — don't claim "done" until you've checked.** The agent shouldn't say "sent it,"
"handed it off," or "getting it done now" before there's evidence the action actually happened. A
lightweight, off-the-critical-path check at the end of a turn compares a completion claim against the
turn's own tool-calls; if a claimed "I pushed branch X" has no actual push of X, it's a quiet signal
(never a block, in this first version) so the agent learns to verify first. The neat part: this
second habit is literally the *first thing the first habit produces* when you feed it the incident
that started this drive — the agent saying "getting Codey his assignment now" before the channel was
verified. The loop demonstrates itself.

Both ship carefully — off for the fleet, on only for the development agent, in "log what I would do"
dry-run mode first. Nothing here can rewrite a rule, block a message, or run a fix on its own; every
powerful step is a *proposal* to the operator or a *signal* into an existing gate.

## Original vs Converged

The original draft had the right two ideas but was, in review's words, "written as if single-machine"
and "trusting the LLM to be the whole data model." Review changed a great deal:

- **The premise was corrected against live reality** — from "corrections produce nothing" (wrong;
  they're recorded but orphaned) to "build the durable-outcome *drain* capture always lacked."
- **The meta-rule got real teeth** — the gate no longer keys on a dodgeable self-tag; the class
  review fires at correction-record time, server-side, so "review attempted before fix" is true by
  construction. (Honest scope: it guarantees *attempted*, not *completed* — a provider outage can
  dead-letter it, which then fails toward allowing the fix *with a tracked retry follow-up*.)
- **Two data collisions were removed** — the class-review lifecycle lives in its own record and never
  touches the correction's status; and "one durable **OUTCOME** per class" is now a modeled
  `semanticClassId` + bounded semantic collapse (every `dedupeKey` keeps its OWN resolvable ClassReview
  shell — F3; only the downstream Initiative/Action dedupes), not a false claim resting on a
  phrasing-hash.
- **Secret safety became load-bearing** — the completion check reads the session transcript (which
  can hold live secrets), so evidence is structural-only via deterministic per-tool extractors
  (branch names, pane ids — never raw content), scrubbed, parsed client-side, with `Bash` a strict
  default-deny allowlist.
- **It became a multi-machine citizen** — a unified, replicated ClassReview store with a
  *lifecycle-monotonic* merge (not the PII no-clobber rule), enum-clamped on receive, satisfying only
  the gate's existence arm (never substituting for local operator ratification), registered as a
  coherence-critical store, terminal-retained (never evicted).
- **The detector got cheap, honest, and disjoint** — a client-side deterministic pre-filter gates the
  transcript read so ~80–95% of turns never pay it; a bounded tail-read (19MB transcripts) off the
  event loop; a single shared clause classifier so it can't double-fire with the action-claim
  sentinel; an explicit flag/not-flag decision table; and graduation that measures *false-negatives*
  (missed over-claims — the real failure mode), not just false-positives.
- **The lifecycle honors the constitution** — `expired-unreviewed` and operator-`deferred` are
  *parked-open* states that keep counting in backlog-health and can reopen (never a durable
  non-improving close); only `ratified`/`shipped`/`rejected`/`no-action` resolve a loop — closing the
  *Never-Waste Feedback* / *No Deferrals* tension the conformance gate surfaced.

## Iteration Summary

| Iter | Reviewers | Material findings | Spec changes |
|------|-----------|-------------------|--------------|
| 1 | 6 internal (security, scalability, adversarial, integration, decision-completeness, lessons-aware) + codex/gpt-5.5 + Standards-Conformance Gate | 2 BLOCKER + 4 blocker-class + ~30 material | Full rewrite; ELI16 companion authored |
| 2 | codex/gpt-5.5 + Conformance Gate | 0 blocker; 5 minor + 1 gate wording | pending-shell, semanticClassId + bounded candidate, deterministic per-tool extractors, deterministic evidence-match, `expired-unreviewed` vs `deferred`, Tier-1 wording |
| 3 (convergence) | 6 internal + codex/gpt-5.5 + Conformance Gate | 0 blocker; all R1 confirmed resolved; ~14 localized new items | origin non-forgeability + `ClassReviewObservation`; unified-store lifecycle-monotonic merge + coherence-manifest + existence-arm-only; Bash default-deny; dead-letter fail-open; `no-action` terminal; shared clause classifier; process `shipped` transition; collapse-algorithm precision; audit segmentation; 3 structural-gate encoding fixes |
| 4 (confirm) | codex/gpt-5.5 + Conformance Gate | 0 blocker; 5 minor + 2 conformance | shell provisional `semanticClassId`; "review *attempted* before fix" honesty + dead-letter follow-up; §8.2 scope to verified-`TurnEvidence`; Jaccard baseline justification; **`expired-unreviewed`/`deferred` reframed as parked-open (not non-improving closes)** |
| 5 (confirm) | codex/gpt-5.5 + Conformance Gate | **Conformance Gate: 0 findings, FIT.** Structural gates: all PASS. codex: MINOR-only, no blocker, nothing reopened | _(see verdict)_ |
| 6 (repair) | 6 internal lenses + codex/gpt-5.5 + Conformance Gate | **Conformance Gate: 0 findings, FIT.** codex: MINOR-only, no blocker, nothing reopened | Repair round after a stopped sub-edit left the body ahead of the tag: **F1** (§4.2 — the completion→suppress-Action-Claim arm is INERT whenever the completion detector is dark/disabled/dry-run; the live `classifyActionClaim` is preserved byte-for-byte until the detector is enabled-and-enforcing), **F2** (§3.1 — an operator-attributed correction is class-reviewed regardless of the agent-settable `kind`, `noise` included; a genuine-noise operator correction resolves `not-applicable`, never dodges), **F3** (§3.8 heading + collapse bullet made consistent with §3.1/§3.3/§3.5 — every `dedupeKey` keeps its OWN resolvable shell the §3.5 gate reads; collapse re-points `semanticClassId` and dedupes only the downstream OUTCOME, never removes/supersedes/clobbers a shell) |

## Full Findings Catalog

The complete round-1 finding set (8 sources, ~50 findings) and every round's items + resolutions are
preserved in the working log `.instar/drive7-ws1-convergence-findings.local.md`. Headline resolutions
per source:

- **Adversarial:** A1 (present-continuous founding incident), A2 (record-time trigger), A3–A14, and
  the round-3 NEW-1…NEW-6 (dead-letter fail-open, corroboration decision table, `no-action` terminal,
  lifecycle-monotonic merge, shared clause classifier, process `shipped` transition) — all resolved.
- **Lessons-aware:** LB1 (semanticClassId), LB2 (status separation), LML3–LM12, N1–N3 — resolved.
- **Security:** S1 (structural-only/scrubbed/client-side TurnEvidence — the BLOCKER), S2–S10,
  NEW-1 (Bash default-deny), NEW-2 (gate-consumed replicated store hardening), NEW-3 (origin
  non-forgeability) — resolved.
- **Scalability:** P1–P6 + R3-SCAL-1 (client-side pre-filter before TurnEvidence) — resolved.
- **Integration:** M1–M6, m7–m11, N1 (coherence-manifest membership), N2 (eviction/tombstone) —
  resolved.
- **Decision-completeness:** the 3 mechanical structural-gate encoding fixes + all dispositions —
  resolved and re-verified passing via the real gate functions.
- **Conformance gate:** framework-agnostic, Tier-1 wording, and the *Never-Waste Feedback* /
  *No Deferrals* lifecycle tension — resolved to **0 findings, FIT**.

## Convergence verdict

**Converged.** Across six rounds — six internal reviewers, six real cross-model codex/gpt-5.5
passes, and six code-backed Standards-Conformance Gate runs — every BLOCKER and every material
finding was resolved. Round 6 was a **targeted repair round**: a prior worker converged the spec over
5 rounds, then a stopped sub-editor left the body ahead of the tag with F1/F2/F3 partially applied
(F1 and F2 fully present; F3 present in §3.1/§3.3/§3.5 but §3.8's heading + collapse bullet still
carried the stale "one review per class" framing that contradicts F3). Round 6 completed F3 in §3.8
so all four sections are mutually consistent, then re-ran the full gate: **Conformance Gate 0
findings + FIT**, and codex **MINOR-only, no blocker, nothing reopened** (its 5 items are pre-existing
clarity/scope/rationale nits on content the prior rounds already converged past — the authoritative-
verifier-registry item is the already-dispositioned codex-r3 C3-3, scoped to v2 — none introduced by
the repair). The convergence signal is strong and multi-source: the deterministic,
constitution-reading **Conformance Gate reaches 0 findings and FIT to the parent principle**
("Never-Waste Feedback"); all three structural convergence gates
(`findOpenQuestions`, `findDecisionPointGaps`, ELI16) **pass**; and every internal material-finding
reviewer independently reached "converged, contingent on localized clarifications" — all of which were
then applied. Rounds 2–6 produced **no blockers and no design invalidations** — only progressively
finer, one-sentence clarifications, the expected tail of an LLM reviewer on a rich spec (codex held a
`MINOR ISSUES`, never-blocker verdict throughout, and its round-4/5/6 items reopened nothing). The spec
is ready for user review and approval. Ships dark/observe-first; the enforcement/block phases are
explicitly out of scope for this spec (operator decisions fed by measured soak data).
