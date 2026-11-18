# The conversation graph stops checking the same records three times in a row (ELI16)

## What this changes

The agent keeps a "conversation graph": a signed record of every conversation, project and change, copied between the owner's machines. Before it trusts a record, it checks the record's signatures and proofs. That check is careful and therefore slow: a few milliseconds per record.

When Accept all saves several projects, the agent re-checks some earlier background records (records that say "this conversation exists on this machine"). Each re-check went through every stored record three times in a row: once to find the records still waiting for confirmation, once to build the confirmed set, and once more on the confirmed set. With about 550 records that took 2 to 5 seconds per re-check, during which the server could not answer anything else: no page loads, no Telegram replies, no answers to the other machine. During one test Accept all on a two-machine test copy, this was about a third of everything the server was busy with.

Now each re-check goes through the records once. It looks at quick facts first ("is this record already final?") and only fully checks the few records that need it. Records the confirmed-set step just checked are not checked again a moment later. Two lookups that scanned the whole list for every entry, which grew with the square of the record count, became direct lookups.

## What stays the same

Every record that was checked before is still checked, and every answer is the same. The only records skipped on the third pass are ones fully checked a moment earlier in the same step, against the same signer. A record the agent rebuilt in that moment (its own record with a removal attached) is still checked again.

## Safeguards

A test pins both sides: a record verified against its own writer is reported as already checked, and the agent's own rebuilt record is not. Undoing the one commit restores the old behaviour, with no stored data to repair.

## What you need to decide

Nothing. This makes the server answer while Accept all runs, and it is one of the causes of held Telegram replies on 2026-11-17 and 18.
