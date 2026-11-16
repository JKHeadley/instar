<!-- bump: patch -->
## What Changed

The feedback executor's independent review now leaves out the two files the executor itself adds to each fix after the confined session finishes: its decision-audit record under `.instar/instar-dev-decisions/` and its release note under `upgrades/next/`. A file is left out only when it is a new file at this fix's exact paths and its bytes equal what the executor writes, rebuilt for that attempt. Any edit made after publishing keeps it in view. The review prompt names the omitted files in trusted text. Without this, the review rule that treats any `.instar/` edit as a finding refused every executor PR after #3209 (first seen on PR 3235). Rule 2 still applies to every other path, and the CODEOWNERS check still reads the full file list.

## What to Tell Your User

Automatic fixes for reported problems were being turned down by their own safety review because of a record the system adds itself. That is fixed, so good fixes can now be approved.

## Summary of New Capabilities

None. This is a fix to the existing feedback executor.

## Evidence

PR 3235 (2026-11-16 11:18Z) was refused by both reviewers. codex-cli named "Rule 2 — Tooling" on the executor's own `.instar/instar-dev-decisions/...json`, and claude-code named "Rule 2: edits under .instar/". New unit tests check that the path matcher accepts exactly the paths the real writers produce and rejects other branches, other `.instar/` files and other notes. They also check that the diff filter keeps every other file, and that the review prompt in a full publish flow omits both files and names them.
