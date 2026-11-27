# Convergence Report — The 1.x registry and the 2.0 rule book stay aligned on every update

## Cross-model review: codex-cli:gpt-6-astra

A real outside review ran through the agent's codex CLI on all five rounds. Gemini is not installed on this machine, so there was one external family, not two.

## ELI10 Overview

Instar has two written copies of its rules, one for 1.x and one for 2.0, and nothing keeps them together. Justin asked for a fundamental requirement that they always match. This adds that rule to both books. Every change to either book now has to name its matching change in the other, or say why it has none. A daily check catches anything that slips through and repairs it first.

It also adds a plain map of how the two books differ today. A first read found that about half of the 1.x rules match, 41 differ, 44 exist in one book only, and 8 of the differences are clear conflicts. Those go to Justin separately as one sheet of wordings.

The main tradeoff: a real rule change now costs two approvals, because the books sit in two protected repositories. And in the 2.0 repository the check only shows red; it cannot physically stop a merge without an admin setting nobody is asking him to change, so the daily check is the backstop there.

## Original vs Converged

Originally this was a ledger holding a fingerprint of every rule, with build checks refusing any mismatch. Review showed several things wrong with that: a red check doesn't block a merge in either repository, the fingerprint covered a hand-picked list of clauses with obligations falling outside it, it needed its own state machine for the window between two merges, and every ledger edit would have needed Justin's approval. It would also have read as proving two wordings mean the same when it proves only that text hasn't changed.

The converged design drops the ledger. Scope is simply the files, so every update counts and nothing can be smuggled past a clause list. Pairing is one line in the PR. The merge tool refuses in 1.x, and a daily job reads GitHub's own history, with GitHub as its only state. Later rounds moved the job from a gate to a script job, because a gate that crashes reads as clean, and added a real repair path that doesn't do the work twice. The landing order changed so nothing is sent for approval until no later push can dismiss it.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | security, adversarial, integration, lessons, decision-completeness, verify-state, external | 19 | 9 | Hash ledger removed; design rewritten |
| 2 | integration, adversarial, decision-completeness, external | 9 | 6 | Script job, per-repo baselines, repair path, facts corrected |
| 3 | adversarial, integration, decision-completeness, external | 6 | 4 | Temp-file run, token source, `overdue` and `no-pr` classes |
| 4 | external | 3 | 1 | Map row on `none:`, spawn dedupe, failure handling |
| 5 | internal, external | 2 | 6 | Facts corrected without a further round |

Standards-Conformance Gate: round 1 ran (1 flag); round 2 ran (2 flags: Signal vs. Authority, Self-Hosting; both answered in the spec); rounds 3 to 5 not re-run, because the body changes did not touch either standard's subject.

Internal reviewers ran on the session's model, claude-opus-5-5, in all rounds. Rounds 2 to 5 ran the six lenses in one or two combined agents rather than one agent each, in proportion to the change.

## Proportion

Tier 2. Spec about 230 lines. Five rounds of a cap of six. Three rounds would have been proportionate for the rewrite alone; the extra two each corrected a factual claim about the system.

## Left behind

- Round 5 external: the plain-language twin exception for the rule book has no cited authority. The instar-2 review of the PR settles it; adding a twin costs one file if asked.
- Round 5 external: a simpler alternative with no script at all (review only) is not separately argued in Frontloaded Decisions. It is the failure already observed, which the problem statement covers.
- A PR body edited after merge can mislead the daily read. Accepted in the spec.
- A duplicate run in the gap before the first write leaves two visible PRs. Accepted in the spec.
- The agent can edit its own checks. Accepted and stated; the code-owner tap is what holds.
- Rule 119's exact 1.x clauses (`Fails`, `In practice`, `Earned from`) are written at build, against the wording in the spec. They go through his review on the PR.
- instar-2 #185 may collide on rule numbering; re-checked at landing step 4.

## Full Findings Catalog

**Round 1.** Security and adversarial: checks block nothing; failure-mode claim false; `counterpartPr` unbound; master-only edits pass; `version-specific` sticky; clause allowlist has gaps; net-count ratchet; no clock for 48 hours. Integration: landing order can't run with stale-review dismissal; area audits missing on #2687; CI Health won't surface a daily red; clause set misses obligations. Lessons and decisions: no path for a same-obligation master edit; every ledger edit a tap; conflict sheet undecided; `aligned` uncorroborated. External: direction guard; mutable PR head; ratchet; coverage; removal fallback. Resolution: ledger removed, design rewritten.

**Round 2.** Internal: gate cannot classify; job and script location; statelessness contradicted; repair cannot clear drift; three factual errors; new refusal slug. External: direction guard; per-repo baseline; recovery state; `paired` needs validation; backlog visibility. Resolved in the spec; the guard claim answered by `evaluateOperatorReviewApproval` in `scripts/standards-direction-guard.mjs`.

**Round 3.** Internal: pipe exits 0 silently; `gh` unauthenticated in script jobs; repair statement false after 48 hours. External: guard evidence; repair and overdue; dedupe; direct commits. Resolved.

**Round 4.** External: `none:` could bypass the map; idempotency before the first write; failure handling contradicted itself; twin omitted. Resolved, twin addressed in Left behind.

**Round 5.** Internal: script-job result line; map row for instar-2 changes. External: map row; pagination and one row per PR. Resolved by small edits. Precision items corrected in the same pass.

## Convergence verdict

Converged at round 5. The final round's two design-class items were factual corrections, fixed in place, that change no architecture. Items above are left behind. The spec is ready for operator review of the constitution wording.
