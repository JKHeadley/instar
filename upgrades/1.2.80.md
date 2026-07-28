# Upgrade Notes — NEXT

## What Changed

Enable-layer coherence — three objective fixes so a feature's on/off switch actually works:

1. **Telemetry deadlock fixed.** `POST /telemetry/enable` previously returned 503 ("subsystem not initialized") because the telemetry heartbeat was only constructed at boot *if telemetry was already enabled* — so it could never be turned on through its own endpoint. The heartbeat is now always constructed (construction is cheap and pure); the side-effecting parts (`start()`/submit()) already self-gate on the enabled flag, so a constructed-but-disabled heartbeat never starts a loop and never sends anything. Enabling now works.

2. **Two broken feature toggles fixed.** The `dispatches` and `feedback` feature toggles pointed at config keys the API refused to change, so calling them returned 400 (the switch was wired to nothing). Both keys are now accepted by `PATCH /config`. (Both are real config keys; the toggles simply weren't in the allowlist.)

3. **A guard so this can't recur.** A new build-time test asserts every feature's enable/disable action targets a real, accepted surface — a patchable config key or a known dedicated endpoint. This guard found the `feedback` toggle bug during development (in addition to the already-known `dispatches` one).

## What to Tell Your User

A few feature on/off switches were quietly wired to nothing — flipping them did nothing or errored. They work now, and there's a new safety check that fails the build if any future feature ships with a switch that points nowhere. Nothing changes in normal operation; this just makes "turn this feature on" mean what it says.

## Summary of New Capabilities

- `POST /telemetry/enable` works without a pre-existing enabled state (deadlock removed).
- The `dispatches` and `feedback` feature toggles now function via `PATCH /config`.
- New build-time guard: every feature's enable/disable action must target a real, patchable surface.

## Evidence

- **enableAction-validity guard** (`tests/unit/feature-enableaction-validity.test.ts`) — 15/15 green; it actively caught the `feedback` toggle bug (a second instance of the same class as the known `dispatches` bug) during development.
- **Telemetry safety** relies on the already-tested self-gating: `TelemetryHeartbeat.test.ts` covers "does not start when disabled" and "does not send when disabled," so always-constructing is side-effect-safe; the route's enable behavior is covered by `telemetry-routes.test.ts`.
- **Regression:** touched-area suite green (telemetry routes, TelemetryHeartbeat, validity = 99 passing); typecheck clean.
- **Side-effects review:** `upgrades/side-effects/enable-layer-coherence.md`.
