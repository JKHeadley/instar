# Kept config promises can only restore settings the API itself may change

## What Changed

When the agent records a promise to keep a setting at a value, it checks the setting and puts it back if it drifts. That correction now writes only what the config API (`PATCH /config`) would accept from the same caller: the same list of settings, nothing that needs the operator's PIN, nothing that chooses which program a session runs, and nothing that raises trust or autonomy. A setting outside those rules is still checked and its drift is still reported, but it is no longer changed automatically. The rule lives in one place (`src/config/bearerConfigWrite.ts`) and uses the config API's own lists.

## What to Tell Your User

Nothing changes for ordinary settings your agent keeps for you. Settings that need your PIN or your approval are reported if they drift instead of being changed back automatically.

## Summary of New Capabilities

None. Security hardening of kept config promises.

## Evidence

Reproduced on a throwaway agent: with only the API key, a config promise plus one verification sweep wrote the PIN-gated flood-brake switch and the session program path, while the config API refused the same change without the PIN. With this change the sweep reports the drift and writes nothing.
