# Slack Multi-Machine Parity — ELI16 Overview

## What's the problem?

Right now, when the Instar agent spans multiple machines (Laptop and Mini), Slack users are totally cut out of the loop. They don't see when sessions restart, when the conversation moves to a different machine, or when something goes wrong. Meanwhile, Telegram users see all of this — session status, moves, everything. This makes Slack feel broken compared to Telegram, even though the agent is doing the exact same work.

Think of it like group chat: if I tell you in Telegram "moving to my laptop" but tell Slack users nothing, you get confused. Why'd the bot go silent? Did it break? Spoiler: no, it just switched machines, but you didn't know.

## What does this fix?

This spec makes Slack a first-class citizen in the multi-machine world. When a session starts, restarts, or moves machines, Slack users see it — just like Telegram users do. When the agent creates a new conversation thread or needs your attention, Slack gets the notification at the same time Telegram does.

The agent's work becomes **transparent** across machines, and Slack users get the same seamless experience as Telegram users.

## How does it work?

There's a base "notification system" that both Telegram and Slack can plug into. Right now, only Telegram is plugged in. This spec connects Slack to that system and makes sure Slack's notifications are formatted right for Slack (Slack uses a different text format than Telegram, so the agent speaks each language natively).

It also gives each Slack conversation a stable ID so the agent remembers which conversation is which across restarts and machine swaps — the same way it does for Telegram.

## What does the user experience?

**Before:** Slack is silent about multi-machine stuff. Telegram has all the news.

**After:** Slack gets the same real-time updates as Telegram — session starts, restarts, moves, anything that matters.

- Agent: "Moving this conversation to my laptop for load balance. Back in 5 seconds."
- User sees this in Slack, right there in the thread, at the same time they'd see it on Telegram.

That's it. Simple, seamless, no surprises.

## Why does this matter?

Goal A is "the agent is a premier AI employee in Slack." But right now, that employee is radio-silent when anything interesting happens. This fixes it — makes the agent a real team player who keeps you in the loop, just like a human coworker would.

Also, for organizations that use Slack as their primary communication tool (which is most organizations), this is table-stakes. You can't have a seamless multi-machine agent without seamless Slack integration.
