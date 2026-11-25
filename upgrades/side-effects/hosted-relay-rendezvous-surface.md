# Side effects of disposable relay rendezvous requests

The disposable relay now handles two exact HTTP/2 rendezvous requests. Issuance requires the active admitted holder's own control session and no request fields. Redemption checks a one-time code against the current route assignment and returns its hostname.

- Requests have small byte and time budgets. Redemption uses only the transport-observed remote address, including when a code is malformed. Responses carry no-store and disclose only a code or hostname as applicable.
- A revoked or displaced session cannot issue, and an unavailable assignment cannot redeem. The code carries no owner proof, device credential, certificate pin or session authority.
- This remains a loopback-only fixture service. Request bodies are not stored, and direct routes keep working independently. The code inventory is process-local and drops on restart.
- Reverting removes these endpoints from the dormant service without a data migration.

## Class-Closure Declaration

- `unbounded-self-action`: closure n/a. Each request owns one bounded deadline and performs one caller-initiated operation.

Independent rereview concurred. Issuance rechecks the exact live tunnel immediately before allocating the code, including when the assignment stays the same after reconnect.
