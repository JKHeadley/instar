# Convergence Report — Telegram privacy + Forum + topics + intros

## ELI10 Overview

v1.2.18 got Codex to walk through Telegram setup conversationally
end-to-end. But the resulting bot+group combination didn't
actually work for messaging — three root causes verified directly
against the Telegram Bot API and the screenshot Justin sent.

This PR adds three new steps to the Codex prompt: disable bot
privacy mode via BotFather, enable Forum/Topics mode on the group
via Telegram Web UI, then create the 4 canonical system topics
(Lifeline / Updates / Dashboard / Attention) via Bot API and seed
each with a friendly intro message. Each new step has an
explicit failure sentinel for fast-fail to the manual backstop.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1         | self + Justin's retest screenshot + getMe direct probe | 3 | new steps 10/12/13/14, lifelineTopicId in config |
| 2         | (converged)           | 0                 | none |

## Full Findings Catalog

**Finding 1 — Bot privacy mode left ON.**

- Verified via `bot<TOKEN>/getMe` direct probe:
  `can_read_all_group_messages: false`.
- Severity: critical (messaging completely broken).
- Resolution: new step 10 drives /setprivacy → Disable in
  BotFather, verifies via getMe, fast-fails on failure.

**Finding 2 — Group is basic, not supergroup with Forum mode.**

- Verified via chat.id pattern (-5154496235, no -100 prefix).
- Server's `ensureLifelineTopic` / `ensureDashboardTopic` etc.
  fail silently on basic groups → no system topics ever created.
- Severity: high (organized messaging surface impossible).
- Resolution: new step 12 drives Telegram Web UI to enable
  Topics on the group, re-fetches new -100-prefixed chatId via
  getUpdates, fast-fails on failure.

**Finding 3 — No system topics, no agent presence.**

- The Claude wizard creates Lifeline + greets the user there.
  Codex path skipped this entirely.
- Severity: medium (functional bot but no UX, no "agent comes
  alive").
- Resolution: new steps 13 + 14 create the 4 TOPIC_STYLE-aligned
  topics via createForumTopic, seed each with a first-person
  intro via sendMessage. Step 15 persists lifelineTopicId in
  config so server's `ensureLifelineTopic` reuses it.

## Convergence verdict

Converged at iteration 2. Three scoped prompt additions; no new
abstractions; every step verifiable via Bot API; every failure
sentinel mapped to the manual backstop. 25 unit tests (20 from
v1.2.18 + 5 new for the v1.2.19 prompt additions).
