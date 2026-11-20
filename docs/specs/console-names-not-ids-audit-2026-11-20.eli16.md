# Dashboard names, not IDs: fixes from the 20 November live check

## What this is

On 20 November 2026 the agent opened every page of the dashboard at laptop size and phone size, as part of the "finish the dashboard makeover" project. The project has three goals: pages without clutter, "needs you" items that say plainly what to do, and names everywhere an ID used to show. The check found several places that still broke those goals. This change fixes the ones that live in the dashboard code and the Telegram connection.

## What the person saw before, and what they see now

- **Needs-you list cut off mid-word.** A Chief of Staff item read "Conversations grouped under efforts, with suggestions and… looks done and needs y". The list cut every work-board card title at 80 characters, wherever that fell. It now keeps whole words and ends with "…" only when a title is truly long (over 140 characters). The usual "… looks done and needs your OK" now shows in full.
- **Work board "out of date" notes printed machine IDs.** It said "This machine may not have the newest changes from m_e8c9b243c449… yet". The server now sends the machine's nickname with that note, so it reads "…from Mama PC yet". A machine with no nickname reads as "another of your machines", never as its ID.
- **Documents page showed "Telegram topic 145840".** It now shows the conversation's name, or "A Telegram conversation" when no machine knows the name.
- **Notifications page showed topic numbers, machine IDs and long hex codes.** Notices now go through the same plain-words cleanup that promises already use: a conversation shows by name, a machine by nickname, and leftover codes become "a reference". The original text is still there when you hover over it. The doubled "(name unresolved)" after "a conversation" is gone.
- **Costs page listed machines by ID.** The machine comparison now uses nicknames. A conversation with no known name shows as "A conversation whose name isn't known yet" instead of "Conversation 127504".
- **The needs badge read "12+?".** It now reads "12+" (at least twelve). The line under it still says which places could not be checked.

## The one change below the dashboard

The Studio was rebuilt after the 19–20 November outage, and the names of about sixty recent conversations were lost on every machine, so the dashboard showed "Conversation name unavailable". Telegram has no way to ask for a topic's name. But every message the agent sends into a topic comes back from Telegram attached to the topic's creation message, which carries the name. The Telegram connection now reads that name from its own successful sends, but only when it knows no name for that topic. A name it already knows, including one from a rename, is never replaced. So a conversation gets its name back the next time the agent speaks in it, with no extra request and nothing visible in the chat. This is the same rule the connection already uses for incoming messages.

## What is not affected

No decision, gate or block changes. Nothing is sent that wasn't sent before. Undoing this commit restores the old wording, and any names learned so far stay correct.

## What you need to decide

Nothing. It is a small, reversible fix to display wording, plus one name cache that only fills gaps.
