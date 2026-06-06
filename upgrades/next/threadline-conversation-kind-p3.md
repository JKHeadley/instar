# Threadline conversation visibility across machines (P3)

## What Changed

The coherence journal gains its 4th record kind: every agent-to-agent
conversation's lifecycle (started / tied to a topic / closed) is recorded
content-free and replicated, so ANY machine answers "which machine holds
the Dawn thread?" from its own disk. When a topic moves machines, the
conversation deliberately does NOT move (its relay address is part of the
machine's identity) — the new `GET /threadline/conversations?scope=mesh`
view names the holder honestly, with staleness labels, instead of letting
a machine claim the thread doesn't exist. The honest-answer wording
includes the relay's REAL offline bound (peers' messages queue in memory
~24h, then may drop) — no open-ended promises.

## What to Tell Your User

On synced pairs: ask any machine about any of my agent-to-agent threads
and it knows where the thread lives and which conversation belongs to
which topic — even for threads held on the other machine.

## Summary of New Capabilities

- `threadline-conversation` journal kind (content-free; rides the
  existing replication gate).
- ConversationStore lifecycle emission (transition diff in the single
  write funnel; message traffic never journals).
- `GET /threadline/conversations` (+`?scope=mesh`) — the holder view.
- The holder-view proactive trigger on all three awareness surfaces.

## Evidence

7 unit + 1 integration (the full store→journal→replicate→fold chain
under A's authenticated identity); journal/reader/applier suites green;
parity gate (81) green.
