# Bounded automatic repair

## What Changed

Instar now has a reusable safety gate for automatic local repairs. It records a durable failure episode, proves the current process still owns the affected resource, limits repair attempts and elapsed time, routes ambiguous or unsafe states to attention, and verifies restart-dependent repairs on a different boot. The first consumer repairs missing or stale feedback-factory generated defaults on the canonical development owner.

## What to Tell Your User

Instar can now repair one narrow class of missing local defaults automatically while retaining strict retry, ownership, and notification safeguards. Fleet behavior is unchanged, and unsafe or ambiguous filesystem state is reported without being overwritten.

## Summary of New Capabilities

- Bounded, durable automatic-repair episodes with attempt, time, flap, and notification limits.
- Ownership-fenced repair claims and consume-once admission.
- Crash-safe attention delivery and cross-boot restart verification.
- Safe automatic recovery of feedback-factory generated defaults on development agents.

## Evidence

- Unit coverage for severity refusal, notice durability, ownership-fence races, bounded retries, restart verification, and corrupt durable state.
- End-to-end coverage for the two-boot repair and verification lifecycle.
- Self-action convergence ratchet registration, successful build, and successful lint.
