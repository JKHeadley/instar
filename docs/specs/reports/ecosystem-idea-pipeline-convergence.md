# Convergence Report — Ecosystem idea pipeline

## Cross-model review: codex-cli:gpt-6-astra

A real outside review ran through Codex in all three rounds. Gemini and Grok are not available on this agent, so this is one outside family.

## ELI10 Overview

Other projects keep finding things Instar could use, but we only look when someone remembers to. This adds a weekly review of a short list of similar projects. It pulls out their ideas, checks whether we already have them, checks them against Instar's goals and the Instar 2.0 purpose, and gives the operator a ranked list on a phone.

The operator's concern shaped it: nothing should cost quality or coherence, and a smaller number does not show that it doesn't. So the default outcome for any idea is that nothing changes. An idea that takes something away from agents has to pass a pre-planned, blind trial on real work before it can be switched on by default beyond one development agent.

It builds nothing and contacts no one. It runs on maintainer agents first, with spending limits.

## Original vs Converged

- **Scanner shape.** Originally a scheduled job session with "no credentials and one writable file". Review showed that claim was false for a job session, which carries the auth token and skips permission prompts. It became a server service: trusted code does all fetching and reading, and models only judge packets.
- **"Tool-less" was assumed, then tested.** Only Claude has a real no-tools mode. A framework is now admitted only after two probes on that machine, through the same path real calls use. One asks whether the model obeys an injected instruction, the other whether it can read a planted file at all. Codex may be refused, in which case ideas stay single-family and cannot reach the top band.
- **The burden stopped at the pipeline's edge.** Nothing enforced the evidence rule after a spec started. Now reports are committed files, bound to the tested commit and scope, and a lint refuses a default change without one. The spec states what that lint cannot see.
- **The proof was weak.** "No difference observed plus a degraded control" became non-inferiority against a pre-registered margin, with reviewed margins, a stopping rule, a fresh confirmatory run after any failure, and the wording "bounded evidence, never proof of zero loss".
- **A pipeline that never adopts anything was invisible.** It now shows a funnel always, audits a monthly sample of what it stopped, weighs the cost of not adopting, and raises one item after 8 quiet weeks.
- **The bias is not absolute.** "Starting a spec" is no longer reserved for the operator, because no rule requires that and the purpose says a limit must name its rule. Adoption stays held by the evidence rule. Capability-reducing ideas now have a route out, through a development-only spec.
- **Storage, recall and message routing** were all corrected against the real code: a replicated store rather than a vague "state sync", a dedicated search index rather than the shared recall database, and PIN decisions rather than console bearer calls.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|---|---|---|---|---|
| 1 | security, adversarial, integration, decision-completeness, lessons-aware, codex | about 30, many duplicates | 8 | Rewritten around a server service. Standards-Conformance Gate: ran (4 flags, then 5 on the rewrite) |
| 2 | security, adversarial, integration, decision-completeness, codex | about 15, many duplicates | 12 | Framework probes, dedicated index, committed evidence, stages, budget. Standards-Conformance Gate: ran (3 flags) |
| 3 (cap) | security, adversarial, integration, codex; decision-completeness and lessons-aware found none | 6 | 7 | Capability probe, one invocation path, flagless reductions, 8-week notice, storage path, evidence bound to commit, launch intent. Standards-Conformance Gate: ran (2 flags on the final text: the probe's limit, now stated, and the quiet notice, now given an action) |

Reviewers ran on the session's model, `claude-opus-5-5`; the outside review on `gpt-6-astra`.

## Proportion

Tier 1 by the revert test (a revert removes it, and it ships limited to maintainer agents). Spec of about 300 lines, 3 of 3 rounds used. ⚠ That is heavy for Tier 1, and the first draft's core safety claim was false, which is why.

## Left behind

- A newly promoted holder treats replicated decision rows as records from its own machines; the build should say so where it reads them.
- Token limits are estimates and may need retuning in the first weeks.
- Two blind reads corroborate one another and are not independent proof; the spec says this.
- The E2E needs a test-only exception to https-only; included in the spec.
- Attention items use fixed-template text; included in the spec.
- Feedback triage shares the provider and may share the file-read exposure. Sent to the feedback queue, not fixed here.

## Full Findings Catalog

Round 1 findings were grouped into: job-session isolation false; off-Claude job routing not live; burden unenforced downstream; additive-dark laundering; `passed` not actually structural; trial gaming; no runner; unbounded `unproven`; invisible non-adoption; floor taxing added capability; ranking rewarding novelty; nested instruction files; shallow-clone diff; unnamed state carrier; unnamed decision surface; cost controls missing; self-heal missing; seed identities missing; second read not blind; non-inferiority missing. All addressed in the rewrite.

Round 2: tool-less false off Claude; `SemanticMemory` wrong index and exposure of private memories; lint cannot read ledger-held exceptions; budget too small with no quota pause; no actor for starting a spec; class gaming; reductions deadlock; unreviewed margin; expired exception did nothing; repeat attempts; hardened git config lacked claimed settings. All addressed.

Round 3: canary tested obedience rather than capability; canary path different from real calls; flagless reductions; silent stall; index riding git sync; evidence not bound to the implementation; session launch not deduplicated. All addressed in the final edit.

## Convergence verdict

Converged at the round cap, without a clean quiet round. Each round found fewer and narrower design issues, and every design finding raised was addressed, including the safety ones. **The final edit after round 3 was not itself re-reviewed.** Its changes are narrow and stated above. Decision-completeness and lessons-aware found no design issues in round 3. The spec is ready for the operator to read and decide.
