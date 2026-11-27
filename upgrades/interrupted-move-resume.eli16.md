# When a conversation moves machines mid-task, the task is picked back up

## What happened

On Nov 14 Justin asked Echo, in the work board conversation, to check in with Luna. That conversation was running on the Mama PC. Echo answered "I will check in with Luna" and started. While it was still working, it moved the conversation to the Mac Studio. A move gives the running session 30 seconds to finish what it is doing, and then closes it. The session was still busy, so it was closed in the middle of the task.

Two things then went wrong. Nothing on the Studio was told that a task had been cut off, so nobody picked it up. And the one message that said "I moved this conversation before I'd finished my last step" was labelled as a general automated notice. Instar keeps those in a quiet notification list instead of posting them into the conversation. So Justin never got the check-in, and never saw any message saying why.

## What already existed

Instar can already move a conversation between machines. It waits for the session to finish its step, closes it, and hands ownership to the new machine. When the next message arrives, the new machine starts a session with the recent conversation history. Instar also had the "moved before I'd finished" message, but it only told the person to ask, and it went to the quiet list.

## What this change does

1. When a move has to close a session mid-step, the old machine now asks the new machine to pick the step back up. The new machine first checks its own records to confirm it really owns the conversation now. Then it gives the conversation's session a short note: "you were moved before you finished; read the recent messages, check what was already done so nothing runs twice, finish it, and tell the person". If no session is running there, it starts one with the recent history, the same way it does for a new message.
2. The person gets one message in the conversation: "I moved this conversation to the Mac Studio before I'd finished my last step. I'm picking that step back up there now, and I'll tell you when it's done." Then the resumed session replies with the result.
3. If the new machine cannot take it (it is on an older version, it cannot be reached, or it never became the owner), the old machine sends the original "may be incomplete, ask me to check it" message instead. Exactly one of the two machines sends the message.
4. That message is now labelled as an answer to the person's own message, so it goes into the conversation instead of the quiet list.

## Safeguards

The new machine acts only on a conversation its own records say it owns, and only once per move. It does nothing if an emergency stop is on. If a new message started a session at the same moment, the note goes into that session rather than starting a second one. A failed restart still sends the plain message, so the person always hears something. Nothing is retried in a loop.

## Limits

Conversations in the native Instar app keep their current behaviour: they get the "may be incomplete" message in the conversation but are not restarted yet. That is filed as a separate improvement. If a cut-off step was serving a message more than 15 minutes old, the notice may still land in the quiet list, but the resumed session's own reply always reaches the person.

## What you need to decide

Nothing. This is a small change that a revert fully undoes.
