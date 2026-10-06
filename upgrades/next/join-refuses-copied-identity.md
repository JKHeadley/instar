# A joining machine never adopts another machine's identity

## What Changed

`instar join` used any existing `.instar/machine/identity.json`, so a second machine set up from a copied agent home claimed the first machine's id (ACT-1302, Luna/sagemind's Studio booted as the laptop).

- `POST /api/pair` refuses `409 joiner-identity-is-inviter` when the joiner presents the inviter's own machine id, before the pairing code is checked (no attempt spent, no state change).
- `instar join`: an identity whose private signing key is not on this machine is first offered to boot identity recovery (keychain-authenticated key rebuild keeps the id). If recovery does not restore it, the identity and key files (current and legacy names) are renamed `*.copied-<timestamp>` and a fresh standby identity is minted. On the inviter's 409 the joiner does the same and retries once.

## What to Tell Your User

If you set up a second machine by copying my folder from the first, it now creates its own identity instead of pretending to be the first machine. A machine that has only lost its keys still recovers its own identity.

## Summary of New Capabilities

- `/api/pair` names a copied identity (`joiner-identity-is-inviter`) instead of accepting it.

## Evidence

- `tests/e2e/multi-machine-http.test.ts`: on the real server path, the inviter's own id is refused with 409 and the code is not spent.
- `tests/integration/pool-noninteractive-pairing.test.ts`: the inviter's own id is refused with 409, the code is not spent, the registry is unchanged; all 8 pass.
- `tests/unit/join-copied-identity.test.ts`: a copied identity is set aside (renamed, kept) including legacy key names, and a fresh identity with a different id is minted.
- Independent second-pass review: two concerns raised and fixed (see `upgrades/side-effects/join-refuses-copied-identity.md`).
