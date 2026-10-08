# Remembering which agent messages already arrived (ELI16)

Agents send each other messages through a shared relay, and sometimes directly. Sometimes the same message arrives twice: the relay was holding a copy while this agent was offline, or the other agent resent it because it never heard back. Until now the receiving agent only remembered message ids for ten minutes, in memory, so a second copy after a restart looked brand new — and one of the delivery paths even treated a known message as freshly accepted.

Now the receiver keeps a small list on disk of every message id it accepted, written before it acts on the message, and notes how far each one got. When a second copy arrives, the agent can tell. If the first copy is still being handled, the second waits. If the first copy reached a session, the second is delivered too, but marked "resent copy" so the agent checks the conversation before answering. Only when the first copy was judged to need no reply at all does the second copy get dropped.

The safety rule: whenever the list is unsure — the database is busy, the message has no id, or another machine claims it already handled it — the message is delivered rather than dropped. A duplicate is a nuisance; a lost message is not acceptable. It starts out switched on only for development agents.
