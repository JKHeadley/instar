<!-- bump: patch -->

## What Changed

Adds a duplicate-response guard around Express JSON/send-style response methods and hardens the shared
error handler so late errors after an already-sent response are logged instead of attempting a second
500 response. A source-level route audit test now guards the classic missing-return shape where an
early response branch falls through to a later direct response.

Evidence: `tests/unit/duplicate-response-guard.test.ts`, `tests/unit/route-double-send-audit.test.ts`.
Side-effects review: `upgrades/side-effects/double-send-route-guard.md`.

## What to Tell Your User

Instar now has a server-side safety net for accidental duplicate HTTP replies. If a route sends a
response and then a late error path tries to send another one, the server logs the duplicate attempt
instead of crashing that request path.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Duplicate response suppression | Automatic for server routes |
