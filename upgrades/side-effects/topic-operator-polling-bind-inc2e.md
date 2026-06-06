# Side-effects review — Topic Operator polling-path auto-bind (Know Your Principal #898, increment 2e)

## What this change does
Closes the auto-bind gap #909 documented: the adapter long-poll (no-lifeline)
ingress path never bound the verified operator. The bind now lives at the
`onTopicMessage` seam in `wireTelegramRouting` (src/commands/server.ts) — the
convergence point BOTH ingress paths reach — so a no-lifeline install learns its
operator too. Three coordinated pieces:

- `wireTelegramRouting` gains a late-bound `getTopicOperatorStore` parameter
  (the `getHubDeps` precedent in the same function) and an additive bind block
  early in the callback: an AUTHENTICATED + AUTHORIZED sender is recorded as the
  topic's verified operator.
- `AgentServer.getTopicOperatorStore()` — public read-only accessor so the seam
  resolves the server's OWN store instance at message-time.
- `TopicOperatorStore.setOperator` idempotency guard: an identical record skips
  the disk write (both paths re-bind per message; unchanged = pure read).

## The load-bearing security property
The seam fires for unauthorized senders too — the lifeline path only skips its
own bind, it does not drop the message. So the `isAuthorizedSender` check INSIDE
the seam bind is load-bearing: without it, an unauthorized group member could
seat themselves as operator (the cross-principal "Caroline" bug). The
integration Caroline replay proves the refusal — an unauthorized sender with
`firstName: "Caroline"` cannot displace the bound operator.

## Why the SAME store instance (the lost-update hazard)
`TopicOperatorStore` caches its map in memory (`this.cache`). A second instance
on the same file would hold a divergent cache: a record written through one
instance disappears from the other's next full-map save. The original Inc-2e
scout suggested constructing a fresh store inside the callback — that design is
REJECTED here for exactly this reason. Instead the seam resolves
`AgentServer.getTopicOperatorStore()` late-bound (module-level `_agentServerRef`
assigned right after construction; the server is built long after routing is
wired). The integration no-clobber test pins the invariant.

## Blast radius (hot path — reviewed carefully)
- **Additive + fail-soft.** The bind block is wrapped in try/catch; a getter
  error, store error, or missing uid logs and falls through — message routing
  is never affected. Proven by unit tests (getter throws / setOperator throws /
  null store → handleCommand still runs).
- **Pre-construction window.** Messages arriving before `_agentServerRef` is
  assigned bind nothing (getter → null). Fail-safe: no binding means "unknown",
  never a wrong operator. Lifecycle test covers the transition.
- **Lifeline double-bind.** On the lifeline path both the routes-side bind
  (#909) and the seam bind run — same instance, same record; the new
  idempotency guard makes the second a no-op read.
- **Disk-write reduction (behavior change, benign).** `setOperator` with a
  byte-identical record no longer rewrites the file. Callers only ever read the
  returned record or the store state — both unchanged. Existing store tests
  (12) stay green; 2 new tests pin both sides (identical skips, changed
  writes).
- **No new route / config key / dependency.** `wireTelegramRouting` is now
  exported (test seam only; no runtime caller change beyond the two existing
  callsites gaining the getter argument).

## No-allowlist trust model (unchanged, documented)
`isAuthorizedSender` semantics are #909's: with no `authorizedUserIds`
allowlist, every authenticated sender is accepted, so the operator is the
most-recent authenticated sender. Consistent with the existing trust model;
the uid is Telegram-authenticated, never a content name
(`TopicOperatorStore.setOperator` enforces that by construction, #904).
