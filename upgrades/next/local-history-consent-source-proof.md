# Check signed source ownership evidence for history approval

## What Changed

The internal ownership verifier checks a stored capture signature, its exact target and its expiry. It requires a fresh lookup of the source machine and its current link to the destination owner.

## What to Tell Your User

The test preview can check signed ownership evidence. Copying real conversation history remains paused.

## Evidence

The signed and encrypted HTTP fixture checks exact evidence and refuses absent, stale, substituted, withdrawn and wrong-scope evidence.
