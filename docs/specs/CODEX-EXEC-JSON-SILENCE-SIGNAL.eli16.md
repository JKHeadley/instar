# Why a frozen Codex background job went unnoticed for 8.5 hours

The system has a watchdog whose job is to notice when one of these AI agents
freezes in the middle of doing something. The idea is simple: if an agent was
clearly busy and then went completely silent for a long time, the watchdog steps
in, gives it a nudge, and raises an alarm if it stays stuck.

To avoid crying wolf, the watchdog first decides whether the agent even LOOKS
busy. An agent just sitting quietly waiting for the next instruction is not
"stuck" — it is simply resting. So the watchdog only pays attention to agents
whose screen shows signs of active work.

The trouble was in how it recognized "active work" for agents built on the Codex
engine. It was taught to look for the things Codex shows in its normal
interactive window — a little "Working..." status line, a spinning indicator,
and so on. But when Codex runs a background job, it does not show that friendly
status line at all. Instead it prints a stream of structured machine-readable
progress messages — short lines that announce things like a new turn starting or
an item finishing. The watchdog did not recognize any of those as "work," so it
concluded these background Codex jobs were idle and ignored them completely.

That had a real cost. One background Codex job got stuck waiting on a reply that
never came and sat frozen for eight and a half hours. The watchdog never noticed,
because it had decided that job was not the kind of thing it watches.

The fix teaches the watchdog to recognize Codex's background progress messages as
a sign of real work. Now when one of those jobs is streaming its progress lines,
the watchdog counts it as busy and keeps an eye on it. If the progress lines stop
coming for too long, the watchdog finally does its job: it notices the freeze,
nudges, and raises the alarm.

Two safeguards stay in place. First, all of Codex's normal interactive signals
still count, so nothing changes for an agent you are watching live. Second, an
important earlier guard is preserved: the system still refuses to treat Codex's
plain "I am idle" status line as work, so it will not go back to falsely thinking
every resting agent is busy. The change only ever lets the watchdog catch MORE
freezes, never fewer.
