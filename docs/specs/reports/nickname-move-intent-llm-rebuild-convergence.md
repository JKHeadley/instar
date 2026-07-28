# Convergence Report — Move-Intent Recognizer: Keyword List → LLM-With-Context

## Cross-model review: codex-cli:gpt-5.5

A real GPT-tier external pass ran through the agent's codex CLI in BOTH rounds (round-1 and round-2),
and a Gemini-tier pass (gemini-2.5-pro) ran in round-1. The spec received genuine cross-model review;
this is the clean RAN state.

## ELI10 Overview

The agent can run on several of your machines, and you can move a conversation from one to another just by
saying so mid-chat — "move this to the mini". The old code decided *"is this a move command?"* with a list
of trigger words (`move`, `run`, `keep`, `continue`, …). On 2026-07-03 that ate a real message: **"keep the
work on the laptop"** — plain discussion — matched the word `keep` and was hijacked as a command, so the
agent never saw what you said. The reverse failed too: "let's have the mini take this one" IS a command but
has no trigger word, so it was missed.

Telling a command from discussion is a judgment about what a person *meant*, and a word-list can't do that.
So we replaced it with a small AI classifier that reads your message plus the last few turns and answers a
strict, structured question: is this a present command to move the conversation, and to which of your **real**
machines? Two things make it safe: it can only pick a machine from your actual list (it can't invent one),
and **when in doubt it does nothing** — if the AI is unavailable, times out, is unsure, or gives a
low-confidence answer, your message passes straight through to the agent instead of being grabbed. The old
bug was code being too eager to seize your message; the new code leans the opposite way.

For now nothing visible changes: it ships **off on the fleet** and, on the development agent, in **dry-run**
— it watches real messages and writes down what it *would* have done, but still passes everything through,
so we can prove the false-alarm rate collapsed before it's ever allowed to actually move a session. The
deeper fix is a committed **benchmark** that pits commands against look-alike discussion, so this whole class
of bug can't sneak back.

## Original vs Converged

The original draft already had the right shape (LLM + structured enum guardrail + fail-open + cheap
pre-filter). Review hardened it in six substantive ways:

1. **The guardrail is now explicitly framework-independent.** The original read as if it relied on the model
   provider supporting native schema/enum-constrained decoding. Converged: the provider returns free text, we
   `JSON.parse` it and validate the emitted `targetNickname` field against the known-machine set *in code*
   (`resolveEnumTarget`) — so the guardrail works on any framework, and malformed/off-schema output fails
   open. (Round-1 decision-completeness D7 + gemini G2.)
2. **Honest about what CI can and cannot guard.** The deterministic corpus tests the *pipeline*, not the
   model's judgment. Converged: added the explicit graduation gate — the opt-in live benchmark must pass on
   the *routed* model (≥90% + both canonical cases) before `dryRun:false`, backed by the soak, fail-open, and
   `/metrics/features` drift monitoring. (Round-1 adversarial M1/M2.)
3. **No fleet regression, stated.** Removing the keyword recognizer looked like it might delete a live
   feature. Converged: the whole relocation path is already gated behind `sessionPool != dark`, so the fleet
   never ran the keyword path either — clarified, with the full graduation ladder. (Round-1 D1/D2.)
4. **Multi-machine posture + privacy of the audit log.** Added a `## Multi-machine posture` section
   (stateless machine-local compute; the JSONL is a machine-local observability log; soak-read aggregation at
   graduation) and changed the code to log ONLY LLM-engaged decisions (not a preview of every inbound
   message). (Round-1 D3/D4 + security S1 + codex C4.)
5. **A stale-context false-positive vector.** Added a corpus case where a bare "yes" answers an unrelated
   question while a stale move proposal sits in the window → must pass through; the prompt hands the model
   turn roles + chronological order. (Round-1 adversarial M3 + round-2 codex C2.)
6. **Latency + tunability.** Timeout reduced 6000→4000ms; `modelTier` exposed (default `fast`, raisable to
   `balanced`). (Round-1 C5/G1 + M2.)

## Iteration Summary

| Iteration | Reviewers who ran | Material findings | Spec changes |
|-----------|-------------------|-------------------|--------------|
| 1 | conformance-gate (51 std) + security + adversarial + decision-completeness/integration + lessons-aware + codex-cli:gpt-5.5 + gemini-cli:gemini-2.5-pro | 0 blocking; ~9 material-clarify + minor (guardrail-framework-independence, CI-cannot-test-discrimination, no-fleet-regression, multi-machine posture, audit-log privacy, stale-context, latency, model-tier, fail-open-on-malformed) | Contract rewrite; new "Discrimination accuracy" + "Multi-machine posture" + "Observability" sections; Fail-OPEN trigger list; Rollout ladder; code: log-only-LLM-engaged, timeout 4000, modelTier; tests: stale-context + schema-violation cases |
| 2 | conformance-gate + codex-cli:gpt-5.5 (gemini-cli in-flight) | 0 material new | MINOR refinements only: "Alternatives considered" section, turn-roles note, user-role Live-Channel proof tied to actuation |
| — | (converged) | 0 | none |

Standards-Conformance Gate: ran each round (51 standards). Round-1 flagged Live-User-Channel Proof +
Observability; round-2 flagged Testing-Integrity-E2E + Live-User-Channel Proof — all folded in (route-less
classifier → E2E-alive is N/A; the dry-run soak + user-role live-channel proof before `dryRun:false` is its
equivalent, now explicit in the Rollout ladder).

## Full Findings Catalog

**Round 1 — cross-model codex-cli:gpt-5.5 (MINOR ISSUES):** C1 deictic-target prefilter limit → documented as
a deliberate fail-open limit. C2 deterministic-command-channel alternative → "Alternatives considered". C3
stale-context false positive → corpus case + roles/ordering. C4 audit-log privacy/volume → log only
LLM-engaged + fields/truncation specified. C5 6000ms latency → 4000ms.

**Round 1 — cross-model gemini-cli:gemini-2.5-pro (MINOR ISSUES):** G1 latency/UX → 4000ms + acknowledged. G2
explicit fail-open on malformed/schema-violating output → added to trigger list + a test.

**Round 1 — internal:** Security: no material (prompt-injection defended via JSON.stringify + delimiters,
enum guardrail structural, no privilege escalation); minor S1 audit-preview over-collection → fixed.
Adversarial: M1 CI-can't-test-discrimination + M2 threshold/tier + M3 stale-context → all addressed
(graduation benchmark, configurable tier, corpus case). Decision-completeness/integration: D1/D2 no-fleet-
regression + ladder, D3/D4 multi-machine posture + soak-read, D7 guardrail-framework-independence → all
folded in. Lessons-aware: no material (faithful exemplar; rides shared funnel; fail-open correctly inverted
vs the tone gate); noted the pre-existing `isMidReply:()=>false` foundation gap → Rollout pre-`dryRun:false`
checklist.

**Round 2 — cross-model codex-cli:gpt-5.5 (MINOR ISSUES):** alternatives-considered, turn-roles/ordinal
distance, confidence-is-advisory, prefilter-frequency — all either already addressed or added as advisory
clarifications; none material. Conformance: Testing-Integrity-E2E (N/A, route-less) + Live-User-Channel Proof
(now an explicit actuation precondition).

## Convergence verdict

Converged at iteration 2. Round-2 produced zero material new design findings — only minor refinements, all
addressed. `## Open questions` is empty (`*(none)*`); every decision is frontloaded. The spec is ready for
approval. The implementation is already built and green (tsc, lint, all three test tiers including the
discrimination corpus).
