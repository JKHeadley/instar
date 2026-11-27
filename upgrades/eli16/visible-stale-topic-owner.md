# Show when a message was held by an offline owner

A conversation can belong to another machine. If that machine goes offline, Instar first tries its supported ownership recovery. Sometimes the router can save an incoming message but cannot move the conversation safely. Previously that specific condition appeared only as queue contention, so it was hard to see why later messages were waiting too.

Agent Health now records the hold once per conversation ownership epoch. It checks that the message was saved and that the pool's heartbeat deadline passed or the message has waited for a minute without a heartbeat observation. The record gives the team a place to start investigating. It does not ask the person who wrote the message to repair the machine. The router continues to use the existing ownership safeguards and the queue's existing retry and expiry rules.
