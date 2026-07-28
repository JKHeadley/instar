# ELI16 — the new hook would have reached existing agents but not new ones

Instar installs its hooks down two separate paths: one runs when an agent is first set up, the other
runs when an existing agent updates. Both have to know about a hook, or it only exists for half the
fleet.

This pull request added the analysis-paralysis guard to the update path only. So every agent already
running would have picked it up, and every agent created afterwards would not have had it — quietly,
with nothing failing and nothing to notice.

That asymmetry has bitten this project before, which is why there is a test comparing the two lists.
It caught this.

The fix is one line: install the same hook on fresh setup too. There is an escape hatch — a list of
accepted gaps you can add a hook to with a written reason — and I did not use it, because there is no
reason a new agent should be without this guard. The gap was an oversight, not a decision.
