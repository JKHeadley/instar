# Secret Drop values stay on the machine that received them

## What Changed

A secret pasted into a Secret Drop page is now kept only on the machine that received it. Cross-machine secret sync no longer sends Secret Drop values to other machines, and a machine that receives a sync batch from an older sender ignores any Secret Drop values in it (counted, never named) while applying everything else as before. A sync push can therefore no longer overwrite the Secret Drops a machine received itself. Consuming a received secret now removes its stored copy first: if that fails, nothing is consumed and the caller is told to try again, instead of being told it was consumed while a copy remained.

## What to Tell Your User

Nothing changes when you hand your agent a secret. Copies of secrets already handed over before this update stay on your other machines until they are used or removed there.

## Summary of New Capabilities

None. Security hardening of Secret Drop storage across machines.

## Evidence

Reproduced in tests: a sync batch carrying Secret Drop values from an older sender previously replaced the receiving machine's own unretrieved drops; now they are stripped and the rest of the batch is stored. A consume whose stored-copy delete failed previously answered `consumed: true` with the copy still stored; now it answers 503, keeps the value, and a retry succeeds.
