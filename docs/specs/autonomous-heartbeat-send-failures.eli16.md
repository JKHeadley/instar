# Autonomous-run progress notes that fail, in plain words

When the agent works on its own for a long stretch (an autonomous run), it posts a short note in the run's topic whenever the topic has been quiet for about half an hour, so the person can see the run is still alive. That note goes through the agent's own local message route, the same path every reply uses.

The problem: when posting a note failed, the agent undid its "I just posted" bookkeeping, which is right, because a note that never arrived should not count. But that also meant the very next check, about a minute later, tried again. On the Studio on November 24, the local message route stopped answering for about 43 minutes. Three topics were in autonomous runs, so the agent tried all three every minute and wrote 100 failure records. Each record only said "TypeError". That is the error Node throws when a request breaks before any answer comes back, so nobody could tell from the record what had actually gone wrong. Those records pushed the feature's measured error rate to 11 percent, over its 5 percent limit.

What changes:

1. A failed post now records a short reason: the status code and the route's own error text if the route answered, or the connection error code (such as "connection refused") if it did not. It is cleaned of anything that looks like a secret and cut to 160 characters. The note's own text is never recorded.
2. After a failure, that one topic waits before trying again: 5 minutes, then 10, 20, and at most 30. The first post that works resets the wait. Other topics are not affected.
3. If the route says the topic itself is gone (Telegram says the thread was deleted or closed, or the chat no longer exists), the agent records it once and then tries that topic only once an hour for the rest of that run, because a closed topic can be reopened. When a new run starts there, even right after the old one, it starts fresh. A topic that is only temporarily refused (busy, held, owned by another machine) is not treated as gone.

What does not change: when a note is due, what it says, which machine sends it, and the rule that a failed note does not count against the run's budget. The waits are kept in memory, so after a restart a topic gets one immediate try again.
