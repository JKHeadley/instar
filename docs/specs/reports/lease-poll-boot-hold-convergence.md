# Convergence report: lease-poll-boot-hold

**Outcome: converged on round 3.** The outside reviewer concurred, on reading the code; it did not run the tests.

| Round | Outside (codex-cli, gpt-6-astra) | Result |
|---|---|---|
| 1 | changes needed, 3 serious | hold stays armed until a poll starts; one pending start; intent read after the flush |
| 2 | changes needed, 3 minor | force-poll passes through; a retired loop ignores its errors; a refused token cancels a pending start |
| 3 | concur | none |

Round 1 mattered. An opinion that vanished cancelled the 3-minute fallback, leaving a machine deaf for good, and a slow flush could leave two poll loops running. Each was reproduced by the reviewer and is now a test through the real `reconcilePolling`.

## Limits left behind

- A machine told standby stays quiet if its own server then dies. The lease rule covers that, not this change.
- One blind start remains at the 3-minute bound, on purpose.
- Not proven live. The power-off and link-cut drills are the test, and no agent has `pollFollowsLease` live yet.
