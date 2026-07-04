# Telegram Conservatism Pass — close the auto-topic bypass

## What Changed

The last-resort flood ceiling that lives inside the one function where Telegram topics are born (`TelegramAdapter.createForumTopic`) is now genuinely universal. Previously it only applied to topics tagged `origin:'auto'`; a bare `origin:'system'` skipped it entirely, and the attention queue used `origin:'system'` for every HIGH/URGENT item — so a stream of "urgent" items could spawn unlimited new topics despite the guards. This was the load-bearing gap behind the operator's most-repeated directive ("be extremely conservative with Telegram; messages should not create their own topics") having the weakest structural follow-through of any critical item.

Now the ceiling exempts only (a) a topic a human explicitly asked for (`origin:'user'`) and (b) a caller that DECLARES its topic is a fixed, create-once one (`bounded: true`). The genuine create-once system topics (Lifeline, Dashboard, Updates, Attention, Agent-Health lane, the flood-notice surface) are marked `bounded: true`; every other origin — including a bare `system` — now rides the same budget as `auto`. Critical (HIGH/URGENT) attention items get a distinct budget label so a lone genuine emergency still gets its own topic, but a FLOOD of them coalesces into the single "notices coalesced" topic (still delivered, still in the attention store) instead of a wall of topics. A new behavioral standard — **Conservative Outbound: Act, Don't Notify** — is added to the standards registry, clearly marked as a PROPOSAL awaiting operator ratification.

## Evidence

- `tests/integration/notification-flood-burst-invariant.test.ts` extended and green (9 tests): a bare `origin:'system'` flood is now bounded (`refused ≥ 188/200`); `origin:'user'` and `origin:'system'+bounded:true` stay exempt; a 1,000-item HIGH/URGENT stream creates `≤ maxTopicsGlobal+4` topics with ALL 1,000 items still in the store and overflow coalesced; the pre-existing lone-emergency-amid-flood case still gets its own topic.
- Related regression suites green: `attention-topic-flood-guard.test.ts`, `AttentionTopicGuard.test.ts`, `PostUpdateMigrator-topicFloodGuard.test.ts`, `sentinel-telegram-integration.test.ts`.
- `npx tsc --noEmit` clean.
- Audit companion: `docs/audits/telegram-conservatism-pass-2026-07-04.md` (full enumeration of every auto-topic / proactive-message path and their conformance).

## What to Tell Your User

Almost nothing changes in day-to-day use — the point is that I create FEWER stray Telegram topics, never more. A genuine emergency still gets its own topic. The difference shows only under a flood: instead of a wall of new topics, a burst folds into one "notices coalesced" topic, and every item is still in your attention list. If you asked for a topic, you still get it. There is one thing for you to decide: whether to ratify the proposed "Act, Don't Notify" standard into the constitution (it's marked as a proposal in the standards registry).

## Summary of New Capabilities

- The auto-topic flood ceiling is now un-dodgeable: no `origin` flag exempts a caller — only an explicit human request or a declared `bounded: true` create-once topic.
- HIGH/URGENT topic creation is bounded under a flood (coalesced, never dropped), closing the "mark it HIGH to dodge the budget" hole.
- A ratifiable proposed standard: **Conservative Outbound: Act, Don't Notify**.
