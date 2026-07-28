# Autonomous Throughput Floor, in plain language

This feature is a quiet instrument panel. It checks two facts for an active autonomous run: whether the
project's pull requests have produced a real code-changing advance, and whether the manager has sent the
user any message. If both have stayed unchanged for 75 minutes, the panel says “flatline observed.”

It does not message anyone, restart anything, assign work, or try to repair the run. It only records the
measurement and makes it available in the authenticated dashboard/API. Reads are capped and slow down
after failures; after four failures they pause for six hours, and that pause survives restart.

A missing or damaged record never becomes an alert. It starts a fresh baseline or shows “unknown.” A run
moving between machines, a multi-machine run, incomplete message history, or an unreadable repository is
also shown honestly as unavailable instead of guessed.

The old HOLD safety rule is preserved: passive waiting is legitimate only when a real operator approval is
open and every other work lane is proven full. This first version cannot prove lane fullness, so it never
grants HOLD.

Sending proactive attention later is separate work. It needs a separately designed and approved
SelfHealGate. There is no hidden switch in this version that can turn the read-only panel into an actor.
The implementation commit also carries the repository's required decision-audit evidence.
