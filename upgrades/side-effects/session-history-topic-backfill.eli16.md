# Session history goes back to the start of the conversation

On the dashboard you can open a session and switch to History to read what was said, scrolling up for older messages. A long conversation, like a Telegram topic you have been using for weeks, is served by several sessions over its life: each time the agent restarts or the session is replaced, a new session picks the conversation up. History only read the current session's own record, so it stopped at the moment that session started. For this topic that meant History ended on Oct 31, even though the conversation began on Oct 20.

Now, when you scroll past the start of the current session, History keeps going into the earlier part of the same conversation. It shows a line, "Earlier, from this conversation's previous sessions", and then the older messages, loading more as you scroll. They come from the agent's record of every message in that conversation, collected from all of its machines.

To keep the dashboard fast, the agent reads its (very large) message record from the end backwards and stops as soon as it has enough for one screen. If a machine has not been updated yet and cannot answer "messages before this time", History simply stops at the start of the current session as before, rather than showing recent messages twice.
