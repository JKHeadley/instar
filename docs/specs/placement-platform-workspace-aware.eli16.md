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
- **No black-holes, and an honest "nobody can serve this".** If *no* computer can actually reach a channel (e.g. no machine is in that Slack workspace), placement does NOT pick a computer that can't serve it (that's the bug). Instead it returns the same "can't place" result the system already uses for other unsatisfiable cases (`no-machine-serves-channel`), which raises an attention notice — an honest "this channel isn't served on any connected machine" rather than a silent black-hole. The message isn't dropped; it waits, and you're told.
- **A pin to a computer that can't serve the channel is refused, not honored into a black-hole.** If someone pinned a channel to a computer not connected to its workspace, placement returns "pin unsatisfiable" (the existing pin-can't-be-honored path) rather than silently sending messages somewhere they'll never be answered. A pin to a computer we just don't have fresh info about is still honored (fail-open).

## What you need to decide

Nothing — it ships dark behind the existing multi-machine path. On a single computer it does nothing. It just makes "follow the user across computers" actually correct for Slack, the same way an earlier fix made placement aware of which computer had hit its usage limit. This is the real fix for the bug the live-test caught.
