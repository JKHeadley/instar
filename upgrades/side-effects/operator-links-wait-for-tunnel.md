# Side-Effects Review — operator links wait for the tunnel

**Version / slug:** `operator-links-wait-for-tunnel`
**Date:** `2026-11-09`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 1, 8 source files plus 4 test files, about 200 lines. Effort: no spec rounds (Tier 1), one commit.

Founding case: 2026-11-09 20:40 PST. Right after a server restart, the sign-in repair approval reminder (`SubscriptionReloginApprovalReminder`, PR #3010) ran before the tunnel was up and sent the operator `http://localhost:4042/dashboard/console/#/capacity/accounts?s=needs`, which a phone cannot open.

- `src/server/dashboardPaths.ts`: new shared `createOperatorLinkOriginResolver` returning `public` (tunnel up), `local` (no tunnel configured, or a configured tunnel down past a 30-minute ceiling), or `pending` (configured, not up yet). Plus `originOrNull` and `PublicLinkPendingError`.
- `src/core/SubscriptionReloginApprovalReminder.ts`: `remind` may return `'deferred'`; the spell is not marked sent and the next pass (15 min) retries.
- `src/commands/server.ts`: one resolver over the agent's `tunnel`; the reminder returns `'deferred'` while pending; the sign-in repair notify throws `PublicLinkPendingError` while pending when its summary carries the link (the notification store retries with its existing backoff, 5 s doubling to 320 s).
- `src/feedback-factory/{triage,execute}`: `dashboardLink` may be null (pending). The triage action list waits (`public-link-pending`, nothing stamped); executor action items return none. Builders take an optional `tunnelConfigured`, which `AgentServer` passes.
- `src/server/routes.ts`: the scope-accretion ratifier link used localhost even with a tunnel up; it now uses the resolver and omits the link while pending (the reply-to-ratify path is the primary path and still works).

## Decision-point inventory

- No new block/allow decision on message content. The change decides WHEN a link-bearing operator notice is sent (now vs next pass), based on one fact: is a configured tunnel up.

---

## 1. Over-block

- A notice is held while a configured tunnel starts. Normal start is seconds; the reminder's next pass is 15 minutes later, the relogin notices retry within minutes. Acceptable delay for a link that would otherwise not open.
- A tunnel that never comes up: held for at most 30 minutes, then sent with the local link. Not swallowed.
- The phone-tap sign-in prompt (URGENT, time-bound) carries no link and is never held. Closing a finished repair's row returns before the check and is never held.

## 2. Under-block

- `routes.ts` Drop Zone truncation hint (injected into a session, not sent to the operator) still uses tunnel-else-localhost; it is agent context, not a notice, and the agent relays it. Left as is.
- `UpgradeNotifyManager.buildPrompt` has the same shape but the class is not constructed anywhere in `src/`. Left as is.
- Paths that use `tunnel.getExternalUrl()` (selectivity digest, memory links) already return null without a tunnel URL and fall back to plain words, not localhost.
- A tunnel URL that is set but dead (tunnel mid-reconnect with a stale URL) is still used; that is the tunnel manager's own contract (`getExternalUrl` never returns a dead URL after switch-back).

## 3. Level-of-abstraction fit

The rule lives in one dependency-free helper beside the existing `consolePageUrl`, and each producer decides how to wait using its own existing retry path (reminder pass, notification store backoff, daily-list tick). No new scheduler or queue.

## 4. Signal vs authority compliance

No brittle authority added. The only input is a fact (is a tunnel configured, does it have a URL). Holding is bounded by a ceiling, so it can delay but never suppress a notice. Reference: `docs/signal-vs-authority.md`.

## 5. Interactions

- The relogin notification store's retry has no attempt cap and backs off to 320 s; a held notice therefore re-tries roughly every 5 minutes until the tunnel is up or the 30-minute ceiling passes. The claim lease (60 s) is released by `retryNotification`.
- The triage daily list stamps `action_list:last_day` only after delivery; returning before compose leaves nothing stamped.
- The resolver in `server.ts` is shared by the reminder and the relogin notify, so the 30-minute clock is measured from the first time either saw the tunnel down; each feedback builder and the ratifier holds its own resolver (same rule, independent clock).

## 6. External surfaces

Operator-visible: some notices arrive a few minutes later after a restart, with a working link. No API, config or stored-state change. The new `tunnelConfigured` builder input is optional and defaults to "no tunnel" (old behavior for callers that do not pass it).

## 7. Multi-machine posture

Machine-local by design: each machine's notices use that machine's tunnel. A standby machine without a tunnel configured keeps the local link exactly as before.

## 8. Rollback cost

Revert the commit. No state, config or migration.

---

## Second-pass review

Independent reviewer subagent, 2026-11-09: held notices are never marked delivered (the reminder skips `sent.add`; the relogin notify throws before the attention item and the drain loop retries without completing); the phone-tap prompt and row closes are never held; wiring of `tunnelConfigured` is correct. Noted cost: each held relogin try raises `attemptCount`, so a real delivery failure right after a long hold starts at the 320 s backoff cap rather than 5 s. Accepted (bounded, rare).

Concur with the review
