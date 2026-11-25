# Verified relay startup composition

The explicit startup function combines the local machine signer, signed owner evidence, current committed lease, relay certificate pin, dedicated agent TLS listener and code issuance. It requires a boot-supplied assignment and owner anchor. Missing owner evidence, a changed assignment, a holder mismatch or a missing agent TLS pin leaves startup disabled. A changed pin or lost authority withdraws the running capability. Shutdown closes both the local listener and outbound session.

The disposable integration exercises signed assignment and certificate validation, end-to-end relay TLS to the scoped handler, code issuance and redemption, and lease-loss closure. It uses synthetic owner evidence and an isolated phone handler. Production WSL startup remains dark. Its caller must supply the actual phone handler, a trusted assignment and the committed lease source. This change introduces no public bind, default activation or data migration.

## Class-Closure Declaration

- `unbounded-self-action`: closure n/a. The caller starts and stops one bounded runtime and listener.
