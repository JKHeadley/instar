# With no owner known, other people's Telegram words no longer teach the agent

<!-- bump: patch -->

## What Changed

SEC-105, a gap left by the SEC-069 fix. `isOwnersOwnWords` returned true for ANY verified Telegram sender when the owner id was undefined, while `getVerifiedOwner()` documents undefined as "no owner is known, never anybody". On an agent with no configured owner, no verified operator, and more than one authorized Telegram sender, a non-owner's words became the owner's learned preferences and fed the Jev correction shadow.

`isOwnersOwnWords` now requires a known owner id for a Telegram row. A new `learningOwnerId(verifiedOwner, authorizedUserIds)` picks the id the learners use: the verified owner, else the agent's ONE allowed sender (a single-person agent with no owner configured), else nobody. `TelegramAdapter.getLearningOwner()` exposes it, and both learners now use it: correction capture and the Jev correction shadow (`src/commands/server.ts`). App messages are unchanged (role `owner`, or the owner's own paired phone).

## What to Tell Your User

- **Only you teach me your preferences**: "If I don't know who my owner is and several people can message me, I no longer learn 'your' preferences from whoever writes. If you're the only person who can message me, nothing changes."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Learning from Telegram needs a known owner (or a single allowed sender) | Automatic |

## Evidence

- Unit: `tests/unit/team-words-not-learned.test.ts` covers an unknown owner counting nobody, and `learningOwnerId` returning the verified owner first, then a sole numeric or string allowed id, then nobody when there are several, none, or the id is malformed. A single-person agent still learns; a second sender does not. `tests/unit/jev-correction-shadow.test.ts` covers an unknown owner with a verified non-owner sender never being classified, and the existing cases now pass the owner explicitly. The source pins in `team-guards` and `team-words-not-learned` follow the new `getLearningOwner()` wiring. Adapter tests cover owner precedence, a single sender, two senders and a second sender added at runtime. Edge cases cover `0`, negative group ids, padded or zero-led strings and duplicates. 105 tests in 3 files pass.
