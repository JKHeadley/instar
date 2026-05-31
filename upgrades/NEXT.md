---
review-convergence: complete
approved: true
approved-by: echo (standing 12h deploy mandate, topic 13481; multi-machine live-transfer cascade)
---

# Instar Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed — the encryption key now has the same legacy-name fallback the signing key got

A direct follow-up to the previous release. Each machine in a multi-machine setup
opens an encrypted channel to the others using two key files: a signing key and an
encryption key. The project renamed these files to canonical names at some point,
and a machine set up before that rename keeps its keys under the older names.

The previous release taught the signing-key loader to fall back to the older
filename. Deploying that revealed the identical gap one layer down: the
encryption-key loader was still looking only for the canonical name, so a
legacy-named machine got past the signing key and then threw an ENOENT on the
encryption key, leaving its mesh transport unable to fully initialize. This release
gives the encryption-key loader the same fallback.

## Summary of New Capabilities

- `MachineIdentity.loadEncryptionKey()` falls back to the legacy
  `encryption-private.pem` when the canonical `encryption-key.pem` is absent
  (rethrows if neither exists), mirroring `loadSigningKey()`.
- A machine whose identity predates the canonical key rename now resolves BOTH
  keys and completes its lease/transport setup without a hand-placed key file.

## What to Tell Your User

If you run your agent across more than one machine, a machine that was set up a
while ago will now join the encrypted group channel on its own, without needing
anyone to copy a key file into place by hand. This closes the second half of a pair
of identical gaps that were quietly stopping an older machine from fully joining.
Nothing to configure — it applies on the next update.

## Evidence

- Found live on the Mac mini: after the prior release resolved the signing key, the
  mini still logged a startup error, no such file encryption-key.pem, at mesh
  transport setup because it had only the legacy encryption-private.pem.
- Unit, `tests/unit/machine-identity.test.ts`: loadEncryptionKey falls back to the
  legacy name and still throws when neither file exists.
- 68 machine-identity tests pass; tsc --noEmit clean.
- Spec, `docs/specs/encryption-key-fallback.md` plus the .eli16.md sibling.
- Side-effects, `upgrades/side-effects/encryption-key-fallback.md`.
