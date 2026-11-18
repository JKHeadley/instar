# Joining a machine keeps nothing from an answer it can't trust — plain-English overview

## What this is

When you add a second computer to your agent, the new computer contacts the first one and gets back the agent's identity in a sealed package that it checks before trusting. The new computer also saved other parts of that reply without waiting for the check: two settings outside the sealed package, the other side's details as a trusted machine, and its Telegram connection details. So if the join was pointed at the wrong address, or something else answered in the first computer's place, all of that was kept and the join still said it had worked.

## What changes

The new computer now saves nothing from the reply until the sealed package checks out. If it doesn't, the join stops and tells you, and nothing is kept. A join to another computer over an unencrypted address now shows a warning. An old instruction about matching symbols on both screens, a step that no longer exists, has been removed.

## What you would notice

Nothing when a join works. A failed join leaves nothing behind.

## What you need to decide

Nothing. It is a fix, and a revert fully undoes it.
