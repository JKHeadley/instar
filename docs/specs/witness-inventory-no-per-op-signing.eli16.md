# The record check stops signing receipts it throws away (ELI16)

## What this changes

The agent's "witness" keeps an independent, signed record of every change saved to the conversation graph. Several times a minute it produces an inventory: a signed list of everything it holds, so each machine can check it has the same history.

To build that list, the witness looked up each saved change through the same function other parts use to hand out a signed receipt for one change. So for every change in the list it created a fresh signed receipt, then ignored it. Signing is slow work, and with about 550 changes the inventory took 1 to 4 seconds on a busy machine, during which the agent answered nothing else.

Now the list is built from the same checked information without making the unused receipts. The inventory itself is still signed, exactly as before.

## What stays the same

Every change is still read and checked the same way, and anything that fails a check still stops the inventory with the same error. The receipt handed out for a single change, when one is asked for, is exactly the same as before.

## Safeguards

A test checks that building the list makes no signatures, that the single-change receipt still carries its signature, and that both agree on the change. Undoing the one commit restores the old behaviour.

## What you need to decide

Nothing.
