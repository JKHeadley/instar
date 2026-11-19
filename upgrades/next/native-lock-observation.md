# Native lock-dispatch proof observation

## What Changed

The common Mac helper counts actual lock dispatches in memory and records same-guard watch/final witnesses through existing duty writes. Each Mac host maintains a bounded lifetime guard-spawn history. The own locked status diagnostics expose that history without granting authority. Account-switch/logout proofs now require complete A+B histories, exact child exit, unchanged native counts, and final reads after the observed human return.

## Evidence

Targeted tests execute the production Swift observation block with inert direct/fallback dispatch doubles and actual inert children through the Mac host spawn funnel. Combined runCase tests exercise account-switch and logout human timelines, including the pre-logout checkpoint. HTTP integration and production-initialization E2E tests are authored for Local Verify; live Mac proof remains separate.

## What to Tell Your User

The proof can now distinguish a measured zero from missing evidence. This does not enable locked-screen access or certify a Mac. Updating the native helper requires the usual permission validation.

## Summary of New Capabilities

Read-only guardObservation and observedLoginSession fields on GET /desktop/locked/status support bounded native proof evidence. Missing, incomplete or restarted histories never count as a zero.
