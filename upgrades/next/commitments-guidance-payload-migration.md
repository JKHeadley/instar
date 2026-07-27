# Commitments guidance payload migration

## What Changed

Existing agents whose `CLAUDE.md` still had the stale `/commitments` curl payload now get it rewritten on update. The fixed payload includes `agentResponse` and uses `type:"one-time-action"`, matching the live `POST /commitments` contract.

## What to Tell Your User

This is an agent-instruction repair. It does not change the commitments API; it makes already-installed agents' local guidance match the API so future promises can be registered durably.

## Summary of New Capabilities

No new capability. This is migration parity for an already-shipped Commitments & Follow-Through instruction.
