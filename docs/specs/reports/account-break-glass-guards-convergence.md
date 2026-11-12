# Convergence Report — Account break-glass guards

## Cross-model review: codex-cli:gpt-6-astra

GPT-6 Astra (through the Codex CLI) reviewed rounds 1 to 6. In round 1 the first attempt failed, because the agent home's stale September build asked for the retired gpt-5.5 (fb-4eeaecec-cd2); the rerun through the current install succeeded. The Anthropic clean-door second read (Fable) returned `degraded` in round 1 and was not rerun.

## Verdict: NOT CONVERGED at the round cap (6 of 6)

The last round still found design issues, two of them safety-related. All four are fixed in the spec, but no further round has reviewed the fixes. Per the skill, safety findings at the cap go to the operator. The convergence tag has **not** been written. The decision for Justin: accept the spec as fixed, or allow one more review round.

## ELI10 Overview

On 11-07 and 11-11, Echo made a run of mistakes on Justin's npm account. It spent a one-time recovery code, which put the account on a 72-hour hold. It also missed the saved instructions sitting next to a key that would have worked. The warnings existed, but they never reached the agent at the moment it acted.

This spec puts the warnings in front of the agent at that moment:
- A pop-up on any page that is about to receive a recovery code, with the cost.
- A credential's saved instructions printed whenever the credential is read.
- The page check running on every browser route agents use, including hand-written scripts.

It is aimed at an agent that is confused, which is what happened. It does not try to stop an agent that is deliberately working around it; that needs a bigger design, listed as a follow-up.

## Original vs Converged

- **Original:** five guards. Reading a recovery code needed approval, notes printed with every credential, the full page was read before any account submit, a recovery obligation followed any recovery-code use, and a routes list was required before asking the operator.
- **Round 1** moved authority from reading a code to submitting it. The reason: the harm comes from the submit, and reads are easy to route around. It also found that printing "notes" would print secrets, since Bitwarden secure notes are the secret itself.
- **Round 2** showed that a check inside a web page cannot be real authority, because an agent can go around it. Findings were not falling (about 30, then 15), so the spec was cut to the confused-agent scope with three guards, and the rest became follow-ups F-A to F-D.
- **Rounds 3 to 6** fixed how the pieces actually work:
  - The hold is a new init script that asks before the site sees the event, and never replays it.
  - Playwright MCP gets the hold through its documented environment variable, including on Codex.
  - The launcher owns the dialog, with single-use, account-bound allowances.
  - Instructions come only from a dedicated field, read by a new agent-facing Bitwarden item reader.
  - Rollout follows the maturation ladder.

## Iteration Summary

| Round | Reviewers | Design findings | Left behind | Spec change |
|---|---|---|---|---|
| 1 | security+adversarial, scalability+integration, decisions+lessons, GPT-6, gate (2 flags) | about 30 | a few | authority at the submit; notes redefined |
| 2 | same three, GPT-6, gate (5 flags) | about 15 | 4 | cut to confused-agent scope |
| 3 | combined six-lens reviewer, GPT-6 | 9 | 6 | new init script, MCP variable, no notes |
| 4 | GPT-6, gate (3 flags) | 6 | 0 | launcher-owned dialog, notes pointer, ladder |
| 5 | GPT-6, gate (3 flags) | 6 | 0 | synchronous ask, single-use allowance, hook migration |
| 6 | combined six-lens reviewer, GPT-6, gate (1 flag) | 4 (2 safety) | 6 | Bitwarden item reader, Codex env_vars, per-dispatch mark, page account |

Internal reviewers ran as Claude Opus 5.5 subagents. Rounds 1 and 2 grouped the six lenses into three reviewers; rounds 3 and 6 used one reviewer that covered all six.

## Proportion

Tier 2 (security-sensitive). The spec is about 140 lines, and the round cap of 6 was used in full. ⚠ That is a lot of review for three guards. The early rounds reviewed a much larger design that was later cut.

## Left behind

- Gate flag repeated in rounds 5 and 6: default dismissal gives the detector blocking power. Answered as the floor of a judgment-candidate, with the agent as arbiter. Accepted.
- `@playwright/mcp@latest` is not pinned, so the variable should be rechecked at each version.
- Cross-origin iframes are not covered.
- Login items whose value an earlier `set()` wrote into `notes` need a cleanup note.
- Plain `bw get item`, unlabelled code fields, single-page `fetch` sends, and hand-started sessions are not covered. Each is stated in the spec.
- A profile can hold several accounts; the wording says "one of the profile's bound accounts".

## Full Findings Catalog

Each round's findings are recorded in the spec's "Standards-Conformance Gate" section, with what was changed in answer. The raw reviewer outputs are in the session transcript of 2026-11-11 (Echo, topic 130715).

## Convergence verdict

Not converged. The cap was reached at round 6 with two safety-related design findings, both fixed but not re-reviewed. Waiting on Justin's decision.
