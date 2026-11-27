# Convergence Report — Organization members page, departure and a second policy keeper

## Cross-model review: codex-cli:gpt-6-astra

A real outside review ran through the agent's Codex CLI (GPT-6 Astra) in all six rounds, beside an internal reviewer that read the spec against the org-pack code (`OrgPack.ts`, `OrgPackStore.ts`, `OrgPackUpdater.ts`, `orgPackRoutes.ts`).

## ELI10 Overview

An organization can already share its AI policy and invite colleagues. This adds three things. First, a page where the admin sees each colleague's agent, which policy version it runs, and when it last checked in. Second, a way to mark someone as gone: their app asks them once whether to remove the policy, and nothing is removed without their tap. Third, a second person, the keeper, who can propose new versions. The organization's main agent checks each proposal and signs it, so colleagues' agents only ever trust one key. The recovery copy for a lost Mac was split into its own spec.

## Original vs Converged

- **Keeper trust.** Originally keepers signed versions themselves and members trusted keeper keys. Now keepers propose, and the organization's agent countersigns with the organization key. Members' checks are unchanged, a new joiner can verify a keeper's version, and a keeper (or a former one) can't hand members a version directly.
- **Who can appear on the page.** Originally any key could check in. Now a new key needs an invitation token, used once per key and revocable. Names are one plain line, labelled as reported.
- **Membership states.** The early wording left removal, leaving and rejoining undefined. Now an explicit transition table governs them: a removed person comes back only through the admin's restore, and a lost rejoin is retried until acknowledged.
- **Replay and rate limits.** Replays are refused using the member's own last accepted time. Rate limits run in two lanes, per known key and per address, and only trust the tunnel's client-address header.
- **Recovery copy.** It took most of the findings in every round, because a lost key can't be fenced if the old machine might come back. It was cut out at round 5 into `org-recovery-copy` so the rest could ship.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Spec changes |
|---|---|---|---|
| 1 | codex 4, internal 11 | 15 | countersigning, invitation tokens, removal ids, file locations, key copy to peers |
| 2 | codex 6, internal 10 | 16 | token resend, membership states, registries in the copy, the version jump, stolen-key path, rate-limit lanes |
| 3 | codex 4, internal 9 | 13 | full schemas, validateBundle before countersigning, publishedBy from keepers.json, keeper base, in-process lock |
| 4 | codex 4, internal 6 | 10 | transition table, draft base from published, forwarded client address, maxmem |
| 5 | codex 4, internal 7 | 11 | recovery cut out; removed-and-left, capacity on every move into joined, name rules, peer copy of rejoin state |
| 6 | codex 3, internal 7 | 10 | restore-only return after removal, whole removed records, rejoin after any join, address checks on outgoing calls, consent for existing members, key lanes |

## Proportion

Tier 2, because it adds a public check-in route and a second person who can change every member's rules. The spec is about 120 lines; it ran 6 rounds, the cap. Findings fell from 15–16 to 10. After recovery was cut, they moved from authority and trust to edge cases in the state table and rate limits.

## Left behind

None. Every round-6 point is applied. The recovery copy is a scoped cut, tracked as its own spec (`org-recovery-copy`) in the 143810 run.

## Convergence verdict

Converged at round 6, the Tier-2 cap, with every finding applied and the hardest area (recovery) cut into its own spec. Ready to build.
