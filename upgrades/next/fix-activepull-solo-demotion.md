# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Fixes a crash-loop regression introduced with the multi-machine active-pull feature.

On a machine running by itself (no other live machine in its mesh), the active-pull loop was re-checking the "who's awake" role every few seconds and, whenever the short-lived internal lease briefly lapsed between renewals, wrongly flipped the machine to a standby (read-only) state. A follow-up write then crashed the server, and it restarted into the same loop. Because the server is also the messaging relay, the operator saw silence during the loop.

The fix: the active-pull loop now only re-evaluates the awake/standby role when it has actually heard a lease from a peer. A machine on its own is never demoted by the pull loop on a transient lease lapse — its normal heartbeat keeps renewing the lease as before. The genuine multi-machine behavior (a backup that pulls a newer lease from a live peer still steps down) is unchanged.

This pairs with the earlier hardening that made a read-only/standby write non-fatal, so both the wrong state and the crash it could cause are now closed.

## What to Tell Your User

Nothing to do. If you run an agent on a single machine, this removes a rare crash-restart loop that could make it go quiet for a while; multi-machine setups behave the same as before, just without the spurious solo demotion.

## Summary of New Capabilities

- The active lease-pull loop only reconciles the awake/standby role when a peer lease was actually observed, so a solo machine is never demoted (and never driven read-only) by the pull loop on a transient self-lease lapse. Regression test added; the real peer-driven demotion path is retained and tested.

## Evidence

- `tsc --noEmit` clean; 45 multi-machine unit tests green, including a new regression (a solo holder whose self-lease lapses with no peer observed stays awake and never goes read-only) and the retained same-epoch contested-split-brain test (feature intact).
- Root cause of the 2026-06-02 echo crash-loop incident. Spec: docs/specs/MULTI-MACHINE-ROBUST-LEASE-PROPAGATION-SPEC.md (approved). Side-effects review: upgrades/side-effects/fix-activepull-solo-demotion.md.
