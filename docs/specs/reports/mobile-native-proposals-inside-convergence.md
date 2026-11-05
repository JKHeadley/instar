# Convergence Report — Native Proposals and How I'm doing inside screens

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-tier pass ran through the agent's codex CLI on all 6 rounds, each on a changed spec and module. A Claude clean-door pass (`--family claude-code`, not cross-model) ran on rounds 1 and 2. Gemini was not authed on this machine. This run was a worker that could not spawn the separate internal reviewer subagents, so the review rests on those two external doors, with the spec's security, multi-machine and decision-point lenses covered through their findings and the module read alongside the spec.

## ELI10 Overview

The Instar iPhone app gets two more native screens. **Proposals** lists the fixes the agent suggests after meeting a new kind of failure. **How I'm doing inside** shows recent records, repeating problems, checks on the agent's own claims, and correction reviews, for each machine that answers. Both only look; only the owner's phone or the agent itself can open them.

The tradeoff is a small amount of traffic between the agent's own machines, and a few things that stay in the dashboard: dismissing a proposal, session bindings, older problem history and the memory lookup.

## Original vs Converged

Almost every finding had the same shape: a bad read could look like good news. Now:

- **A bad read is never "none".** Wrong shapes, all-malformed lists and failed reads say "can't tell", with empty counts rather than zeros.
- **A failed machine list is not "no machines".** The answer says the other machines couldn't be checked.
- **Other machines aren't taken at their word.** Their headline, tone, sentences and claim numbers are rebuilt here from checked data. A section claiming "ok" without its numbers reads unavailable.
- **All clear needs a measurement.** With checks off, or only unverifiable claims, it doesn't say all clear. Any unread machine scopes the headline.
- **Counts are true.** The proposal count survives the row cap, counts a shared proposal once, and says "at least" past its limit.
- **Settled problems stay settled.** One fixed long ago doesn't read as "came back".
- **Failures are visible.** Wrong-shaped reads are recorded as degradations, so the graduation metric means something.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Spec changes |
|-----------|-----------------------|-----------------|--------------|
| 1 | codex, clean-door | 10 | shape checks, peer-read failure state, true counts, claims and tone rules |
| 2 | codex, clean-door | 7 | peer counts required, peer sentences dropped, null aggregates, degradations on wrong shape, dedupe, insight limit |
| 3 | codex | 3 | key union, review counts required, week and peer subsection reporting |
| 4 | codex | 3 | floor count, all-malformed lists, week gap scopes headline |
| 5 | codex | 3 | malformed checks in every source, peer claim numbers recomputed, per-peer reporting |
| 6 | codex | 2 | typed malformed check, peer keys must account for the count |

Standards-Conformance Gate: unavailable: the route refuses a spec outside the agent home's own docs/specs (`specPath escapes specsDir`) on every round.

## Remaining issues

Round 6 still returned SERIOUS ISSUES; this report does not claim a clean round. The run stopped at the Tier 2 cap of 6. Both round-6 findings were fixed with regression tests. A clean-door read of the side-effects review then returned MINOR ISSUES with two design points (a failed peer review reading "Reviewed", and version skew reading as clean); both were fixed with tests, and the result went back for one more read recorded in the side-effects artifact. Findings had narrowed from design gaps to malformed-input edge cases between machines of the same agent, and each change is read-only, so a revert is the rollback. The dev-agent-live check in the spec's maturation plan is still to run after release.

## Operator decision

No operator decision needed. Approval is recorded in the spec under the operator's standing request for native screens; no constitution change.
