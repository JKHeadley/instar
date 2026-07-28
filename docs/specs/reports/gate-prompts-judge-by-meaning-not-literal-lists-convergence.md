# Convergence Report — Gate Prompts Judge by Meaning, Not Literal Lists

## Cross-model review: RAN (codex-cli / gpt-5.5) — clean across rounds; gemini intermittently degraded

The external cross-model pass RAN on every round via the agent's own codex CLI (gpt-5.5), returning `ok` with a `MINOR ISSUES` verdict on each round (its findings folded in). The gemini CLI was available and ran rounds 2–3 but degraded (call failure) on rounds 1, 4-retry, and 5 — recorded honestly; codex's successful pass satisfies each round's cross-model requirement (one genuine outside opinion per round). No round converged having never received a real external opinion.

## Outcome: CONVERGED (5 rounds)

Both convergence criteria hold:
1. **No material new issues** in the final round — round 5's reviewers (adversarial, lessons-aware) explicitly returned CONVERGED; codex round 5 was MINOR (its two points folded as the final post-round-5 edits, which are the reviewer's own accepted resolutions).
2. **Zero unresolved `## Open questions`** — the section is `*(none)*` and the structural open-questions gate returns an empty unresolved list.

## Reviewer panel (per round)

Six internal Claude reviewers (security, adversarial, scalability, integration, decision-completeness, lessons-aware) + the code-backed Standards-Conformance Gate + the cross-model external pass (codex; gemini when available), each round.

## Iteration summary

- **Round 1** — Standards-Conformance Gate: ran (0 flags initially). Externals: gemini CLEAN, codex MINOR (4). Internal: security CRITICAL (discussion-carve-out injection), scalability PASS, + adversarial/integration/decision-completeness/lessons-aware (material set: ratchet-must-not-be-brittle, completion-laundering task boundaries, meaning-first concrete language).
- **Round 2** — major reshape after the operator's sharpened directive (2026-06-24, topic 28130): authored the new constitution standard *Intelligent Prompts — An LLM Gate Must Not String-Match*; corrected scope (B15 = live bug, B16–B18 = hardening, B1–B7 = Phase-2 migration). Standards-Conformance Gate: ran (flagged No-Silent-Degradation on an early fail-open endorsement — removed). Found a large convergent set: the global header/response-format are themselves literal-gates; in-band invalid-rule fail-open; the keystone reason-gate fix; REVIEWED_ADVISORY inverted; awareness-mechanism factual errors.
- **Round 3** — Standards-Conformance Gate: ran (1 flag: No-Silent-Degradation deferral). Material: RULE_CLASSES missed B20 (ratchet would fail CI); adversarial carve-out residuals (external-blocker laundering, context-planted carve-outs, partial-continue); CMT-1794 structural pin. Decision-completeness CONVERGED; lessons-aware blessed the deferral as honest Close-the-Loop.
- **Round 4** — Standards-Conformance Gate: ran (1 flag). 5/6 internal converged (security, lessons, decision, scalability, integration); adversarial found two over-block regressions (NEW-5 context-status-with-continuation, NEW-6 external-dependency timing). Externals + conformance converged on shipping a fail-closed NOW rather than deferring.
- **Round 5** — Standards-Conformance Gate: ran (0 findings after fail-closed-now). Adversarial CONVERGED (NEW-5/NEW-6 closed, no reopening). Lessons-aware CONVERGED (fail-closed reframe sound). Codex MINOR (structured-intermediate + hold-semantics — folded). Gemini degraded.
- **Final cross-model confirmation** — a closing codex pass on the post-round-5 body returned **SERIOUS**: the "fail-closed on every path" claim had left the route-level **slow-review timeout** fail-OPEN — the easiest bypass (attacker-induced latency). Folded: the slow-timeout now fails-closed (hold) too (all FOUR no-verdict paths), the kill-switch covers it, + structured-field consistency validation. Re-confirmed: conformance 0 findings, codex back to MINOR (one honesty scoping of the session-clock signal to time-box claims, folded). This catch is exactly why the closing confirmation pass is run rather than declaring convergence on the round-5 verdicts alone.

## What materially changed through convergence

- Authored the missing constitution standard + wired its CI ratchet enforcement (the operator's primary ask).
- Reframed B15 (and the header/response-format) from literal-phrase-gating to a meaning-first **reason-gate**: the agent-state REASON is controlling, every carve-out subordinate — closing a whole family of paraphrase/laundering bypasses (forward-work, completion, blocker, design-fork, appended-question, scope-relabel, external-blocker-pretext, context-planted, partial-continue, B18-runway).
- Added deterministic agent-state signals (session clock) so B15 judges claims against ground truth — the directive's own pattern applied reflexively.
- Made the gate **fail-CLOSED** on every gating-LLM failure path (invalid-rule, JSON-parse, provider-exhaustion), with an operator kill-switch — resolving the No-Silent-Degradation finding.
- Hardened the ratchet against its own brittleness: source-registry rule classification (all 20 rules incl. B20), fail-closed-on-unclassified, scans header + carve-out prose, positive-presence test for the keystone, reworded-construction negative test, frozen Phase-2 allowlist bound to a real CMT.
- Corrected factual errors (REVIEWED_ADVISORY; the framework-shadow awareness mechanism; pi-cli gap).

## Known advisory disagreement (documented, non-blocking)

The Standards-Conformance Gate's final run flags **"No Deferrals"** against the B1–B7 Phase-2 migration deferral (CMT-1793). This is a deliberate, reviewer-blessed scoping decision, not abandonment:
- B15 is the *live exploitable bug* (fixed now); B1–B7 changes **no current behavior** (they already block correctly, just in-prompt) and is a ~7-detector architectural migration best done as its own reviewable change.
- The deferral is **structurally anti-abandonment** — exactly what the No-Deferrals/Close-the-Loop standard wants: a minted open commitment (CMT-1793), a frozen `PHASE2_MIGRATION_DEBT == {B1..B7}` allowlist that the ratchet rejects additions to, a stale-allowlist CI test, and a non-placeholder-commitment assertion. It cannot silently rot.
- The **decision-completeness** and **lessons-aware** reviewers — whose explicit charge is adjudicating deferrals — both examined this and judged it an honest Close-the-Loop, not the escape hatch the standard forbids.
- Per the skill, the conformance gate is **signal-only and never blocks convergence**. Overriding the human-judgment reviewers' blessing to chase a re-rolling brittle filter would be precisely the anti-pattern this spec exists to eliminate (let the full-context mind decide; the brittle filter only signals).

## Tracked follow-ups

- **CMT-1793** — Phase-2: migrate B1–B7 to deterministic-detector-emits-signal + LLM-judges-in-context; extend pi-cli awareness; richer agent-state signals (context-% / turn-count).
- **CMT-1794** — post-ship convergent audit (Iterative Audit to Convergence) of both standards across the codebase: every LLM gate whose prompt string-matches, and every gating LLM call that fails open; + the tone-gate availability-aware kind-routing refinement.

## Status

Converged and ready for operator approval. `approved: true` is the operator's to add after reading this report + the ELI16 overview.
