# ELI16 — cross-machine sync could go silently dead

When machines coordinate, they agree on who is in charge by committing a small record and pushing it
to the shared repository. That push was written as a plain `git push` with no argument.

A plain `git push` only works if the branch already knows where to push to. On a branch that does not,
git refuses. The code caught that refusal and returned "false".

The trouble is that "false" is what the same function returns when there was simply **nothing to
send**. So a machine whose pushes were all failing looked exactly like a machine that had nothing to
say. Its records piled up locally and never reached anyone, and nothing anywhere reported a problem.

This was reported from real hardware back in May — one machine's coordination records committing
locally and never reaching the shared repo, with no logs. Reading the code today, it is still there.

**The fix is deliberately small.** The plain push is still tried first, exactly as before. Only if it
fails does the code now ask git which branch it is on and try once more, saying explicitly where to
push. If pushing already worked, nothing changes at all.

I did not touch the "false means two different things" problem in the same change. It deserves its own
fix, and the code that consumes it already handles the ambiguity defensively, so the urgent half is
the push that never lands.

**How I know it works rather than believing it.** Two tests: one proves the explicit push happens when
the plain one fails, and one proves it does *not* happen when the plain one succeeds. With the fix
removed, the first fails and the second still passes — which is what tells me the first is testing the
fix and not something incidental.
