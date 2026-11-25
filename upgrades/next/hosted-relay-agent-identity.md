# Check the agent's key at a relay address

## What Changed

The test verifier checks the candidate agent certificate against the pinned owner record and current serving lease.

## What to Tell Your User

Finding an agent through the relay stays separate from trusting its key. The optional relay remains off.

## Evidence

Signed fixtures check key substitution, an authorized rotation, rollback refusal, and takeover with a newer lease.
