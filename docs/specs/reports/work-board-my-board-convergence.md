# Convergence Report — Work Board: My board

## Cross-model review: codex-cli:gpt-6-astra

GPT 6 Astra reviewed the spec through the codex CLI in both rounds (round 1: three design findings; round 2: none). Gemini was not signed in on this machine (`gemini-not-authed`), so the Gemini family did not run. The Anthropic clean-door family was available but not used.

## ELI10 Overview

The Work Board holds a card for each thing the agent needs a person for. Until now the board sorted cards into lanes by whose move it is. This addendum adds "My board": the board read also says which cards need the person reading it and why, in five fixed lists (approval, reply, your cards, cards you were added to, held), each card once, untouched cards first. It copies Luna's working board, which Justin asked us to match.

Nothing is stored and no rule changes. The lists are worked out from the same cards on every read, a team member only ever sees lists built from cards they could already see, and an app talking to an older agent keeps drawing lanes.

## Original vs Converged

- The waiting lane's soft cut now breaks equal-time ties by card id, so every machine cuts the same cards (codex, round 1).
- The owner's "Your cards" rule is exactly "the rest of his Waiting-on-you lane"; a redundant carrier test was dropped from the code so it matches (codex).
- The multi-machine claim was corrected: sections follow each machine's lanes, which already depend on the reader's clock (quiet cards) and that machine's capacity-wait state (internal review).
- Clients show a section's "N more" as text; the Needs-you list reads the board in full, so cut cards stay reachable (internal review + conformance gate).
- Frontloaded decision 7 records that "added" means every open card shared with a member in phase 1.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | codex (3), integration + decision-completeness (2); Standards-Conformance Gate: ran (1 flag) | 5 | 7 | tie-break, owner rule, solo-owner rule, multi-machine wording, `more` handling, FD7 |
| 2 | (converged) codex 0, internal 0; Standards-Conformance Gate: ran (2 flags, both the pre-existing `softOpenCards` cut, answered in §2) | 0 | 7 | precision one-liners only |

Internal reviewers ran as one Claude subagent per round covering all six lenses (session model: Opus 5.5).

## Proportion

Tier 1 (read-only view): ~70 lines of server code, one awareness entry, one unit file plus three route assertions; 2 of 3 rounds used.

## Left behind

- Needs-you and Projects reads also compute `myBoard` (harmless, unused there).
- Luna's held rule shows a held card only to people on it; ours shows the owner every held card (noted in §3).
- Member "reply"/"own" stay empty in phase 1 (noted in §3).
- Archived rendering stated in §4.
- Baseline vs proposed wording clarified in §1.
- Test list extended (hold precedence, solo owner).
- Conformance gate flags on `softOpenCards` (Judgment Within Floors, Dashboard UX drill-down): the cut is the approved judgment-candidate from `work-board-asks.md`; its drill-down is the Needs-you list (full read). Not changed here.

## Full Findings Catalog

Round 1 — codex DESIGN: tie-break before the cut (fixed in `boardJson`); owner carrier branch broader than spec (code narrowed); null identity broadens reply (documented as defensive). Internal DESIGN: multi-machine wording wrong (rewritten); client handling of `more` undefined (stated). Conformance gate: soft cut boundary (answered). Precision: member `more` test, Needs-you computes it, FD3 phase-1 note, added = shared (FD7), held divergence, invariant test (added).

Round 2 — codex PRECISION: archived rendering, baseline wording, test list. Internal PRECISION: solo-owner branch defensive, member sections empty in phase 1, clients drop the waiting lane, `more` sum holds for any viewer. Conformance gate: two flags on the pre-existing cut. All folded in as one-line edits.

## Convergence verdict

Converged at round 2. The final round found nothing that changes what gets built; 7 items left behind as listed. Ready for approval.
