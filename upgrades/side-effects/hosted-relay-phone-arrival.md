# Relay phone status arrival

The dedicated agent TLS listener marks the actual socket with the verified assignment. Main listener authentication refuses relay-marked requests before considering its usual credentials. The separate phone handler serves only the exact signed device-status GET. It does not mount the general agent app or public bootstrap.

The phone handler requires current native service and revocation state, the assigned TLS hostname, a bound device key, an active native phone record, and the existing signature and replay checks. Browser devices, local computers, same-network-only devices and unrelated assignments are refused. The route returns the signed device's existing status projection.

The integration fixture uses a real pinned TLS connection and a signed native device. It tests absent socket marker, wrong signature host, bearer, wrong route, wrong binding, unavailable authority and revocation. Existing Windows local and same-network pairing cases exercise neighboring paths. Startup does not mount this handler by default. Actual binding provisioning and enrollment recovery remain with Identity. Reverting needs no migration.

## Class-Closure Declaration

- `unbounded-self-action`: closure n/a. The isolated handler performs one signed read per admitted request.
