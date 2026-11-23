# Upgrade Guide — Independent Lifecycle Test Resources

<!-- bump: patch -->

## What Changed
Four lifecycle fixtures now use independent files, logs and listening ports. The Mac reply-recovery fixture also stays within the Unix socket pathname limit. Production behavior is unchanged.

## What to Tell Your User
This fixes unreliable automated checks when several working copies are tested together. The setup and history-import updates still need complete normal verification.

## Summary of New Capabilities
None. This is test isolation work.

## Evidence
Full lifecycle runs exposed one shared Mac socket failure and five additional shared-input, shared-log and fixed-port failures. All 34 checks across the four corrected lifecycle files pass, including a new assertion that cleaning up one sentinel rig preserves another rig’s log and future writes.
