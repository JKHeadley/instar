# Upgrade Guide — Bounded Local Source Records

## What Changed

The private history writer can now prepare a one-use size plan for the database records that remember where local conversations came from. It verifies the supported SQLite settings and enforces a native page limit before creating or inserting those records. It preserves unresolved journals for recovery and keeps existing history intact when the new write cannot fit.

## What to Tell Your User

“I am building checks for both conversation content and the records that prevent copying it twice. This update adds the database-write check. Importing through the app is still unfinished.”

## Summary of New Capabilities

| Capability | How to Use |
|---|---|
| Bounded writes for local-source identity records | An internal foundation for the upcoming import flow. There is no new control to use yet. |
| Explicit refusal of unresolved database recovery state | The import flow must complete recovery before starting another write. |

## Evidence

Focused checks cover the actual SQLite page ceiling, rollback preserving existing claims, exact zero-growth activation, sidecars/WAL headers refused before opening, actual journal content, and real process death before/after claim commit. Existing content/source-ownership and provider compatibility remain separate verification. No complete import, real parent reservation, fresh copy consent, installed acceptance or full-suite result is claimed here. Remaining work is tracked in Easy Setup topic143810. <!-- tracked: topic-143810 -->
