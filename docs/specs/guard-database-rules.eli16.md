# The command guard blocks database wipes again — plain-English overview

## What this is

Your agent has a safety guard that checks every shell command before it runs. Some commands are always blocked because they can't be undone, and others make the agent stop and ask you first. When the guard was first written it included rules for commands that wipe a database's structure, learned from a real data-loss incident. But updates install the guard from a second copy, and that copy had lost those rules, so every updated agent quietly stopped protecting against them. One of the original rules also never worked at all, because of a small mistake in how it was checked.

## What changes

All three copies of the guard now carry the same database rules, and the broken one works. A test now runs the real guards against these commands, so the copies can't drift apart again without the test failing.

## What you would notice

If your agent tries to wipe or force a database schema change, it stops and tells you, instead of running it. Ordinary database commands are not affected.

## What you need to decide

Nothing. It restores an existing safety rule, and a revert fully undoes it.
