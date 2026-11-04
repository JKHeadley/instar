# Finishing rebalancing, in plain English

**What this is.** Your agent can run conversations on several machines. "Rebalancing" means that when
one machine gets too busy, a conversation moves to a quieter one by itself. The board said this step
was failing. It turns out it was never working at all, and the failing mark was about something else.

**What already exists.** Failover works: if a machine dies, another takes over. You can also move a
conversation by hand, and that closes it cleanly on one machine and picks it up on the other. A
separate feature, overload shed, watches for a machine that has stayed overloaded and picks a
conversation to move. It has only ever practised.

**What is wrong today.** Overload shed cannot see how much room other machines have, so it rules them
all out. If it could, it might choose a long-finished conversation, which frees nothing, and it would
not stop the running session, so the busy machine would stay busy. The rollout stage called
"rebalance" does not switch anything on, and its green marks came from a failover test.

**What is new.** Other machines' room becomes visible. Only conversations running but sitting quiet
are picked. A move uses the same careful handover as a manual move, and gives up rather than interrupt
a conversation that isn't quiet. A machine only sheds when it is really short of session slots, not on
a brief CPU spike. The "rebalance" stage becomes the actual on-switch. To earn it, each machine proves
itself: a labelled test conversation moves through the real path, and the proof passes only if the old
session is gone and the other machine answers exactly once. Before it counts as done, a real labelled
message through real Telegram has to be answered by the new machine too.

**The safeguards.** Nothing moves below the rebalance stage or without a fresh proof. A busy
conversation is never moved, and one with an autonomous run is left alone. At most two moves an hour,
one at a time, and a moved conversation stays put for 6 hours wherever it landed. One setting stops new
moves at once. Agents on one machine never see any of this. This frees session slots and memory, not
CPU, and it says so.

**What you need to decide.** Nothing for this part. The numbers that decide when it is ready for other
agents are in the plan, and the maturation review reads them.

The measured bars for this work live on the Overload shed entry of the maturation ladder.

**How the check message travels.** Real messages arrive at the machine in charge, so a proof run on any other
machine sends its check through that machine. The first live run showed why: the move worked, but a check sent
from the wrong place got stuck, and a good move was marked as a failure.
