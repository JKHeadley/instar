# Commitments guidance payload migration

## What Changed

Existing agents whose `CLAUDE.md` still had the stale `/commitments` curl payload now get it rewritten on update. The fixed payload includes `agentResponse` and uses `type:"one-time-action"`, matching the live `POST /commitments` contract.

## What to Tell Your User

This is an agent-instruction repair. It does not change the commitments API; it makes already-installed agents' local guidance match the API so future promises can be registered durably.

## Summary of New Capabilities

No new capability. This is migration parity for an already-shipped Commitments & Follow-Through instruction.

## Evidence

Reproduced in dev against the old installed-doc payload: a `CLAUDE.md` containing
`-d '{"userRequest":"<what you promised>","type":"follow-up","topicId":TOPIC_ID}'`
failed the new migration test before the migration existed. The rejected body omits
`agentResponse` and uses a type outside the live `CommitmentType` union.

After the migration was added, the same test passed and asserted the rewritten payload contains
`agentResponse` and `one-time-action`. The test also runs the migration twice and confirms the
second pass makes no change. A negative control feeds a locally customized commitments curl that
does not contain the exact stale payload and asserts the file is byte-identical afterward with no
commitments-guidance upgrade recorded.
