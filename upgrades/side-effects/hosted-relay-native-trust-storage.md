# Native relay trust storage

The Swift component stores caller-verified trust evidence in a dedicated, device-only Keychain item scoped to the local agent row. The app must supply the authenticated pairing and transition verifiers. The component is dormant and opens no connection. Existing direct access requires no storage change.

A missing reconnect record, invalid record size, stale revision, Keychain error or mismatched readback refuses the operation. Initial pairing uses insert-only storage. Rotation matches the last observed revision and replaces the evidence and revision in one call. Reads do not request user interaction. The caller must use the app's private Keychain scope and pass only the public trust record.

The standalone Swift check uses synthetic evidence and a memory backend to exercise storage transitions and conflicts. The Keychain adapter compiles on Mac. A signed application lifecycle test is required before app wiring to prove the platform's conditional update and private access group behavior. Reverting these files requires no migration.

## Class-Closure Declaration

- `unbounded-self-action`: closure n/a. Each caller-requested operation performs one verification and at most one local write.

Independent review concurred with the dormant storage flow and its stale-write and readback guards. Live entitled Keychain behavior remains to be verified.
