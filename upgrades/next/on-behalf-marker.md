# Messages an agent sends as its operator are marked, and Slack recognises the mark

## What Changed

There is now one marker for any message an agent sends through its operator's own account, on any platform: `[Sent by <agent> on <operator>'s behalf]` (add `, test` inside the brackets for a test). When a Slack message that starts or ends with the marker reaches the agent, its session tag and thread history say it was sent by the named agent and not written by the account holder, so the agent never takes its own on-behalf message as the operator's words. Telegram keeps its existing cryptographic signature. A new section in each agent's instructions (added to existing agents on update) says to check its own reach before asking the operator to look at or check something, and to mark every send made as the operator.

## What to Tell Your User

If I ever post through your account, for example to test a Slack conversation, the message will start with "[Sent by <my name> on your behalf]". I'll recognise those when they come back, so I won't mistake my own test for something you wrote. I won't buy anything, change settings or message other people in your name without asking.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|------------|
| On-behalf marker for sends through the operator's account | The agent writes `[Sent by <agent> on <operator>'s behalf]` at the start |
| Slack tags marked messages as not written by the account holder | Automatic on inbound Slack messages |

## Evidence

Founding case: topic 134088, 2026-11-09 17:25 PST. Echo posted as Justin in `#echo-agent-sess-test-slack`, marked "[Sent by Echo on Justin's behalf, test]", and Justin asked for the marking to be a general protocol. Tests in `tests/unit/on-behalf-marker.test.ts` cover the format, parsing at the start or end only, ignoring a mid-message quote, the inbound labels, the live Slack wiring, and the template plus migration.
