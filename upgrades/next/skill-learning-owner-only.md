# Only the owner's own conversations teach the agent new skills

<!-- bump: patch -->

## What Changed

SEC-109, found in the SEC-105 review. Skill learning admitted a Telegram message when its sender was the topic's verified OPERATOR (`SeamFilter.observeTelegram` and the catch-up path, fed by `SkillLearningSentinel`'s `operatorUidForTopic`). A topic's operator is whoever first wrote there from an allowed account, so on an agent several people can message, another person is the operator of their own topics, and their requests could become skill-learning proposals for the owner's agent.

The production wiring (`src/monitoring/skillLearning/wire.ts`) now passes the sentinel an owner-only view of the operator store: `ownerOnlyOperator` returns the topic's verified operator only when that uid is the learning owner from SEC-105 (`TelegramAdapter.getLearningOwner()`: the verified owner, else a single-person agent's one allowed sender, else nobody). No resolver, no owner, an unreadable store, a throwing resolver or a different uid all count as "not the operator", the drop the filter already counts as `not-operator`. The owner is read live, so a later owner change takes effect at once. This change is stacked on #3417 (SEC-105), which adds `getLearningOwner()`.

## What to Tell Your User

- **Only your conversations teach me new skills**: "If other people can message me too, the skills I propose now come only from your own conversations with me. If you're the only person who can message me, nothing changes."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Skill learning admits only the owner's own topics | Automatic |

## Evidence

- Unit: `tests/unit/skill-learning-wire.test.ts` covers the owner's own topic admitted and another person's topic refused; no resolver, an undefined owner and a throwing resolver all refusing; the owner read live (an owner change moves who teaches); a throwing store, a non-string uid, no binding and a zero-led uid refused; `skillLearningEnv` forwarding the adapter's resolver live and naming no owner without Telegram or without the resolver. The existing delegation test now passes an owner. `tests/unit/skill-learning-wire.test.ts` and `tests/unit/skill-learning-seam-filter.test.ts`: 39 tests pass.
