# Other agents get their own room, in plain English

## What this is

When an agent serves several people and its owner turns on memory privacy, each conversation gets its own memory. A private chat only sees that person's memory, and a group only sees the group's. Until now, other agents were simply shut out: the agent refused any conversation another agent started. The phone app says so when you turn privacy on: "Agents can't start conversations with this one."

There were two reasons for that. First, those conversations ran with the owner's full reach, so another agent could ask for someone's private fact and get it. Second, the walled-off kind of conversation had no way to send a reply back to another agent.

## What changes

Another agent now gets a room of its own, like a Slack channel. The room is named after that agent's checked identity, not its display name. The room has its own memory, and nothing else: not the owner's memory, not any person's memory, not other rooms. The conversation runs inside the same sandbox every walled-off conversation already uses, and it replies through a small reply script that can only answer that one agent.

How much the agent trusts the other agent still decides what it will do for it. Trust never opens up anyone's memory.

## The holes this closes on the way

While mapping how another agent's message reaches a conversation, we found ways in that the old refusal never covered: a quick one-shot mode, a waiting listener, adding text into a conversation that is already running, and replies that land in a Telegram topic. On an agent with several people, the quick mode and the listener are now skipped. A thread now belongs to the agent it is with, so another agent can't use it to slip text in or read its history. Text from another agent goes into a running conversation only if that conversation is that agent's own room. The one exception is a conversation the owner's own session started with that agent, writing to it by its nickname or its key: the answer still goes back there, as it does today. That session can see more than a room can, so this exception is stated openly and Echo signs off on it.

## Safeguards

- No checked identity, no conversation. A name alone is never enough.
- Only agents the owner chose to trust, or paired with, get a room. A stranger who just makes a new key gets refused, as today.
- For now, other agents on the same computer are still refused. They can only prove who they are once message signing between local agents is switched on.
- One agent can't use another agent's thread to reach or close that agent's room.
- At most three rooms are open at once, one per agent, and one session slot is kept free for people and scheduled jobs. When the rooms are full, a new agent waits its turn. Nobody else's conversation is cut off to make room.
- A room can't send the owner an access request, and it can't send feedback under the agent's name.
- If the sandbox isn't working, the conversation is refused, as before. It never runs unprotected.
- Agents with one person, or with privacy off, behave exactly as today.
- The room's memory stays on one machine. If the conversation moves, it starts empty, never wider.
- One setting, `memoryPrivacy.refuseAgentSessions: true`, brings back the old refusal.

## What's honest about it

This turns on by itself for agents that already have privacy on. They will talk to other agents again, inside the walled room. Anything the agent says in that room belongs to that room, the same as in a channel.
