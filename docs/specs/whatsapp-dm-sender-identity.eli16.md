# WhatsApp: who sent a direct message is decided from WhatsApp's own data — plain-English overview

## What this is

WhatsApp sometimes labels a direct chat with an internal id that contains no phone number. The agent has to work out who sent the message before deciding whether that person is allowed to talk to it.

## What changes

The agent now identifies the sender from information WhatsApp itself provides: the phone number WhatsApp attaches to the chat, or, for your own account, the fact that WhatsApp marks the message as sent by you in your own chat. If WhatsApp gives no way to tell who sent a message, it is ignored, just like a message from someone you haven't authorized.

## What you would notice

Nothing in normal use. Messages to yourself and from contacts you've authorized work as before. Messages you send from your phone to other people are no longer treated as instructions to the agent.

## What you need to decide

Nothing. It is a fix, and a revert fully undoes it.
