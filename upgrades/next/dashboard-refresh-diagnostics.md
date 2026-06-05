<!-- bump: patch -->

## What Changed

Dashboard link refresh failures now report actionable diagnostics instead of opaque command failures. The built-in refresh job gate and refresh command use Node's native request support, so they no longer depend on a shell HTTP client being installed. The dashboard-refresh route now reports which layer failed: missing Telegram setup, missing tunnel state, tunnel without a URL, local request failure, or Telegram broadcast failure.

The Telegram dashboard broadcast path also stops hiding hard send/edit failures from the scheduled refresh route. Best-effort pinning remains best effort, but failure to deliver the Dashboard message is now visible to the job.

## What to Tell Your User

Dashboard link refresh failures should now explain what broke and what to check next, instead of showing a vague job failure.

## Summary of New Capabilities

- The dashboard link refresh job gate and refresh command no longer depend on a shell HTTP client being installed.
- Dashboard refresh failures include the failed layer, detail, and next step.
- Telegram dashboard message delivery failures are surfaced to the refresh job instead of being hidden as success.

## Evidence

Focused diagnostics coverage passed with `tests/unit/dashboard-refresh-diagnostics.test.ts`, and the full TypeScript/lint gate passed.
