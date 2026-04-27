# Convergence Report — Deferral Detector — Orphan-TODO Patterns

## ELI10 Overview

We have a small "deferral detector" that watches the messages the agent sends to the user. Today, it catches the agent saying "I can't do this, you have to" — basically, when the agent is about to pass the buck. It pops up a checklist reminding the agent to actually try first.

It does NOT catch the *other* shape of the same problem: the agent saying "queue this for next session" or "we can pick this up later" without anything actually backing that promise. Future-self has no automatic memory of unfinished business; promises evaporate between sessions. We caught this happening live on 2026-04-27 — Echo proposed exactly that pattern after shipping Layer 1 of a multi-layer build, and Justin (rightly) called it out.

The fix: extend the detector to also catch "later", "next session", "follow-up", "circle back", and similar phrasings — UNLESS the same message also names real follow-through infrastructure (`/schedule`, `/commit-action`, a same-branch follow-up commit, or a tracked spec). If the agent is already doing it right, no checklist. If the agent is proposing an orphan TODO, the checklist explains what real infrastructure looks like and ends with "`I will get to it next time` is not infrastructure."

The detector remains non-blocking — it only injects a reminder. The agent decides what to do with it.

## Original vs Converged

This spec converged in a single round because the scope is small: ~50 lines of net new template code in an existing hook, no new endpoint, no new state, no blocking authority. The single internal reviewer's main pressure-tests:

- **Signal-vs-authority:** the hook injects context, never blocks. The patterns are brittle regex matches — exactly the brittle-detector shape the principle calls out — but they feed the agent's own judgment rather than a block path. Compliance is clean.
- **False-positive cost:** a missed catch is one orphan TODO. A false catch is a noisy nudge the agent already knows how to handle. Asymmetry favors broader matching with infrastructure-backed anti-triggers as the safety valve.
- **Anti-trigger coverage:** six anti-trigger patterns explicitly listed in §4b. The list covers the four legitimate follow-through mechanisms (`/schedule`, `/commit-action`, same-branch commit chain, tied-to-existing-spec). Edge case: an agent using a creative paraphrase of "I'll schedule a remote agent" without naming `/schedule` would still get the checklist. Acceptable — the checklist names the slash command, prompting the agent to use it explicitly.

No design changes from initial draft to converged. All review notes were minor wording adjustments to checklist text, all applied.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1         | (none)                | 0                 | (converged) |

The single internal pre-spec self-review captured the design in §4 directly. No iterative round needed because the design is structurally bounded by the existing hook contract.

## Full Findings Catalog

None. The detector is constrained by the hook contract (`PreToolUse` non-blocking), the false-positive cost is bounded (a noisy nudge), and the anti-trigger coverage was correct on first pass.

## Convergence Verdict

**Converged at iteration 1.** No material findings. Spec is ready for principal review and approval.

The pre-commit gate requires `approved: true` in the spec frontmatter. That tag is the user's structural contribution to the process.
