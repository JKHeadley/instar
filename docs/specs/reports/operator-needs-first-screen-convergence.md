# Convergence report: operator-needs-first-screen

## What this is, in plain words

The operator had to hunt for a button that should have been in front of them. This work puts every state that needs them on the first screen of its page, counts all of them on the home page, and has the outbound gate check that a message sending them to a page carries a link and the on-screen words, from an agent that looked at the page first.

## Iteration summary

Two rounds, stopped at the 80/20 point the brief asked for. Only precision and already-covered items remained in round 2.

| Round | Standards-Conformance Gate | Reviewers | Result |
|---|---|---|---|
| 1 | ran (3 flags) | one combined internal reviewer with the code open (adversarial, security, scalability, integration, decision-completeness, read-list correctness); cross-model Codex (gpt-6-astra) | 11 design findings folded in |
| 2 | not re-run: the flags were addressed by text changes | cross-model Codex (gpt-6-astra) | 2 design findings folded in, 1 precision |

**Reviewer gaps, stated plainly.** The skill's six internal lenses were condensed into one reviewer to fit this change's size. Gemini is unavailable on this machine (`gemini-not-authed`), so the cross-model pass had one family, not two.

## What changed because of review

- A receipt system (a browser tool, a file of proofs, a TypeScript mirror) was cut. No browser ships with instar, so most agents could never produce a receipt, receipts go stale, and they would store links that can hold secrets. Rendering is confirmed through the existing reaction path, recorded as a self-report.
- The signal moved out of the shared gate detectors, where any hit counts as a leak on the outage path.
- Home rows use the action shape Home renders; the first draft would have produced rows with nothing to tap.
- Surfaced rows merge before `combineNeeds`' early returns, and the headline says "Checking in" until sources answer, so "All quiet" cannot paint early.
- Matching a row to a queue item is by identity, not category, so one sign-in cannot hide another account's.
- A 403 on a source no longer signs the operator out. The read list was corrected against the real builders.
- Exemptions are by file and exact phrase, not whole page. The spending need counts only the state the operator owns.

## Left behind, deliberately

- **Machine reach.** `merging`, `approvals` and `secrets` read this machine's stores, the same reach as their pages. Filed to the feedback queue.
- **503 means off.** A reviewer asked for per-endpoint proof. The console treats 503 as switched off everywhere through `get`, and pages say the same thing for the same answer. Changing that is a console-wide question, not this change.
- **Layout in CI.** jsdom has no layout, and the unit lane has no browser. The viewport half was proved by hand at both sizes, with the size cap on text before the need as the CI proxy.
- **Vocabulary floor.** The population floor catches selected words, not every possible phrasing.

## Decision to make

Only the registry wording, asked of the operator in topic 136706.
