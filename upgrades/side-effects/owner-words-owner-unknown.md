# Side effects: no known owner means nobody's Telegram words teach (SEC-105)

## What changes for running agents
- An agent with a configured owner or a verified operator: no change (`learningOwnerId` returns that id first).
- An agent with no owner and exactly one allowed Telegram sender: no change (that sender is used as the owner).
- An agent with no owner and several allowed senders: Telegram messages stop feeding correction capture, learned preferences and the Jev correction shadow. That is the fix. These learners are signal-only, so nothing that already happened is undone, and no message is refused or delayed. The owner can restore learning by setting an owner or by becoming the verified operator.
- An agent with an open allowlist (no `authorizedUserIds`): the first verified sender becomes the verified operator, and so the verified owner (`everVerifiedOperatorUids`). From then on learning continues as before. Only messages that arrive before that first verification stop counting.
- The allowed list is compared as exact strings, the same way `TelegramAdapter.isAuthorized` compares, and duplicates count once. So `[5, "5"]` still names 5, while `" 5 "` or `"05"` names nobody.
- App messages: unchanged.

## Signal vs authority
The learners are signals. This narrows whose words feed them and gates nothing else. The owner-only rules elsewhere (Chief of Staff, approval buttons) already read `getVerifiedOwner()` and are untouched.

## Not changed here
- Skill learning (`SeamFilter` / `SkillLearningSentinel`) admits the topic's verified OPERATOR, not the owner. On a multi-sender agent, a non-owner bound as a topic's operator can still feed skill-learning PROPOSALS. A new skill stays pending until the owner's PIN-gated tap. This is reported back to the security ledger as a separate item.
- The Human-as-Detector link logs every user message as a guardian-miss signal, with no owner gate. That affects metrics only, never preferences.

## Rollback
Revert the commit. No stored data changes.

## Second-pass review
**Reviewer:** independent second-pass subagent (fresh context, read-only). It found nothing blocking. Both learning callers are switched, every other `onMessageLogged` path was swept, and the owner-authority checks rightly stay on `getVerifiedOwner()`. All of its non-blocking notes were taken. The allowed-id match is now an exact string compare like `isAuthorized`, duplicates are removed, edge tests cover `0`, negative group ids, `" 5 "`, `"05"`, `[5, 5]` and `[5, "5"]`, and adapter tests cover owner precedence, a single sender, two senders and a second sender added at runtime. This document was corrected on the open allowlist and on scope.
