# Side-effects — /a2a/inbox accept-boundary

## 1. What files/state does this touch at runtime?
`installAgentMessageHook.ts` — the role-handler invocation in the agent-message hook. No new files,
config, schema, or state. The role handler still runs (now in the background); the idempotency mark
and ledger row are unchanged.

## 2. Does it change any functional behavior?
The `/a2a/inbox` HTTP response now returns `{handled:true}` immediately after the message is validated
+ marked processed, instead of after the (minutes-long) role handler completes. The handler runs in
the background and delivers its reply on its own a2a channel exactly as before. Net: the sender no
longer times out (its ~10s `AbortSignal.timeout`) and no longer logs a false "delivery failed".

## 3. What happens on failure / weird config?
A background handler rejection is caught and logged (`console.error`), exactly as the old `try/catch`
did — just on a later microtask. The id stays marked processed (unchanged). Validation failures
(unknown role, spoof, already-processed) still short-circuit BEFORE the handler, unchanged.

## 4. Migration parity — do existing agents get it?
Yes, via the normal release — code-only, compiled into `dist`. No agent-installed file / config /
template change → no `PostUpdateMigrator` pass.

## 5. Could it spam / flood / burn resources?
No — it REDUCES resource use (no 10s held connection per mentor a2a message). Same single handler
run, no new timers/IO/network. The idempotency mark still bounds duplicate processing.

## 6. Rollback / off-switch?
Revert the one block (re-`await` the handler). No data, no migration, no flag. Mirrors #581/#3
rollback.

## 7. Concurrency / ordering?
The handler now runs after the response returns instead of before. The idempotency `markProcessed`
still happens BEFORE the response (so retries dedup). The reply-out is unchanged (a separate a2a
send). A background handler error cannot affect the already-sent response.

## Blast radius
Small + additive: one block in `installAgentMessageHook.ts` swapped from await-then-respond to
respond-then-background. Exactly mirrors the proven #581 (`/messages/relay-agent`) and #3
(`/threadline/messages/receive`) accept-boundaries. Only the a2a role-handler dispatch timing
changes; validation, idempotency, ledger, and the reply path are untouched.
