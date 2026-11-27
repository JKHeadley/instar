# "Open session" from the Instar iPhone app — plain-English overview

## What this is

Every chat in the Instar app (an app conversation, a Telegram topic, or a Slack channel) is answered by a session: a running copy of the agent in a terminal on one of the operator's computers. The dashboard can show that terminal live. Until now, the app had no way to jump from a chat to the terminal answering it, so the operator had to open the dashboard and hunt for the right session by name.

This change adds one question the app can ask the agent: "which session is answering this chat right now, and how do I open it?" The agent answers with either a link that opens the dashboard already focused on that session, or a plain sentence saying why there is nothing to open.

## What already existed

- The dashboard already understood a link of the form `/dashboard?session=<name>`: after you type the PIN, it selects that session and starts streaming it.
- The agent already knows which session each chat is bound to (the same mapping it uses to deliver your messages).
- The app already signs every request with a key kept on the phone, and the agent already checks which chats each phone may see.

## What is new

- A read-only question, `GET /mobile/conversations/session?ref=…`, that only a paired phone can ask. The agent's own password-like token is refused, so it is not a new way in for anything else.
- The answer says whether a session is running, its name, when it started, which AI engine runs it, the computer's name, and the dashboard link.
- When nothing is running, the answer says so in a plain sentence: "No session is running for this chat right now; your next message starts one."
- When the chat runs on another of the operator's computers, the answer names that computer instead of pretending there is nothing.
- The dashboard now waits up to ten seconds (instead of three) for its session list after the PIN, so the link works over a slow phone connection.

## Safeguards

- The link never contains a password, token or PIN. Opening it still asks for the dashboard PIN as usual.
- A phone can only ask about chats it is already allowed to use. A phone set up for another person gets "unknown" for chats that are not theirs.
- The question changes nothing. It cannot start, stop or move a session.
- The link points to the computer's permanent address (the same one used for pairing), so it keeps working.

## What a reader needs to decide

Nothing to approve. It is small, read-only, sits behind the existing phone-pairing switch, and removing it is a single revert. The app side (the button itself) is built separately in the iPhone app and calls this question.
