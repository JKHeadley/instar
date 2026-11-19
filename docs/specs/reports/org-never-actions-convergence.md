# Convergence Report — Organization never rules check actions, judged by meaning

## Cross-model review: codex-cli:gpt-6-astra

A real outside review ran through the agent's Codex CLI (GPT-6 Astra) in all six rounds. Gemini was not signed in (`gemini-not-authed`).

## ELI10 Overview

When someone's agent joins an organization, its "never" rules should hold for what the agent does, not only for what it says. This spec adds a check before the agent's outward actions: tool calls that send, write or delete, a short list of commands that send data off the computer, and its outgoing messages. A quick keyword check flags likely matches, and one short question to a small AI model judges by meaning. That model is on the same account the agent already uses.

In "observe" mode, the only mode that ships now, nothing is blocked. The agent is told which rule may apply and who to ask, and every judgment is recorded. "Block" mode stops likely breaches with the rule, who to ask and an allowed alternative, and the person can allow an action once from the app. Block mode stays unreachable until Justin says yes. Then it walks the test-agent, Echo and fleet ladder, and must first pass a 60-case evaluation that measures missed breaches as well as false alarms.

## Original vs Converged

- **Judging by meaning.** The keyword match used to decide by itself. Now it is a signal, and the AI judgment decides every check. That judgment has three explicit outcomes, and a breach must name a real rule.
- **Evidence.** It used to be "a compact description". Now it is the content actually being sent, taken from the tool input. Anything not seen in full makes the check "unknown", and identity is the hash of the full content.
- **Failures.** A slow or unavailable check could silently let an action through. Now one 9-second deadline starts at hook entry, and the hook always decides. In block mode an unknown result holds the action for the person.
- **Holding and releasing.** A held action used to have no defined release. Now the person can allow it once in the app, bound to the whole action envelope and consumed atomically. Incomplete evidence can't be allowed once.
- **Cost and privacy.** The spec relied on a shared budget that didn't exist as described. Now it has its own small daily budget, and checks go only to the agent's own provider and account.
- **Honesty.** The spec names what isn't checked: scripts, `git push`, `npm publish`, the contents behind an ID, and a file changing between check and send.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|---|---|---|---|---|
| 0 (gate) | Standards-Conformance Gate: ran (8 flags) | 8 | 0 | keyword as signal only, unknown holds in block mode, cache keyed on request and target, provenance, block-mode ladder, message-path live proof, parent principle |
| 1 | codex 4, internal 2 | 6 | 0 | action evidence, allow-once, unreachable handling, composition, reuse the judge, own budget, deadlines, cheap wrapper |
| 2 | codex 3, internal 1 | 4 | 0 | incomplete evidence, full-content identity, judge adapter, per-command extraction, the person's request as context only |
| 3 | codex 4, internal 0 (converged) | 4 | 0 | envelope-bound allow-once, pending evidence snapshot, three-way verdict, end-to-end deadline |
| 4 | codex 4 | 4 | 0 | no allow-once for incomplete, check-to-send race stated, MCP extraction, labelled evaluation set |
| 5 | codex 2, internal 0 (converged) | 2 | 0 | destination ids versus content references, judge only on the agent's own account, one deadline |
| 6 | codex 2 | 2 | 0 | per-file truncation is incomplete, id-only actions stated, narrowed privacy guarantee |

## Proportion

Tier 2 (new authority to block actions; observe-only until approved). Spec about 100 lines; 6 rounds, the cap. Design findings fell from 8 to 2 and moved from the authority model to evidence edge cases.

## Left behind

None. The final round's two points are applied.

## Convergence verdict

Converged at round 6 (the Tier-2 cap). The internal reviewer found nothing that changes what gets built at rounds 3 and 5. The last outside round's points are applied. Observe mode is ready to build. Block mode waits for Justin's yes, then for its evaluation set and ladder.
