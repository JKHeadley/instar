# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**Multi-Machine Session Pool — non-interactive, code-authenticated pool join
(still dark).** An active-active pool has to form its mesh automatically, so a
machine can't require a human to confirm matching visual symbols (SAS) to join.
Pairing is now code-authenticated: `instar pair` persists a short-lived,
single-use pairing code (via the new `PairingSessionStore`), and the awake
machine's `/api/pair` endpoint validates the code presented by `instar join`,
then auto-registers the joiner as **standby**, stores its public keys, and
records its URL. The code (carried over the TLS tunnel) is the shared secret —
single-use, attempt-capped, time-limited; a joiner can only ever become standby.
This closes the one-directional-pairing gap (the awake machine now learns the
joiner without an interactive step). The whole layer stays gated behind
`multiMachine.sessionPool`.

## What to Tell Your User

Nothing changes yet — still off by default. It makes a multi-machine pool able to
form its mesh automatically (no per-machine visual-symbol confirmation) when the
pool is enabled.

## Summary of New Capabilities

- `PairingSessionStore` — persists the active pairing session so the running
  server can validate a join code non-interactively.
- `/api/pair` now validates the code + auto-registers the joiner (standby) +
  exchanges URLs/keys, instead of being signal-only/interactive.

## Evidence

- Unit: `tests/unit/pairing-session-store.test.ts`.
- Integration: `tests/integration/pool-noninteractive-pairing.test.ts`
  (valid/wrong/locked-out/no-session/consumed/malformed) + updated legacy
  `machine-routes.test.ts` assertion.
- Side-effects + security analysis: `upgrades/side-effects/noninteractive-pool-join.md`.
