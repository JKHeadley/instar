# Convergence Report — Recommended outside services

## Cross-model review: codex-cli:gpt-6-astra

Ran in all six rounds. Gemini and Grok were not available on this machine. The Anthropic clean-door read did not run.

**Exit state: not converged at the 6-round cap. The final round raised safety findings, so this report goes to the operator, and no convergence tag has been written.**

## ELI10 Overview

This spec makes a list of outside services an agent benefits from, offers each one to new users, saves the answer, and has the agent do all the setup after a yes. After a no, the agent uses judgment about asking again, with firm limits behind it. It also names where a service has no real backup yet, and treats building those backups as separate work that must finish before the operator's first request is met.

## Original vs Converged

- **A yes.** Originally a button anywhere. Now a page only the owner can confirm, because any part of the agent could otherwise claim a yes.
- **The store.** Originally more fields on the existing feature system. Now a small separate record, because that system could erase a no, can't move choices between machines, and marks default-on features as already accepted.
- **Already in use.** Originally counted as a yes. Now a plain fact that grants nothing.
- **Re-offers.** Originally real problems only. Changed by operator direction to judged re-offers on real problems, changes that matter, and cool-offs, inside code limits. The judge starts in practice mode until it beats simply not asking.
- **A no to something running.** Now separated from refusing offers, checks the owner and the mesh aren't left stranded, and stops GitHub pushes immediately.
- **Setup.** The agent owns it fully until proven working, by operator emphasis.
- **Backups.** Now marked `exercised`, `specified` or `gap`, so a written-down backup can't pass for a tested one.

## Iteration Summary

Reviewer model: the authoring session's model (Opus 5.5). Rounds 1 used three subagents covering the six lenses, and rounds 2 to 6 used one subagent covering all six, which is less separation than the skill describes.

| Round | Design findings (internal + external) | Spec changes | Standards-Conformance Gate |
|---|---|---|---|
| 1 | about 40 + 3 | Full rewrite | ran (2 flags) |
| 2 | 9 + 3 | Separated in-use, merge rule, interim proof, rollout prerequisites | ran (1 flag) |
| 3 | 7 + 3 | Token store, owner button limits, merge identity. Operator direction on re-offers arrived here | ran (1 flag) |
| 4 | 6 + 3 | Judge floor, shadow phase, ignored re-offers, reason categories | ran (1 flag) |
| 5 | 6 + 2 | Mesh and GitHub no, imports, grants | ran (3 flags) |
| 6 | 8 + 3 | Fixes below | ran (2 flags) |

## Proportion

Tier 2. 6 of 6 rounds used. The spec grew from about 9 KB to about 32 KB, so it should be split at build time if a phase can stand alone.

## Left behind

See `## Left behind` in the spec.

## Fixed after the last review, not re-reviewed

Round 6's findings were edited into the spec, with no later round to check those edits:

- Legacy imports excluded from merge and reconciliation
- GitHub no stops pushes at once on a mesh
- Unknown running state holds until page confirmation
- Refusal separated from shutdown authority
- Token minted on page open
- Model-free address setup when every door is down
- Recipes refuse stored credentials

## Decided by the operator, 2026-11-03

Both items below were put to the operator, who answered in topic 135786: "I'm saying yes to everything you're recommending and approved you to move forward here." The operator also directed that a person only ever approves decisions or supplies credentials, and the spec's setup section was changed to say so. That edit has not been reviewed either.



1. **Interim approval proof.** The standards check flagged this in every round from 3 onward. Until owner proof ships, a yes uses a PIN the agent can read. That stops mistakes and confusion, not a deliberately hostile agent.
2. **Whether to start the build** with round 6's fixes reviewed during the build.

## Convergence verdict

Not converged by the round rule, and proceeding by operator decision. Review was still finding design issues at the cap, though they had narrowed from about 40 to about 11. The spec's main shape stopped changing after round 4.
