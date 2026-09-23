# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Sixth increment of the approved agent-held Google passkeys spec
(`docs/specs/agent-held-google-passkey.md` §3.2). Taking back a passkey permission on another of your
machines no longer depends on that machine being reachable at that moment: the signed revoke is kept in a
durable outbox and re-delivered unchanged — right away, then after an hour, six hours, and daily — until
the machine confirms it. A machine seen coming back online is tried sooner. After thirty days without a
confirmation the agent raises one attention item per machine naming the accounts involved, stops the
automatic retries, and makes exactly one more attempt when that machine next appears.

Still dark: nothing mints or uses a passkey yet.

## What to Tell Your User

Nothing changes for you in this update. It's a safety net for later: when you eventually take a passkey
back from one of your machines, that instruction can't get lost just because the machine was asleep.

## Summary of New Capabilities

- Durable, re-delivered revokes for passkey permissions on peer machines, with backoff and a 30-day
  escalation.
- `GET /passkeys/outbox` to see what is still pending; `POST /passkeys/outbox/tick` to run a pass now.

## Evidence

- `tests/unit/passkey-revoke-outbox.test.ts`; `tests/integration/passkeys-grants-routes.test.ts`
  (queued-then-applied flow across two in-process machines); the `passkey-revoke-outbox` model in
  `tests/unit/self-action-convergence.test.ts`.
