# ELI16 — Placement must see which channels a machine can actually serve

## What this is

When you run one agent across two computers (a Laptop and a Mac Mini), the system decides which computer should handle each conversation. That decision is made by "placement." This change teaches placement one more thing it was blind to: **whether the computer it picks can even reach the channel the conversation is on.**

## The bug we caught (and how)

The gold-standard live-test — a session acting as a real Slack user — sent a message in a Slack channel and waited for the agent to reply. The agent never really replied; the user just got a "🔭 working…" placeholder.

The reason: that Slack channel lives in one Slack workspace (call it "Test"), and placement had assigned the channel to the Mac Mini. But the Mini's Slack is connected to a *different* workspace ("Echo Agent") — it isn't in the "Test" workspace at all. So the Mini "owns" a channel it literally cannot see. The message falls into a black hole.

Telegram doesn't have this problem because both computers share the same Telegram chat — either can serve it. Slack is different: each computer is logged into its own separate Slack workspace.

## What's new

1. Each computer now reports, in its regular "I'm alive" heartbeat, **which channels it can actually serve**: which Telegram chat(s) it polls and which Slack workspace(s) it's connected to.
2. Placement now filters out any computer that can't serve the channel in question. A Slack channel can only go to a computer connected to that channel's workspace.

## The safeguards (in plain terms)

- **Old computers aren't penalized.** During an update, a computer that hasn't learned to report this yet is treated as "can serve" (fail-open), so nothing breaks mid-rollout. Only a computer that *explicitly says* "I don't serve this workspace" is skipped.
- **Nobody gets stranded.** If somehow *no* computer can serve a channel, placement still picks one (least-loaded) rather than dropping the message — and raises a flag (`no-machine-serves-channel`) so we can see it.
- **A deliberate pin is respected but flagged.** If someone pinned a channel to a computer that can't serve it, placement honors the pin but flags it (`pinned-machine-cannot-serve`) instead of silently black-holing.

## What you need to decide

Nothing — it ships dark behind the existing multi-machine path. On a single computer it does nothing. It just makes "follow the user across computers" actually correct for Slack, the same way an earlier fix made placement aware of which computer had hit its usage limit. This is the real fix for the bug the live-test caught.
