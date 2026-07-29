# Development decision records now explain their scope

## What Changed

Development decision records now retain the exact staged source files and
added/deleted-line counts behind their compact file and line totals.

## Evidence

- The focused hook integration test verifies the persisted counting basis,
  file list, additions, and deletions.
- Existing compact `files` and `loc` fields remain unchanged for compatible
  readers.

## What to Tell Your User

Internal development audit records now explain exactly what their size
counters measured.

## Summary of New Capabilities

- Self-describing scope evidence for development decisions.
