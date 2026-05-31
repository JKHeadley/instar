# Side-effects — Relay-funnel accept-boundary

## 1. What files/state does this touch at runtime?
`ThreadlineEndpoints.ts`, the `POST /threadline/messages/receive` handler only. No new files, no
config keys, no schema, no persisted state. The spawn (`handleInboundMessage`) still runs — just in
the background instead of awaited.

## 2. Does it change any functional behavior?
- The success response changes from `{ accepted, threadId, spawned, resumed }` (after the 9-30s
  spawn) to `{ accepted: true, async: true, threadId }` (immediately). The `spawned`/`resumed`
  fields are gone (they required awaiting the spawn).
- The former `422`-retryable-on-`result.error` response is gone — but it was already unreachable by
  every real sender (they read only `response.ok` and abort at ~10s, before the spawn produced it).
- Auth, payload validation, and the missing-router 503 are unchanged.

## 3. What happens on failure / weird config?
A background `handleInboundMessage` rejection is caught and logged (`console.error`); it cannot
affect the already-sent 200 response. A reported `result.error` is logged (`console.warn`). The
missing-router 503 still fires synchronously before the accept response.

## 4. Migration parity — do existing agents get it?
Yes, via the normal release — code-only, compiled into `dist`. No agent-installed file / config /
template change, so no `PostUpdateMigrator` pass is needed.

## 5. Could it spam / flood / burn resources?
No — strictly fewer resources: it does the SAME single spawn, but the sender no longer times out and
retries, so it eliminates the duplicate spawn (the bug). No new timers, I/O, or network calls.

## 6. Rollback / off-switch?
Revert the one `ThreadlineEndpoints.ts` block (re-`await` the router and return its result) and the
test. No data, no migration, no flag. Mirrors #581's rollback.

## 7. Concurrency / ordering?
The spawn now runs after the response returns instead of before. The router's existing
`pendingSpawns` guard still blocks concurrent same-thread spawns. A sender that genuinely double-
sends (distinct content) is unaffected by this change (it was never the duplicate source the
accept-boundary targets — that was the timeout→retry of the SAME message).

## Blast radius
Small + additive: one handler block in `ThreadlineEndpoints.ts` swapped from await-then-respond to
respond-then-background-spawn. Exactly mirrors the proven co-located fix (#581). Only the relay-
funnel receive path is affected; the router, the co-located path, and all auth are untouched.
