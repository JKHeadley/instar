# Standing Coordinator Sessions — Plain-English Overview

> The one-line version: a session you list as "standing" is never closed by automatic cleanup but can still be restarted, and a conversation whose session died can be restarted directly.

## The problem in one breath

Instar closes sessions on its own when they look idle, when they run past an age limit, or when they look finished. That is right for ordinary work, but wrong for a session whose job is to coordinate other work for days, like the session that runs the Instar 2.0 build pipeline. On 14 October it was closed three times in one day; the first two times it was brought back automatically, the third time the "don't revive the same thing too often" brake stopped that, and it stayed down. The only existing way to say "leave this session alone" also forbids restarting it, which caused a six-hour outage on 5 October. And once it was down, the restart command said "not found" because there was nothing running to restart.

## What already exists

- **Automatic cleanup** — closes idle, too-old or finished-looking sessions, but only after a shared "keep" checklist says nothing important is happening.
- **The revival queue** — brings back sessions that were closed in the middle of work, with a limit on how often per conversation.
- **The protected list** — sessions the system must never touch. It blocks closing, and it also blocks restarting.
- **The restart command** — closes a running session and starts it again with the same conversation.

## What this adds

A new "standing sessions" list in the agent's settings. A session on it (named directly, or by the conversation it serves) gets a new line on the shared keep checklist, so no automatic cleanup closes it: not for being idle, not for age, not for looking finished. Unlike the protected list it can still be restarted, by the restart command, by a new message, or by the operator.

Two smaller fixes come with it:

- The restart command now works on a conversation's session even after its process has died: it starts it again from the saved conversation instead of answering "not found".
- Starting a new session for a conversation whose old session died is no longer refused with "this conversation already has a session".

## The safeguards

**Duplicates are still cleaned up.** When a conversation moves to another machine, or a duplicate copy is being retired, the standing mark does not stop that one close, and every other keep rule still applies. A coordinator never ends up running on two machines.

**Nothing is revived by accident.** Only the explicit restart command uses the new "restart a dead session" path, and only when the conversation still points at that session. If the conversation has since moved to a different session, the old answer stands.

**Nothing changes unless you opt in.** With the list empty, cleanup behaves exactly as before. The protected list is unchanged.

## What this does not do

It does not revive a standing session that crashed on its own; that still needs a restart command or a message. It does not change the revival limit, which exists to stop restart loops.

## What you need to decide

Nothing beyond which sessions to list. On the development agent, the build pipeline's coordinating session is the one to add.
