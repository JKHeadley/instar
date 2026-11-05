## What Changed

Added revalidateQueuedOwnerAdmissionSnapshot to src/server/mobileOwnerDeviceAdmission.ts: it rechecks a durably queued owner-phone admission ({deviceId, identity:{keyHash, userId, role:'owner'}}) against current pairing, native, key ledger, device, key, person and owner-profile state, and returns ok or a named refusal reason. The live mobileOwnerDeviceAdmission helper now calls the same private policy function; its signature and results are unchanged.

## What to Tell Your User

Nothing changes for you yet. This adds a safety check that later work will use so a queued request from your phone is refused if you removed that phone, changed its key, or lost owner access before the request ran.

## Summary of New Capabilities

A historical owner-snapshot validator for queued phone requests, sharing one policy with the live owner-phone check. Not wired to any route; it is not authentication and requires the caller to have verified the snapshot's provenance.

## Evidence

tests/unit/queued-owner-admission-snapshot.test.ts covers the pass case (unnamed and named owners, JSON round-trip, pure read) and each refusal (revoked device, ledger revocation, rotated key, deleted device, demoted person, re-assigned person, deleted and stale owner profile, pairing off, native off in config and since boot, ledger missing, unreadable store, wrong role, malformed snapshots, mismatched key, unknown device, single read of the snapshot), and asserts the live helper refuses the same changes. Existing tests/unit/mobile-owner-device-admission.test.ts passes unchanged. Removing the revocation or profile check makes 7 tests fail. No real-device proof is claimed; nothing calls it yet.
