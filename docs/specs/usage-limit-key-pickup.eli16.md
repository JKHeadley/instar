# A new key during a usage limit now actually gets used — plain-English overview

## What happened

When an agent runs out of Claude usage and has only one account, Instar tells the operator and promises that waiting conversations will pick up by themselves once usage is back. The quickest way to get usage back is to put in a key from an account with room using the "set Claude key" command. The command says the agent picks the key up by itself.

In the live test on the nimbus test machine on November 7, it did not. A working key went in twice, and nobody got an answer for more than 13 and 16 minutes. The agent kept saying it was out of usage.

## Why

The part of the server that copies a newly saved key into use only ran while the server already believed the key itself was broken, or when a conversation was stuck at a sign-in screen. Running out of usage is neither of those, so the new key sat in the config file unused. The sessions and the check that asks "is usage back?" both kept using the old, empty account. Each check said "still out", so the agent never noticed usage was back, and no conversation was restarted.

## What changes

- The server now checks the saved key every minute, whatever state it is in, and puts a changed key into use straight away.
- While the agent is out of usage, the usage check reads the saved key first. A new key is tested on the very next pass (within a minute), not after a 10 to 30 minute wait.
- Each usage check writes one line to the log, so if this ever goes wrong again the cause can be read from the log.

## Safeguards

Nothing new is blocked. Whether usage is really back is still decided by a real call to Claude. A new key that is also out of usage keeps the limit in place and restarts nothing. A config file that can't be read keeps the last key, as before. Undoing the change is a plain revert, with no data to repair.

## What to decide

Nothing. This makes the existing promise ("your agent picks it up by itself") true. After it merges, the pickup part of the nimbus live test is run again to prove it.
