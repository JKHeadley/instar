# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Tenth increment of the approved agent-held Google passkeys spec
(`docs/specs/agent-held-google-passkey.md` §3.8, §3.6, §5.1, §4, §2). The **cold proof** exists: the
operator can ask a machine, from the dashboard (PIN), to prove right now that it can sign in to Google
as an account with the passkey it holds — from a browser profile that is cleared and confirmed signed
out first, with the stored key added to a virtual authenticator only after that check, the identifier
filled, the passkey prompt's Continue pressed, the signed-in identity read, and the key removed and
the profile signed out again whatever happened. A proof is `ready` only when Google actually asked for
and received an assertion from the stored credential id, the authenticator held exactly that one key,
and the expected account is the one signed in. The same key signing in as a different account is
`security`; the not-recognised page is `credential-rejected`; a risk page, a throttled prompt or a
transport failure is `unknown`. Every proof pays the pool admission first (a peer that cannot be read
refuses it; six hours between proofs of one account on different machines; active pauses), takes the
machine's single browser seat, writes its attempt row before it runs, and records its outcome into the
cell's health with operator provenance. A risk page pauses the account for seven days; a throttled
prompt pauses the account for a day and the machine for an hour.

Also fixed on the way: this machine's own attempt and pause rows are now read live for every
admission decision instead of from the five-minute pool memo, so a pause written seconds ago is
honoured immediately.

Still dark: nothing enrolls a passkey yet, so no real cell holds a credential and the proof is only
ever exercised against the local WebAuthn fixture (with real headless Chrome in CI).

## What to Tell Your User

Nothing changes for you in this update. It's groundwork: when passkeys are in use, you'll be able to
ask your agent to check a machine's passkey right now and get a straight answer — works, doesn't, or
couldn't tell — without it ever leaving a signed-in Google session behind.

## Summary of New Capabilities

- `POST /passkeys/prove` (dashboard PIN): the operator-triggered cold proof of one cell on this machine.
- Proof outcomes flow into the cell's health with operator provenance; risk and throttle pauses are
  written on the machine's ledger and read by every peer.

## Evidence

- `tests/unit/passkey-cold-proof.test.ts` (the ordering guarantees, the three `ready` conditions,
  security / rejected / throttled / risk / transport paths, teardown on every path);
  `tests/integration/passkeys-cold-proof-routes.test.ts` (gates, admission, pauses, the seat, a
  partitioned peer, the cross-machine same-account gap);
  `tests/integration/passkey-cold-proof-fixture.test.ts` (real headless Chrome against the local
  WebAuthn fixture: ready, security, credential-rejected, and the wired route);
  `tests/e2e/passkeys-cold-proof-lifecycle.test.ts` (feature alive over HTTP; dark on the fleet).
