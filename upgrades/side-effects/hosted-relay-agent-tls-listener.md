# Relay agent TLS destination

An explicitly started listener serves the assigned agent certificate on a private IPv4 loopback port. It checks the certificate name, lifetime and exact key pin before binding. The connection must use the assigned hostname in both TLS and HTTP. The listener delegates only to the supplied phone handler and does not mount the main agent app.

The listener bounds concurrent connections, handshake time and headers. Shutdown aborts owned connections and waits for the port to close. The fixture uses a synthetic certificate and verifies rejection of a wrong pin, TLS name and HTTP host, and closure of a pending connection. Independent transport review concurred.

The listener is dormant. The eventual startup composition must supply a dedicated phone handler with its own authorization and a trusted assignment and certificate. No public listeners or configuration changes are made. Reverting needs no migration.

## Class-Closure Declaration

- `unbounded-self-action`: closure n/a. The explicitly started local listener has capped connections and a caller-owned abort signal.
