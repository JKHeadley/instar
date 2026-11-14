# ELI16 — Profile restarts stop wiping out freshly started tasks

## The problem in plain words

A conversation topic can have a "pinned profile": which AI engine and which model its session should run on. Instar keeps a small record of which profile each running session was actually started with. When the server restarts, it checks every running session against that record. If the record says "this session is on the wrong profile", it restarts the session on the right one.

There are two ways to start a session in a topic. A normal one starts when a message arrives in the topic. A direct one is started through the server's spawn request with a written task (the "brief"). The direct way never looked up the topic's profile, and it never wrote down what it started with.

So after the next server restart, the check found no record for those sessions and treated "no record" as "wrong profile". It restarted them. The restarted session rebuilds its memory from the topic's chat history, but a direct spawn's brief is never posted to the chat. The new session saw nothing to do, sat idle, and the task was lost. This happened to two bug-fixing sessions on 2026-11-03, and the profile log shows the same unneeded restart more than 20 times since 2026-11-01.

## The fix

1. **Direct spawns use the topic's profile.** If the request doesn't name an engine or model, the direct spawn looks up the topic's profile (from the same place normal spawns use) and starts on it. Then it writes down what it started with, so the restart check has a true record.
2. **No record no longer means wrong.** If the check finds a running session with no record at all, it leaves the session alone and logs that. The pinned profile still takes effect the next time that session starts normally.
3. **A real profile restart keeps the task.** The direct spawn also saves its brief. If the session is later restarted for a real profile change and the restart has to start a new conversation, the brief goes into the new session's opening message. The new session is told to check the history first, so it won't redo finished work. The saved brief only goes to the session it belongs to (and to that session's replacement), never to an unrelated later session in the same topic.

## What changed and what didn't

- Changed: direct spawns into a topic now run on that topic's profile unless the request names its own engine or model. A request that names one still gets what it asked for.
- Changed: the server no longer restarts sessions just because it has no record of how they started.
- Unchanged: when the record shows a session really is on the wrong profile, it is still restarted the same way, at the same moment (only when the session is idle).
- Unchanged: spawns with no topic behave exactly as before.

A revert of this one commit fully undoes it. There is no data migration. Saved briefs are small files in the agent's state folder.
