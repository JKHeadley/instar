# Side-Effects Review — app signatures over another of the machine's routes

**Version / slug:** `app-origin-other-route`
**Date:** `2026-11-02`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Root cause (found by the second-pass review): `buildSignedOrigin` stored the PAIRED host in each signed record, while the phone signs the Host it actually used; over another route the stored record could never re-verify. Fix in two parts:

1. `src/server/mobilePairingRoutes.ts`: the device authenticator records the Host it verified the signature against (`deviceAdmittedHost(req)`); `src/server/mobileConversationRoutes.ts` `buildSignedOrigin` stores that Host.
2. `src/core/AppRecordSignatures.ts` `verifyRecordedOrigin`: a signed Host that differs from the ledger's paired Host is no longer an immediate `failed`; the record must then carry a receipt that verifies `ok` under this agent's machine key history (no receipt ⇒ `failed`, a bad receipt ⇒ `failed`, an unknown key ⇒ `unknown`). The device signature itself is still checked against the signed Host.

## Decision-point inventory

- `verifyRecordedOrigin` host check — modify — invariant: a deterministic cryptographic check; the receipt is the machine's attestation that it admitted the request on one of its own names.

## 1. Over-block

None added; the change only turns a false `failed` into `verified` when a receipt vouches.

## 2. Under-block

A record with another Host is trusted as far as the receipt: a machine of this agent that signs a receipt vouches that its own request authenticator admitted that Host (multi-route only admits configured own names arriving through the local TLS front). A machine with no identity key writes no receipt; such records read `failed` over another route, as before.

## 3. Level-of-abstraction fit

The verifier is the single place the verdict is computed for every read (history, pool, Telegram rows).

## 4. Signal vs authority compliance

The verdict is a display mark (originVerified); it gates nothing. Reference: docs/signal-vs-authority.md.

## 5. Interactions

The receipt check that already ran is reused; the same machine-key history lookup.

## 6. External surfaces

App history marks change from failed to verified for these messages.

## 7. Multi-machine posture

Replicated records are verified on every machine against the replicated key ledger and machine-key history; unchanged.

## 8. Rollback cost

Revert; marks go back to failed. No state.

## Second-pass review

First reviewer pass — Concern raised: the verifier change alone had nothing to act on because `buildSignedOrigin` stored the paired host. Fixed as above; an integration test now runs the real authenticator → `buildSignedOrigin` → `verifyRecordedOrigin` over both the Tailscale and the paired name. Messages stored before this fix with the wrong host stay `failed` (the stored record is wrong); new ones verify.
