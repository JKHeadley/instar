# Side-Effects Review — a joining machine never adopts another machine's identity

**Version / slug:** `join-refuses-copied-identity`
**Date:** `2026-10-05`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (see below)`

## Summary of the change

ACT-1302 (reported by Luna/sagemind, 2026-10-03): the Mac Studio, set up from a copy of the laptop's agent home, booted as the laptop (`justin-mbp`). `instar join` checked only that `.instar/machine/identity.json` existed ("This machine already has an identity. Using existing."), so a copied identity file made the joiner claim the inviter's machine id. Luna's Studio registry still carries the residue (a removed identity whose endpoints are the Studio's own; see #2123).

1. `POST /api/pair` (inviter) refuses with `409 joiner-identity-is-inviter` when the joiner presents the inviter's own machine id. The check runs before the pairing code is validated, so it spends no attempt and changes no state.
2. `instar join` (joiner): if an identity file exists but its private signing key is not on this machine, it first lets this machine's keychain rebuild the keys through the existing boot identity recovery. Only if that fails is the identity treated as a copy: the identity and any key files (current and legacy names) are renamed `*.copied-<timestamp>`, never deleted, and a fresh standby identity is minted. On the inviter's 409 the joiner does the same, re-establishes its pairing recovery root, and retries once.

## Decision-point inventory

- Inviter: one new refusal (joiner id equals inviter id).
- Joiner: whether an existing identity file is this machine's own.

## 1. Over-block

The inviter refusal can only match an identity that is literally the inviter's own id. On the joiner, a genuine identity whose key files are missing and which the keychain cannot rebuild (escrow disabled or dry-run, or no keychain backup) is set aside and replaced — the files are kept, so this is reversible, and such a machine could not have signed anything with that identity anyway.

## 2. Under-block

A copied home that also carries the inviter's private keys passes the joiner's key check; the inviter's 409 then catches it, and the copied keys (including legacy names) are set aside. A copy joined to a DIFFERENT inviter than the one it was copied from is not caught by the 409; the joiner check still catches it when the keys did not come along.

## 3. Level-of-abstraction fit

The inviter is the only party that knows its own id authoritatively; the joiner is where the bad file lives. Both sides act on what they know.

## 4. Signal vs authority compliance

The inviter refusal is a deterministic identity-equality check on the pairing endpoint (an existing authority); no brittle heuristic gains authority.

## 4b. Judgment-point check

Not a competing-signals decision: equality of ids and possession of a private key are facts.

## 5. Interactions

Reuses `runMachineIdentityBootRecovery` (keychain-authenticated key rebuild keeps the id, per the machine-identity-recovery rule) and the existing `establishPairingRecoveryRoot`. The 409 retry sits beside the existing `fresh-pairing-identity-required` retry.

## 6. External surfaces

A new 409 error code on `/api/pair`; two new console lines in `instar join`.

## 7. Multi-machine posture (Cross-Machine Coherence)

This change exists for multi-machine. The inviter refusal is evaluated on whichever machine issues the code; the joiner check is machine-local by design (it concerns this machine's own files).

## 8. Rollback cost

Revert; set-aside files remain on disk and can be renamed back.

## Conclusion

Stops a second machine from silently becoming the first, without breaking key recovery on a genuine machine.

## Second-pass review (if required)

Independent subagent reviewer, 2026-10-05. **Concern raised (resolved):** treating "no loadable signing key" as proof of a copy would have re-identified a genuine machine that boot recovery can heal from its keychain — fixed by running that recovery first and setting aside only when it does not restore the keys. **Minor (resolved):** legacy key file names were not set aside, leaving another machine's private key live — now renamed too. Confirmed sound: retry ordering (new identity plus recovery root before the retry; the request closure picks up the new identity), the fresh id passes IdentityStore's first-identity path, and answering 409 before the code check leaks only whether a submitted id equals a random 128-bit id.
