## What Changed

Codex task continuation now has a supported `renew` operation for starting a fresh bounded generation without rebuilding or reopening its checklist. Continuation status includes its start and expiry timestamps, and the CLI honors externalized authentication through `INSTAR_AUTH_TOKEN` or the configured environment reference.

## What to Tell Your User

Long Codex task drives can now be safely renewed without losing completed checklist state, and their expiry time is visible.

## Summary of New Capabilities

- Renew an existing continuation ledger as a fresh bounded, audited generation.
- Inspect the ledger's start and expiry timestamps.
- Use continuation CLI commands with externalized authentication.

## Evidence

- 17 focused store tests and 12 continuation/autonomy route tests pass.
- TypeScript build and repository lint pass locally.
