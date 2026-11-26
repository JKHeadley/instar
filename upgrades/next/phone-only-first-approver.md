# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Added server support for verifying a private Telegram acceptance and binding it to one paired iPhone. The enrollment flow requires a separate Face ID confirmation in Instar before the phone can approve changes.

## What to Tell Your User

This update prepares phone-only approval setup. It does not change your current approval settings or send an enrollment link.

## Summary of New Capabilities

Enrollment can bind the verified Telegram owner, exact phone and one-time private offer to a signed confirmation and a stored receipt. Production delivery remains off in this draft.

## Evidence

A disposable iPhone simulator run exercised Face ID policy and four signed HTTP steps using simulated Telegram evidence and a software test key. Focused tests cover the owner and private chat checks, exact Telegram acknowledgement and offer expiry. Production delivery and physical-device verification are pending.

The unmounted version 2 server handler checks the paired caller and delegates confirmation or cancellation to the shared authority. Production enrollment stays off.

The first-phone version 2 handler now exercises the compound witness reservation in an isolated test. Production enrollment stays off.

The dedicated Face ID proof verifier matches the Swift and Node test vector. It remains unmounted.

The unmounted first-phone decision handler now checks dedicated Face ID proof and key eligibility at the witness boundary.
