# Feedback fix attempts survive restarts better

## What Changed
Two changes. A finished fix waiting to be re-checked could be thrown away if the lease number changed before its turn, because the code looked for the fix in a folder it had already moved. It now finds it there. Also, a fix attempt's setup and final checks run inside the server process, so a restart loses them. The executor now registers a restart hold during those stages; each hold ends after two hours at most, and the updater's existing deferral limit applies per version. The executor also stops starting new attempts while an update restart is waiting, so holds don't chain.

## What to Tell Your User
Finished feedback fixes are no longer thrown away while waiting for a re-check, and updates wait a limited time while a fix is in its final checks.

## Summary of New Capabilities
- Update restarts wait for a feedback fix attempt in setup or verification, up to a limit.

## Evidence
Unit: tests/unit/feedback-factory/execute-service.test.ts covers the adoption case and the hold; execute-wiring.test.ts covers the update brake. Integration: tests/integration/feedback-github-runtime-routes.test.ts confirms a real AgentServer registers the hold. Live on Echo, 2026-11-07: attempt f27da149:a8 recorded outcome fixed, was marked for re-verify at 02:17Z, and ended stale-epoch at 02:47Z with no checks run. The hold would not have saved that attempt; the adoption fix addresses it.
