# Slack references and names

<!-- bump: patch -->

## What Changed

A Slack reply can now render an intentional person mention, channel reference, or safe native link when the agent explicitly uses `--native-reference TARGET` for each intended target on its bound reply. Ordinary replies keep copied reference text literal. Broadcast mentions (`<!channel>`, `<!here>`, `<!everyone>`) and code examples stay literal, including when a long message skips markdown conversion. Thread history now shows each participant's Slack name when available, instead of only a raw ID.

## What to Tell Your User

Slack replies now use people's names when no notification is needed. When a reply deliberately mentions someone, Slack renders the mention and can notify them.

## Summary of New Capabilities

| Capability | How to Use |
|---|---|
| Intentional Slack references | In a bound Slack session, use `--native-reference TARGET` for each intended target with `.instar/scripts/slack-reply.sh` and write a valid person, channel, or safe link reference. |

## Evidence

The supplied mention failed before the fix; targeted formatter, history, and adapter tests now pass. A bound-route integration test verifies the explicit opt-in reaches the adapter. A real post in Echo's isolated Slack test channel `C0CES4G5H0B` (message `1793820889.173479`) returned an active self mention, channel reference, and link in Slack history, while broadcast tokens, a code example, and an unlisted person ID remained literal. The bot mentioned itself, so the test did not notify a person.
