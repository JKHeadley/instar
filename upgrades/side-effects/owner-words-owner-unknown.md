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

## Follow-up after Local Verify (2026-11-22)
The first full run (head 995242067, merged with main ecdfa223a) failed five end-to-end cases in `tests/e2e/jev-correction-shadow-lifecycle.test.ts`. Line 81 pinned the old wiring line (`telegram.getVerifiedOwner()`). The other cases built a `TelegramAdapter` with no owner and called `shadow.observe(entry)` with no owner id. Under this change that correctly means nobody's words count, so the shadow never checked anything. This is the fix working, not a defect. The fixtures now wire the owner the way `server.ts` does: the adapter allows one sender (4242, the sender of the test messages), and the fixture calls `observe(entry, adapter.getLearningOwner())`. The line-81 check now expects `getLearningOwner()`. Two new end-to-end cases prove the rule: with no allowed-sender list and no verified owner, and with two allowed senders, a development agent makes no check (`checks: 0`, no vendor call). `tests/integration/jev-correction-shadow-routes.test.ts` had the same owner-less fixture and got the same wiring before it could fail. No assertion was loosened and no product code changed. The branch was also brought up to date with main by a merge.

## Second follow-up (2026-11-22, targeted end-to-end run)
The lifecycle file's new "no owner known" case failed: it expected no vendor call and saw one. The cause was the test, not the product. The helper's last parameter defaulted to `[4242]`, and passing `undefined` explicitly takes the default in JavaScript, so that case ran with 4242 as the one allowed sender and a check correctly ran. The parameter now takes `null` for "no allowed-sender list", so the case really has no owner. No outside address was reached: the "vendor call" is the test's own mocked `fetchImpl`, which records the vendor URL it was given. The two-sender case was already correct. No assertion was changed.

## Second-pass review
**Reviewer:** independent second-pass subagent (fresh context, read-only). It found nothing blocking. Both learning callers are switched, every other `onMessageLogged` path was swept, and the owner-authority checks rightly stay on `getVerifiedOwner()`. All of its non-blocking notes were taken. The allowed-id match is now an exact string compare like `isAuthorized`, duplicates are removed, edge tests cover `0`, negative group ids, `" 5 "`, `"05"`, `[5, 5]` and `[5, "5"]`, and adapter tests cover owner precedence, a single sender, two senders and a second sender added at runtime. This document was corrected on the open allowlist and on scope.

**Follow-up review (2026-11-22): CONCUR.** A fresh Claude Sonnet subagent, read-only, traced every end-to-end and integration case by hand. It confirmed that the owner-less fixture was the root cause of all five failures. A bare adapter has no verified owner, and `authorizedUserIds` does not change how inbound messages are logged. Each case now passes for the right reason: the new no-owner and two-sender cases make no check. No assertion was loosened, the wiring matches `server.ts`, and no other test relies on "no owner means anyone".
