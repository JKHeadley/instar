# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Ninth increment of the approved agent-held Google passkeys spec
(`docs/specs/agent-held-google-passkey.md` §4, §5.2, §13, §3.2). Every granted account on a machine
now carries a health state decided purely from its proof outcomes — `healthy`, `degraded` (a failure
confirmed by a second proof an hour later), `breaker-open` (three confirmed weekly failures),
`unverified` (three unknowns, retried on a 7 → 14 → 28-day backoff), `unverified-stopped`, `rejected`
(Google no longer accepts the key) or `security` (the key signed in as a different account; terminal
until re-enrolled) — with a 21-day no-proof clock that pauses while the pool read path is degraded,
a flapping flag, and a states-only audit log. Everything that needs a human lands in ONE attention
item under a fixed key, refreshed every five minutes: buzzing at most once a day, security and
suspension once per tick, peer-list changes silently, and resolving when nothing is left. The
operator can record that a passkey was removed on Google when the automatic check cannot run; it is
shown as attested, never as removed.

Still dark: nothing enrolls, proves or uses a passkey yet, so no outcome is recorded by anything but
the routes themselves.

## What to Tell Your User

Nothing changes for you in this update. It's groundwork: when passkeys are eventually in use, your
agent will keep one calm summary of any account whose passkey stopped working, instead of a stream of
notices.

## Summary of New Capabilities

- `GET /passkeys/health`, `POST /passkeys/health/outcome`, `POST /passkeys/health/digest/refresh`.
- `POST /passkeys/attest-google-removed` (dashboard PIN; also a `passkey-cell` op).
- The pool state now publishes each cell's real health and Google-side state.

## Evidence

- `tests/unit/passkey-cell-health.test.ts` (the §4 table, the 21-day clock and its pool-degraded pause,
  flapping, the store's states-only audit, the digest's buzz rules);
  `tests/integration/passkeys-cell-health-routes.test.ts` (outcomes, attestation as PIN and as a
  mandate, lease-holder vs non-holder digests, a missing sink);
  `tests/e2e/passkeys-cell-health-lifecycle.test.ts` (feature alive over HTTP incl. the timer seam;
  dark on the fleet).
