## What Changed
The list of machines whose replicated data is excluded (dropped or revoked origins, `state/state-sync/dropped-origins.json`) no longer loses entries when its file is damaged. Before, a damaged file loaded as an empty or partial list, and the next add or remove wrote that partial list back, permanently erasing every other exclusion. Now a damaged file (unreadable, bad JSON, wrong shape or version, or any malformed entry):
- keeps every entry that can still be recovered as excluded, including entries naming other machines;
- is copied aside unchanged as `dropped-origins.json.damaged-<hash>` and left in place, so a restart still sees the damage;
- refuses adding or removing exclusions (an add still takes effect in memory, the safe direction, but is not written);
- raises one degradation naming the preserved copy and the repair.
`GET /state/quarantine` now carries `droppedOriginsHealth` (`healthy` or `damaged`, with reason, preserved copy and recovered count). A healthy file behaves exactly as before.

## What to Tell Your User
Nothing to do. If the file that remembers which machines' data I have cut off ever gets damaged, I now keep every cut-off I can still read and refuse to save over it, instead of quietly forgetting the rest. You would hear about it as a problem report I can repair.

## Summary of New Capabilities
- `GET /state/quarantine` → `droppedOriginsHealth` tells whether the excluded-machines list was fully trusted at startup.

## Evidence
- `tests/unit/RollbackUnmerge.test.ts`: healthy file mutates and persists; truncated, schema-invalid, empty, malformed-entry and unreadable files load as damaged, keep recovered exclusions, refuse add/remove, and leave the bytes on disk unchanged across a restart; unmerge/re-merge on a damaged registry move nothing.
- `tests/integration/state-sync-routes.test.ts`: the real route reports `damaged` with the preserved copy and recovered entries, and `healthy` for a normal file.
