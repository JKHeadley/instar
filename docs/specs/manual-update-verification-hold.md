# Manual updates preserve in-flight verification

## Evidence and scope

The Studio server restart at 2026-10-31 10:23 PDT cancelled PR #2499's exact-head Local Verify run after 11.6 minutes. The restart followed `POST /updates/apply`, whose `bypassWindow:true` also bypassed every registered restart hold. Automatic updates already respect the Local Verify hold. The Local Verify interruption log records 15 interrupted runs and 49.4 minutes of spent run time; two interruptions and 18.7 minutes occurred in the last day. These are consumed run minutes, not a claim that all were caused by manual updates.

## Contract

- A normal `POST /updates/apply` installs the update and bypasses the preferred time window, but respects active restart holds, including Local Verify. Its response reports the existing `restartDeferral` state. That manual window bypass survives hold retries and server recovery. The already installed version starts when the hold ends or its bounded deadline expires, subject to the existing session gate.
- An explicit `{"forceRestart":true}` bypasses restart holds. It works both on the first apply and after an update has already been installed and deferred. Invalid values and unknown fields fail with HTTP 400. Authorization is unchanged.
- The existing maximum deferral remains the ceiling; a stuck or crashed verifier cannot block an update forever. An interruption still requeues the same PR safely and cannot turn a red result green.
- The route's fallback when AutoUpdater is unavailable retains its existing direct-apply behavior. This change does not add a new configuration switch or alter automatic update scheduling.

## Verification

Unit tests cover normal manual apply, the explicit override, an override after durable deferral, and hold release outside the preferred time window after server recovery. The Local Verify wiring test proves a live service contributes the hold. HTTP integration tests check route option mapping and validation. The production `AgentServer` lifecycle test wires the real AutoUpdater and Local Verify hold registrar, then verifies a normal apply returns a deferral and the explicit override produces a restart request. Build and the complete unit, integration, and E2E suites must be green before merge.
