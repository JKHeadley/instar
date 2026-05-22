# What this PR does — in plain English

## What just happened

v1.2.18 got Codex to walk through Telegram setup end-to-end. Bot
created, group created, "first contact" sent. Looked good.

Then Justin tried sending a message in the group and nothing
happened. No delivery confirmation. No agent response.

Three real problems, all fixable in the Codex prompt:

## Problem 1: bot privacy mode

When BotFather creates a new bot, it has "privacy mode" turned on
by default. That mode means the bot can ONLY see direct mentions
(@bot_username) and replies to its own messages — not regular
group chat. Justin's first message in the group went into a
blackhole the bot couldn't see.

Fix: the Codex prompt now drives /setprivacy in BotFather to turn
privacy mode OFF before the bot is added to any group. Verifies
the change via the Bot API.

## Problem 2: basic group, not supergroup

Telegram has two kinds of groups: "basic" (small, simple, no
topics) and "supergroup" (bigger, with admin tools and topic
threads). The group Codex created was a basic group — chat id
-5154496235, no -100 prefix that supergroups have.

instar uses topics to organize different conversation streams:
Lifeline (main agent channel), Updates (job status), Dashboard
(web UI link), Attention (urgent things). All four require
supergroup + Forum mode.

Fix: after creating the group, the Codex prompt drives the
Telegram Web UI to toggle Topics on in group settings. That
auto-converts the basic group into a supergroup with topics, and
changes the chat id to -100... — Codex re-fetches the new id and
uses it from there on.

## Problem 3: no topics + no intros

The Claude wizard creates a Lifeline topic and sends a friendly
"first hello" from the agent. The Codex agentic path didn't.

Fix: after Forum mode is on, the Codex prompt creates four
topics via the Bot API (Lifeline / Updates / Dashboard /
Attention) with the canonical emojis and colors that match
instar's existing TOPIC_STYLE config. Then sends a 1-2 sentence
intro to each topic in the agent's voice.

## How it knows when to give up

Every new step has an explicit failure sentinel. If privacy
disable fails after a retry → AGENTIC_FAILED: privacy-not-
disabled. If Forum mode doesn't enable → AGENTIC_FAILED: forum-
mode-not-enabled. If a topic creation call fails → AGENTIC_FAILED:
topics-create-failed. Each sentinel drops the wizard into the
manual readline backstop so the user is never stuck.

## What doesn't change

- Verifier-based success check (`verifyTelegramConfig`)
  unchanged.
- Manual readline backstop unchanged.
- Claude wizard path untouched.

The architecture is the same — better prompt content, same
contract.
