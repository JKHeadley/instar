# How Instar should pick an account for new work

When Instar starts a session, it chooses which subscription account runs it. The rule is meant to be simple: send work to the account whose unused room will vanish soonest, so nothing goes to waste at a weekly reset.

The math behind that rule has three mistakes.

First, it mixes two different limits. Each account has a short limit that refills every five hours and a weekly one. The rule takes the room from the weekly limit but the deadline from the five-hour one. Since the five-hour limit almost always refills first, every account looks urgent, and an account whose week really is about to end can lose to one with six days left.

Second, it ignores the separate Fable limit on Claude accounts. A Fable session can be sent to an account whose Fable allowance is nearly used up, while another account still has plenty.

Third, it doesn't notice when a limit has already refilled. If the last reading came before a reset, the account is still judged by last week's number until a new reading arrives. A busy account that just reset can be skipped even though it is now nearly empty.

The fix pairs each limit's room with that same limit's deadline, counts the Fable limit for Fable sessions, and treats a limit whose reset time has passed as refilled (labelled as an estimate until a fresh reading arrives).

It starts on Echo's own machines only. Every time the new rule would pick a different account than the old one, it writes down both picks and why. After two weekly resets we look at that record and at whether sessions hit limits, and decide from that whether it goes to every agent. With the switch off, nothing changes.
