# Fleet default-ON for the zombie-message guard — plain-English overview

Every Instar agent keeps a queue of messages it tried to send but could not deliver yet.
Until today, if that queue held very old messages (from a crash weeks ago, say), a recovery
could "helpfully" deliver them — so users received ancient messages as if they were new.
On 2026-07-24 this hit every agent in the fleet at once.

The guard that fixes it already exists and is already proven: at the moment a queued message
is about to be delivered, its age is checked against the queue's shelf life (24 hours for the
recovery queue). Anything older is retired to a dead-letter record with a written reason —
never delivered. It ran all day on the test agent (where it retired a real 35-day-old message
on its first check) and on the development agent, with zero false retirements through six
deploys and restarts.

This change flips the guard from "off unless an install turns it on" to "on unless an install
turns it off." Concretely: the code that reads the setting changes from requiring an explicit
"enabled: true" to treating anything except an explicit "enabled: false" as armed. Every agent
gets the protection at its next auto-update with no setup. Any install that deliberately set
"enabled: false" stays dark — an explicit choice is always respected.

Two instant rollback levers exist independently: an install can set the flag to false, and any
queue's shelf life can be set to zero (meaning "no expiry") in the shipped policy file. The
worst failure direction of a bug here is a message retired too eagerly — recorded with a named
reason, auditable, never silent — and fresh messages cannot be touched because the 24-hour bar
is roughly a hundred times the normal retry horizon.

What you need to decide: nothing further — the operator approved fleet rollout ("go fleet",
2026-07-24 22:30 PDT) after reviewing the soak evidence. This document exists so any reader
can understand the change without archaeology.
