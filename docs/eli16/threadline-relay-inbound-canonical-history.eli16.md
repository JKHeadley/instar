# Relay messages now show up in thread history (ELI16)

## What was wrong

Each Threadline conversation has a "canonical history": one file per conversation, where every message sent or received is written in order. Agents and the dashboard read this file to answer "what has been said on this thread?"

Messages can arrive by several routes. Most of those routes already wrote into the history file. One did not: the main route for messages from another machine, the relay socket. Those messages were checked, decrypted and delivered to a session. They were also written into an older inbox file. But they never reached the history file. On Luna, a thread's history showed 11 messages, all of them Luna's own, while the old inbox held 8 replies from the other agent. History looked one-sided.

There was a second, smaller bug. Very long messages (over 8 KB) are not stored inside the history file. The history file keeps a pointer to a separate copy instead. But nothing ever wrote that copy, so the pointer led nowhere.

## What changed

- The relay handler now writes each message it has **already accepted** into history. It uses the same single recording function the other routes use. This happens before the message is handed to a waiting reply, a session or any other route. Probes and acknowledgements are still skipped, because those were never conversation messages.
- The message keeps its real id, thread, the verified sender, and the time the sender stamped on it. If a very old sender sent no time, this machine's receive time is used, and the entry says so (`createdAtSource: receive-time`). It is never passed off as the sender's time. One route used to quietly fill in the missing time before the message got here; it now leaves a mark saying "this time was filled in", so the entry is labelled correctly and if the same old message is delivered again, it still makes only one entry (see the relay limit below). If that old message comes back with the same id but different words, it is now flagged as a mismatch (a "collision", logged and counted), not quietly treated as a repeat. The first entry and its time stay as they were.
- Long messages now get their separate copy written **first**, and only then does the history entry point at it. The copy's name is a hash, so a message id from the outside can never pick a file path. Two different bodies under the same id get different names, so a later copy can never overwrite the first. Each conversation's copies sit in their own folder, named by a hash of the conversation id. If there is nowhere to store the copy, the recording fails in the normal visible way (a log line, then one deduped warning item) rather than writing a pointer to nothing.
- When a conversation is truly closed (resolved or failed, and not pinned), its history file was already deleted. Now its folder of long-message copies is deleted at the same moment, including a copy whose history entry failed to write. Only that one conversation's folder is touched. Pinned conversations, conversations that are just archived for inactivity, and history files that get rotated keep all their copies, exactly as the history file itself is kept.
- The two history read routes now show the full long body instead of an empty one.
- The server builds its history recorder with one shared function, and the relay handler uses one shared "what is this message, is it an ack" check. The tests call those same functions, so they test what actually runs.

## Known limits

- A retry long after the original entry leaves the active history window can appear twice or be logged as a mismatch. It never replaces an earlier entry.
- Very old messages from the same agent in the same conversation, with no id or sender time and identical text, can be treated as one message.
- The relay server itself (not this change) treats every message that has no id as the same message for 5 minutes. After one such old-style message passes through, any other one, from any agent, is turned away as a "replay" before it arrives. So a retry of an old-style message through the same relay inside that window never gets here. That is a separate existing relay bug, reported on its own. Because of it, the end-to-end test sends the old-style message over the relay once, then hands that same received message to the history recorder a second time to check it is recognised as a repeat. That second step does not go through the relay, and it does not test whether a repeat is allowed in. Separate unit tests, using the real history files, cover repeats and mismatches. <!-- tracked: fb-f0201004-f5e -->
- Thread ids in an unusual shape (uppercase ids, or the `relay-<number>` id used when a sender gave none) are not written to history. The history pages could not show them anyway. The old inbox still has them.
- The "receive-time" label is not covered by the tamper-evident chain. It is for display only.
- Messages are written to history before routing decides where they go, so a message later declined or sent to a peer's own place still appears in the owner's history, as it already did in the old inbox.

## What did not change

Nothing decides differently about whether a message is allowed, who gets it, or when. Recording is only an observer. If writing history fails, delivery carries on exactly as before. A history entry means "this machine received it". It does not prove anyone read it. Writes are ordinary file writes with no forced flush, so this makes no crash-safety promise. The old inbox file is untouched and still keeps its own copy. Luna's 8 earlier messages are not copied in by this change; their restoration remains part of the active full repair in topic 9210 (main spec §4.11 and PR-A).

## Undoing it

Revert the code. Nothing needs migrating. History entries and long-message copies written in the meantime stay on disk; the old code simply ignores them or shows an empty body, as before. The old inbox still has everything.
