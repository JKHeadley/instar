# Slack mentions tag people in the conversation

<!-- bump: patch -->

## What Changed

A Slack mention an agent writes as `<@USERID>` is now sent as a real tag when that person is in the conversation: a member of the channel or direct message, or someone who posted in the thread, and an active person rather than a bot. No flag is needed. Mentions of anyone else, bots, `@channel`/`@here`/`@everyone`, and anything inside code still go out as plain text, as before. The `--native-reference ID` flag still activates a deliberate mention outside these rules. If Slack cannot confirm membership (missing permission, error, or more than 2.5 seconds), the mention stays plain text and the message still sends. Agents get a short CLAUDE.md section about this, added on update for existing agents, and the Slack session start-up line now describes the default.

## What to Tell Your User

When I mention someone who is in our Slack conversation, Slack now tags them properly instead of showing a raw code. I still cannot ping the whole channel, and I will not tag people who are not part of the conversation unless I mean to.

## Summary of New Capabilities

| Capability | How to Use |
|---|---|
| Slack person mentions | Write `<@USERID>` in a Slack reply. People in the conversation are tagged automatically; others stay plain text. |

## Evidence

Before: a message with `<@U0C62ABNDK8>` and no flag arrived as raw text (operator reports 2026-11-04 and 2026-11-12). After: formatter, adapter and awareness unit tests pass, and a bound-route integration test drives a real SlackAdapter. A live post through the real adapter in Echo's isolated test workspace (T0CEF50NAR1, channel C0CG1C62HUL, message 1794535933.184259) read back from Slack with a user element for the member and plain text for a non-member, the bot itself, `<!here>` and a code example.
