# Usage warnings belong to the conversation's session

A helper can run out of usage while the session answering you continues working. Previously the standby checker searched the last few terminal lines for phrases about limits. If a helper's failure or a quoted error appeared there, the checker could say the whole conversation could not answer. It also treated a reset time as evidence of a limit. The two-minute and five-minute checks could repeat the same claim with slightly different prefixes, even nine seconds apart.

This fix asks for two pieces of evidence together: a current usage banner in the serving session's pane, and that exact session's latest main transcript turn marked as a provider API limit error. Text inside a helper or tool result cannot supply the second piece. A later normal turn, unreadable transcript, or unknown account home does not establish a usage limit. This intentionally favors an ordinary standby update over an unsupported claim that your conversation cannot answer.

One durable warning reservation belongs to the actual provider session UUID and topic. The reservation happens before delivery starts, so overlapping checks cannot both send it. New messages and server restarts keep that reservation. The existing topic working-set transfer carries it to the next machine. A genuine reply from the serving session clears it; a replacement provider session has its own reservation. A transport failure with uncertain delivery keeps the reservation to avoid repeating a warning the user may already have received.

The change adjusts evidence and notice bookkeeping. It does not restart sessions, change account limits, or introduce a new recovery action. It is a Tier 1 reversible fix: reverting the source restores prior behavior. Tests use isolated transcript files and mocked messaging, and full CI remains the merge authority.

The repair on current main preserves the real Claude banner that starts with a tool-result connector: the same symbol can appear on a helper error, so the symbol alone cannot identify whose limit it is. The serving transcript still decides ownership. If that proof disappears before delivery, the warning is withheld. Ordinary AI summaries are instructed to leave usage diagnoses to this verified warning path.

Malformed transcript records are treated as unknown evidence and cannot authorize a warning.

Full CI also exposed missing documentation for the existing promise-review job on main. Its schedule, evidence checks, rollout gate, and no-messaging behavior are now described in the jobs reference and evolution guide so the documentation check passes without lowering its required coverage.
