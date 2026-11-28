# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The local push check recognizes shared test inputs early and reuses its first list of affected files for narrow changes.

## What to Tell Your User

Local pushes can spend less time finding tests. The push log says what ran locally and when broader coverage will run in CI.

## Summary of New Capabilities

None — this improves an existing development check.
