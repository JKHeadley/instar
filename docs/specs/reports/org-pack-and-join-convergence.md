# Convergence Report — Organization pack and joining by invitation

## Cross-model review: codex-cli:gpt-6-astra

A real outside review ran through the agent's Codex CLI (GPT-6 Astra) in all six rounds, run from a freshly built worktree (the agent home's build asks for a retired model). Gemini was not signed in (`gemini-not-authed`).

## ELI10 Overview

An organization like the Monroe Institute wants every colleague's agent to follow its AI policy from the first minute. This spec lets the person in charge write or paste the policy in conversation with their agent, see it read back and tried against everyday requests, and publish it from the Instar app. They then send colleagues a link. A colleague opens it, sees one screen with every line their agent will read, and taps Join in the app. Their agent then reads the rules at the start of every conversation, and its independence is capped.

The safety comes from three things. The organization signs every version with its own key, and the first join remembers that key. Joining, publishing, leaving and accepting a changed policy happen only through a tap in the person's app. And any change to the wording waits for the colleague's yes, because any line can carry an instruction.

What it does not do is also said plainly. It doesn't make "never" rules block actions; that is the next part and needs Justin's yes. And an agent that deliberately misused its own key could still forge an app device, the same trust level as every existing owner-only route, until the trust journey's account-path approval lands.

## Original vs Converged

- **Who can act.** Originally the owner's token was enough to publish or join. Reviewers showed the agent holds that token, so a link in an email could make it join. Now these acts need a request signed by the person's app, and the remaining limit (an agent forging a device) is stated rather than hidden.
- **Meaning of lines.** Originally a "Never" item was copied into the rules as-is, so "Share customer records" could read as an instruction. Now each line keeps its meaning explicitly ("Never: …"), "Ask first" items are their own section that never blocks messages, and unknown headings stay inert text.
- **What reaches the agent.** The join screen now shows every line that reaches the agent, and any later change to the wording waits for the colleague's yes.
- **The key.** Originally the agent's machine key signed the pack; that key rotates and belongs to one machine. Now the organization has its own key, kept on the publishing machine.
- **Honesty about enforcement.** The session text and the join screen used to claim outgoing messages were blocked. That check is off by default, so both now say what is actually running.
- **The cap.** Originally it capped only the profile's name. Now it covers the settings `TrustRaiseGuard.profileRaises` treats as authority, saves the previous values before lowering, and restores them on leave.
- **Durability.** Applying a pack is now a staged transaction (inputs staged, then a marker, then immutable version folders and an atomic pointer) that recovery can always finish, and it never overwrites a hand-edited rules file.
- **Multi-machine.** Packs fan out to the agent's other machines with an ordering tuple, so a delayed join can never undo a newer leave.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 0 (gate)  | Standards-Conformance Gate: ran (9 flags) | 9 | 0 | all four independence levels, reasons for limits, key code, publish disclosure, draft-before-publish, older-version refusal, update backoff |
| 1 | codex 4, internal 5 | 9 | 0 | meaning-preserving lines, Ask First section, org key, fan-out, try-list outcomes, commit order |
| 2 | codex 4, internal 4 | 8 | 0 | person proof, any text change held, cap over effective settings, purpose and other text rendering |
| 3 | codex 4, internal 3 | 7 | 0 | owner-device-only acts (cut from the dark approval path), transaction manifest, unknown-heading escaping, rejoin |
| 4 | codex 4, internal 2 | 6 | 0 | immutable versions + pointer, ordering tuple everywhere, update privacy, stated bearer trust limit, exact cap keys |
| 5 | codex 2, internal 0 (converged) | 2 | 0 | staged bundle before marker, membership outside version folders, one route table |
| 6 | codex 4 (mostly against in-progress code) | 2 spec-level | 0 | authority staged before lowering, peer reconcile path, recovery keeps hand edits |

Internal reviewers ran on Claude Opus 5.5 (this session's model).

## Proportion

Tier 2 (changes agent rules and authority caps; new owner-device routes). Spec about 190 lines; 6 rounds, the Tier-2 cap. Design findings fell each round (9, 8, 7, 6, 2, 2) and moved from the authority model down to file-level durability. Round 3 cut scope (no use of the dark owner-approval path) to stop the authority model from shifting.

## Left behind

None. The round-6 points against the in-progress code (recovery skipping the hand-edit check, the validator not taking raw input, the undo value saved after lowering) were fixed in the code and are covered by unit tests in `tests/unit/org-pack.test.ts` (15/15).

## Full Findings Catalog

See the iteration summary; each round's findings and their resolutions are reflected in the spec sections named there. The round texts are kept in the session's scratch notes (codex rounds `org-codex-r1..r6.json`).

## Convergence verdict

Converged at round 6 (the Tier-2 cap). The internal reviewer found nothing that changes what gets built at round 5; the final outside round's two spec-level points are applied. Spec is ready for approval.
