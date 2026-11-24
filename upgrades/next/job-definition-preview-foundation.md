# Job definition comparison foundation

<!-- bump: patch -->

## What Changed

Instar has an internal, bounded reader for evidence that a future Jobs migration preview can use. It compares local legacy and manifest inputs with the production validators. It leaves the effective result unknown when unchecked inputs could override it.

## What to Tell Your User

The preview is still being built. This update adds no Jobs action and changes no scheduled job.

## Evidence

Focused checks cover actual loader selections, suppressed definitions, conflicting manifest names, byte limits and cancellation. The internal reader has no active endpoint.
