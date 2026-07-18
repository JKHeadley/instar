# Continuation expiry recovery

Codex task continuation now has a supported `renew` operation for starting a fresh bounded generation without rebuilding or reopening its checklist. Continuation status includes its start and expiry timestamps, and the CLI honors externalized authentication through `INSTAR_AUTH_TOKEN` or the configured environment reference.
