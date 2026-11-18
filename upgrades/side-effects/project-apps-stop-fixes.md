# Side-Effects Review — Project apps part 2: "Stop this app" tells the truth

**Version / slug:** `project-apps-stop-fixes`
**Date:** `2026-11-17`
**Author:** `echo`
**Second-pass reviewer:** `not required (display, a read-time settle and one refusal; no new authority)`

## Summary of the change

A live user-role proof of the example custom app (`.instar/lanes/project-apps-proof/example-live/` in the agent home) found that after the owner taps "Stop this app":
- the version card went back to Needs-you offering a phone Approve, but approving said "running" while the app stayed off;
- the Work row kept the old headline and its Open button.

Restarting a stopped app is the separate "enable" card, which is stage 2 (CMT-1882). This change makes the screen honest about that:
- **Card:** a withdrawn serve card of a custom app is treated as settled when it is read (`workBoardViews`/`WorkBoardService`, derived from the replicated records, so nothing is written). It sits in the Done lane, reads "Stopped by you. Turning it back on comes in a later update.", has no buttons, and is gone from Needs-you.
- **Approve:** a further approve is refused with 409 `app-stopped` and plain words (`performOwnerTap`, which is shared by the phone and the console).
- **Settle closer:** it now requires `servedVersion(appId).state === 'served'` before it writes "running".
- **Work row:** row data carries `state` (`served`, `copying`, `off` or `not-approved`). The console and the conversation strip show "<title> · Stopped" or "<title> · Waiting for your approval" with no Open button.
- **Counts:** summary counts beyond three are kept in `moreCounts` instead of being cut (part 2 §3.3). The row-building code moved to `customAppRow()`.

## Decision-point inventory

- Approve on a stopped app's card is refused (`app-stopped`). This removes a tap that did nothing.
- Read-time settle of a withdrawn serve card. It is display only and writes nothing.

## 1. Over-block

A stopped app cannot be restarted from its old card. That is by design until the enable card ships (CMT-1882); the card now says so.

## 2. Under-block

None new. Serving still depends only on an owner-phone approve of the exact material.

## 3–5. Fit, signal vs authority, interactions

The settle is derived from replicated records, so every machine agrees and no write or schema change is needed; older peers are unaffected. The needs-you ratchet registers "Waiting for your approval" as exempt, because the version card already carries that ask.

## 6. External surfaces

There is a new 409 `app-stopped` on the owner tap route for that card class. The row data gains `state` and `summary.moreCounts`, both additive. iOS ignores unknown fields, so it is unchanged until its own update.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

1. **Leads with the primary action?** A served app still leads with Open. A stopped or unapproved app shows its state in place of Open, because there is no action to take; the approval itself lives on the phone card.
2. **Zero raw internals as primary content?** Yes. States are words ("Stopped", "Waiting for your approval", "Stopped by you. Turning it back on comes in a later update."). No ids or state codes are shown.
3. **Destructive actions de-emphasized?** No new destructive action. The Stop confirmation's wording is now accurate.
4. **Plain language + phone width?** Plain words. The row and strip reuse the existing row layout that was checked at 390x844 and 1280x728 in the live proofs.

## 7. Multi-machine posture

The settle happens at read time from the replicated records, so it is the same on every machine.

## 8. Rollback cost

Revert the commit. No data shape is persisted.

## Evidence pointers

- Whole unit lane: 3,821 files, 69,810 passed, 0 failed.
- Integration project-app routes: 18 passed.
- E2E: project-apps-custom-alive, project-apps-alive and needs-read-alive, 5 passed.

## Class-Closure Declaration (display-only mirror)

- **defectClass:** `unbounded-self-action`
- **closure:** `n/a` (negative declaration)
- **reason:** No new self-action: a read-time settle (no writes), one refusal, and display state.
