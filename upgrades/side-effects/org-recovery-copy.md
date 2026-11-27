# Side-Effects Review — Organization recovery copy

**Version / slug:** `org-recovery-copy`
**Date:** `2026-11-16`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (see below)`

## Summary of the change

New: `src/core/OrgRecovery.ts` (six-word phrase, scrypt + AES-256-GCM copy, header bound as additional data, fixed costs, field checks before decoding, size limits).

Changed:
- `OrgMembers`: the `unconfirmed` flag, which leaves `removal` out of answers; remove, restore, leave and confirm all clear it. Plus `confirm`, `restoreFromCopy` (which retires the old publisher's entry) and `reactivateInvite`.
- `OrgKeepers`: a separate `keepers.restored.json`, plus `reactivate` (with the three-keeper limit) and `discardRestored`.
- `orgPackRoutes`:
  - `POST /mobile/org/recovery-copy`, `POST /mobile/org/recover`, `POST /mobile/org/recover-latest`, `GET /mobile/org/current-bundle`, and `POST /mobile/org/recovery/{keepers,invitations,members}/…`;
  - the `recovered.json` marker (a staged install, finished at start), which blocks invitations and proposals and makes the first publish +1000 with the found record's settings.
- `mobilePairingRoutes`: allowlist rules.
- `AgentServer`: a 32 MB raw-body parser for `/mobile/org/recover`.

Spec: `docs/specs/org-recovery-copy.md` (5 rounds, approved). Tier 2.

## Decision-point inventory

- Recover needs `retired: true` — add.
- The old address counts as alive only when it serves a record signed by the organization key — add.
- Restored keepers stay inactive (in a separate file), links inactive, joined members unconfirmed — add.
- The first publish after recovery is +1000 — add.

---

## 1. Over-block

Recovery is refused while the old address still serves a signed record, even if that machine is about to be retired; the person waits or starts a new organization. Five wrong phrases an hour.

## 2. Under-block

A returning old machine after a recovery the person called final leaves two holders of the key (stated limit, §C). The phrase-try count is in memory and resets on restart (stated; the file is the real secret).

## 3. Level-of-abstraction fit

It reuses the publish path, the publish lock, `validateBundle`, `orgRequest`, the registries and the device-signature path.

## 4. Signal vs authority compliance

Every authority is deterministic: a signature, a version number, the person's explicit retirement answer.

## 4b. Judgment-point check

None.

## 5. Interactions

- Publish: while the marker exists, publish uses +1000 and the found record's settings, and removes the marker. The stale-base check stays on, so a draft made before a newer colleague version arrived is shown again rather than published over it.
- Invitations and keeper proposals are refused until then.
- Check-ins from unconfirmed members neither raise nor clear removal notices.

## 6. External surfaces

One outgoing call to the old address during recovery, under the update check's address rules.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local: the copy is made on the key machine, and recover installs on the machine it runs on. Forwarding is CMT-1873.

## 8. Rollback cost

Copies stay valid. Restored keepers live in a file that older code never reads. A revert before restored members are confirmed can clear a removal notice made after the copy (stated in the spec's Rollback section).

## Class-Closure Declaration

- `unbounded-self-action` — closure `n/a`: there is no loop; every action is one owner-device request, and the start-up finish runs once.

## Conclusion

Ships live for agents that publish; it does nothing until an owner makes a copy or recovers.

## Second-pass review (if required)

**Reviewer:** second-pass subagent
**Independent read of the artifact: concur**, with two fixes wanted before merge, both applied:
- During recovery, publish no longer skips the stale-base check, so an older draft can't overwrite a colleague's newer version.
- The restored registries are now staged with the key and bundle, and moved into place together, so a crash can't leave them half-restored.

Also applied:
- Recover stages under the publish lock and checks again that nothing is published.
- Finishing an install at start is wrapped, so it can't stop the server from starting.
- Only restored links can be reactivated.
- The installed bundle decides `shareUpdates`.

The reviewer confirmed:
- every route is owner-device only;
- the key, fingerprint and `orgId` must all match;
- the old address counts as alive only on a verified record;
- restored keepers can't propose;
- unconfirmed answers carry no `removal`;
- the +1000 publish and the marker's removal behave as the spec says;
- the 32 MB parser keeps the raw body.

## Evidence pointers

- `tests/unit/org-recovery.test.ts`, `tests/unit/org-members.test.ts`, `tests/integration/org-recovery-copy.test.ts`.
