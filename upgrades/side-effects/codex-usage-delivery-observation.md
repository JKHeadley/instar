# Codex usage record delivery observation

Tier 1. One explicit metadata record type and one added line in the existing realistic observer fixture.

- Over-block. Ordinary token usage records no longer make an otherwise valid turn uncertain.
- Under-block. An unknown type, corrupt record, or inconsistent turn still fails closed in the production scanner.
- Layer. The shared Codex rollout parser already handles other recognized metadata. This change adds the exact observed top-level type to that list.
- Signal and authority. The parser emits no delivery signal for usage data. Existing turn and message comparisons supply the evidence, in accordance with docs/signal-vs-authority.md.
- Interactions. The usage record advances the log cursor without changing the active turn. A reply still requires matching message and turn evidence.
- External surfaces. Correct delivery confirmation can settle the message without flagging uncertainty solely because of usage data. No API or log payload is added.
- Multi-machine posture. Each observing machine uses its own installed parser on the rollout available to it. No new replication or ownership behavior.
- Rollback. Revert the allowlist line. This introduces no new storage schema, configuration, or migration.

## Second-pass review

Concur with the review. The independent reviewer checked that the exact type follows the metadata path, the cursor advances without modifying turn state or producing evidence, and the regression exercises the production sweep through the following turn-complete marker. Unknown records retain their current fail-closed behavior.

## Fresh bootstrap follow-up

The exact original candidate durably dispatched a live pilot message, bound its rollout, and then failed on a developer response item named additional_tools. A read-only replay of the revised parser accepted the complete captured rollout. This second metadata exception requires both the exact type and developer role. It supplies no message or turn evidence. The independent reviewer concurred on those boundaries. The regression covers the observed record in a successful turn and refusal for a different role. Fresh signed release evidence remains required.
