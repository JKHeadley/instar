# Three conversation zoom levels — in plain English

A long-running conversation needs more than a recent transcript. The agent
should know three things at the same time:

- what this whole topic is trying to accomplish;
- what the latest chapter of the conversation is about;
- what work is happening right now.

Each zoom level names its goal, the direction it is moving, and its recurring
themes. The top level shows both where the topic began and how it has evolved.
That keeps the agent on course without forcing an old goal to remain frozen
forever.

This does not replace the existing system that tracks whether a fact or decision
is merely observed, tentative, or strongly supported. That system still decides
how much authority a note has. The new levels are a map, not a permission slip.

The agent updates the map during the same background reading pass it already
uses, so this does not add a second AI call for every message. A new chapter can
start immediately only when the user clearly says the focus is changing and the
system can point to those exact words. Subtler changes need to show up twice
before the chapter switches. The agent cannot switch chapters on its own.

Those background reading passes can finish out of order. The map keeps a small,
hard-capped reorder journal so a delayed earlier chapter change is inserted at
the right conversational turn without replacing newer whole-topic or
current-work summaries. Facts created by later turns move to the corrected
chapter. Both that journal and retained chapter history have strict size caps.

The opening goal is stored separately from the confidence-scored notes. Those
notes intentionally fade when they stop being mentioned; the opening landmark
must not, because it is most valuable after the conversation has moved far away.
That landmark is orientation only—it does not overrule a later confirmed
decision.

The map is then placed at the top of the conversation briefing, both when a new
Telegram message arrives and when the session recovers from compaction. The
shipped upgrade path is tested too, because the previous clean-install template
knew how to fetch that briefing while the generated installed hook did not.
The tests execute both clean and generated hooks, including server-error cases
where raw history must still arrive. Finally, if the background reader misses
several turns, the briefing says it is stale instead of presenting old
orientation as current truth.
