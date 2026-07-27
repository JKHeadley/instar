# PATCH actions strict body

## What Changed

`PATCH /evolution/actions/:id` now rejects unsupported request fields instead of acknowledging a write it will discard. The route accepts the documented update surface, `status` and `resolution`, validates those values before mutation, rejects bodies with no usable update, and passes only explicitly present supported fields into `updateAction`.

Before this change, a caller could send a field such as `title`, receive `{ "ok": true }`, and still have the stored action title remain unchanged. That made a failed correction look recorded.

## What to Tell Your User

The action update API is now honest about what it can change.

If an agent or script tries to change a field this route does not support, it now gets a clear error that names both what it sent and what is actually supported. That prevents the worst version of the bug: your agent being told the change was saved while it was quietly thrown away.

The normal path is unchanged — updating an action's status, its resolution, or both, still works exactly as before. Anything that needs to edit a title, description, priority, tags, due date, or source belongs on a route that genuinely supports those, rather than one that used to pretend it had.

## Summary of New Capabilities

No new endpoint or config key. The existing evolution action patch route gained strict request-body validation and now fails loudly when a caller asks it to update fields it does not own.

## Evidence

Added integration coverage in `tests/integration/evolution-actions-patch-route.test.ts` for:

- unsupported fields returning `400` while the stored record remains unchanged
- valid `status` plus `resolution` updates still persisting
- empty usable update bodies returning `400`
- missing action IDs still returning `404` after a valid update body
- invalid status values returning `400` before any write

Typecheck evidence: `npx tsc --noEmit`.

## Known Limits

This is a breaking change for callers that were sending extra fields and depending on a `200` response. The documented callers send only `status` and `resolution`, so the known supported path is unchanged. The broken callers are the ones whose extra fields were already being ignored.
