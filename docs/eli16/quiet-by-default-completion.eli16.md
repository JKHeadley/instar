# Quiet by Default completion

The agent has been sending reports about its own machinery into conversations where the person cannot usefully act on them. Grouping those reports into Agent Health solved where some notices went, but still left direct sends, background jobs, overseers, and cross-machine delivery able to push routine work into Telegram.

This change makes delivery depend on the source of a message. Actual replies keep flowing. A notice responding to a particular incoming message, such as a command response or a delivery problem, keeps its conversation intact. Background output instead goes into a notification feed unless the operator explicitly chooses that category for push. Calling something urgent or calling it a reply in a request body does not grant that choice.

The dashboard has a Notifications page with unread notices and category switches. Changing a switch requires the operator's PIN, or a recent confirmation from the verified operator in that conversation. Preferences are audited and durably queued for the agent's other machines. A dark machine remains visibly pending. Quiet notices can be read across the pool, with unavailable machines shown as unknown, and short quoted summaries enter the relevant conversation when it next starts.

The last delivery paths, including sealed origin operations, relays, recovery, raw adapter sends and the lifeline, observe the policy. A recorded notice has its own receipt rather than an invented Telegram message id. Recording does not clear a waiting reply, claim that the user was notified, or trigger a mobile push. If the lifeline cannot reach the server's notification writer, its existing durable outbox keeps automation pending while its inbound-bound recovery commands still work.

Repeated notices coalesce. Opted-in pushes have category and global limits, with one bounded overflow summary; the optional daily digest includes counts and category names, never copied message bodies. The first quiet occurrence is written immediately, and repeated counts are batched into one subsequent update per window. This intentionally strengthens first-occurrence durability while keeping storm writes proportional to windows rather than events.

Overseers keep findings and repairs in handoffs. A Bugs-hub escalation must name an unresolved impact and the one action only the operator can take. Stale-session observations feed the existing bounded triage authority instead of asking the person to request an investigation. Ownership recovery and returning-peer pull queues continue to own stranded topics and visibility recovery. Nobody is asked to perform the agent's housekeeping.

The fleet retains the approved observation and operator-flip rollout. Echo's existing directive enables enforcement once, and subsequent explicit rollback choices remain live. No constitution changes are included.
