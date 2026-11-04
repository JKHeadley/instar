# Memory privacy, in plain English

## What this is

Today, when one Instar agent serves several people, everything it remembers goes in one pool. We proved that a fact one person told the agent in a private chat can be given to a different person who asks for it in a new conversation. This change stops that.

## What already exists

Instar already knows who people are: there is a user list, owner and MSP roles, and each message arrives with a sender. There is also unused code for marking data private. Nothing calls it, and most memory is saved with no record of who said it. So simply switching on a filter would either hide everything or hide nothing.

## What is new

Each conversation gets an audience, and the place decides it. A private chat's audience is that one person. A group or channel's audience is everyone who can read it, so even your own private memory isn't loaded in a channel. A scheduled job works for the owner. Anything the agent can't identify gets no memory at all.

Each audience gets its own memory folder, kept outside the agent's main folder. What the agent remembers in that conversation is saved there, and only that folder is loaded next time.

The bigger change is what a session can reach. The proven leak came from an ordinary file search, so outside the owner's private chats a session runs in an operating system sandbox that hides the agent's other files: other people's memory, message logs, backups and transcripts. It also gets a limited key to Instar's own server, which refuses everything except a short list such as sending replies and reading this place's history.

## Safeguards

- If the agent can't tell who a conversation is for, it loads no memory.
- If the sandbox can't run, the agent first tries to set it up itself. If it still can't, it sends a fixed reply and tells the owner how to fix it. It doesn't run unprotected.
- An agent with one person is unchanged in that person's private chats, and a test checks that its sessions start exactly as they do today. In a channel with other readers it now keeps private memory out, on purpose.
- Old memory isn't moved or rewritten. On a multi-person agent it becomes visible only in the owner's private chats, because the owner can already read those files.
- An operator can name people who share memory freely. Luna will name Justin and Adriana. If anyone else can reach the agent, the protection turns on by itself.
- One setting, `memoryPrivacy.enabled: false`, switches the whole thing off, with no data to repair.
- This is off unless the owner asks for it, on every machine the agent runs on. An update never turns it on. An agent with several people keeps running as it did, so their facts stay in one pool until the owner opts in. New agents start with it off too, until a backup machine can be trusted to keep the setting.

## What it costs

Outside the owner's private chats, the agent loses its search-based recall and doesn't learn across people. Private folders stay on one machine, so if a conversation moves to another machine it starts with an empty folder, never a wider one. On standard Ubuntu the sandbox needs two packages and one setup step as an administrator; the agent does these itself if it has passwordless sudo.

## What it does not do

The owner can still read everything, as they can today. What's said in a group stays visible to that group, including people who join later. Agents that share one computer account can still read each other's files; that's a separate issue.

## What you need to decide

Nothing. The one product question is answered: old memory stays hidden in shared groups by default, and Luna is named explicitly.
