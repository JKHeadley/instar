---
title: Memory privacy
description: When one agent serves several people, what it remembers about one of them stays out of conversations with the others.
---

When one Instar agent serves several people, a fact one person told it in a private chat must not reach a different person who asks in a new conversation. Memory privacy keeps those apart.

## Each conversation gets an audience

The place decides the audience, through `resolveMemoryAudience` in `MemoryAudience` (`src/users/MemoryAudience.ts`):

- A private chat's audience is that one person.
- A group or channel's audience is everyone who can read it, so even the owner's private memory isn't loaded there.
- A scheduled job works for the owner.
- Anything the agent can't identify gets no memory at all.

Each inbound path supplies the place: Telegram, Slack (`SlackPrincipalResolver`), the app (`DevicePerson`), and WhatsApp and iMessage through `UserProfile` channels.

Each audience has its own memory folder, outside the agent's main folder. What the agent remembers in a conversation is saved there, and only that folder is loaded next time.

## What a session can reach

Outside the owner's private chats, a session runs in an operating system sandbox that hides the agent's other files, including other people's memory, message logs, backups and transcripts. It also gets a limited key to the agent's own server, which refuses everything except a short list such as sending replies.

`MemoryInboundTracker` looks at each incoming message and `MemoryPrivacy` holds the state, including whether the agent serves more than one person.

## Safeguards

- If the agent can't tell who a conversation is for, it loads no memory.
- If the sandbox can't run, the agent sends a fixed reply and tells the owner how to fix it. It doesn't run unprotected.
- An agent with one person is unchanged in that person's private chats. In a channel with other readers, it keeps private memory out.
- Old memory isn't moved or rewritten. On a multi-person agent it is visible only in the owner's private chats.
- An operator can name people who share memory freely. If anyone else can reach the agent, the protection turns on by itself.

## What it costs

Outside the owner's private chats, the agent loses search-based recall such as `/memory/search`, and doesn't learn across people. Private folders stay on one machine, so a conversation that moves to another machine starts with an empty folder, never a wider one. On standard Ubuntu the sandbox needs one setup step as an administrator.

The owner can still read everything. What's said in a group stays visible to that group, including people who join later. Agents that share one computer account can still read each other's files.

## Checking and switching it off

`GET /memory-privacy` reports the current status. Setting `memoryPrivacy.enabled: false` switches the whole thing off, with no data to repair.
