# Windows pairing on the enrolled local agent origin

AgentServer can explicitly mount the two relay-pairing routes on the existing local owner origin. Windows already signs for that enrolled host and port. Native signing, direct loopback arrival, no forwarding headers, and live owner admission still gate both routes. No extra client-facing listener is opened by this change.

Default AgentServer startup supplies no relay capability and leaves the route unavailable. The runtime's separate raw TLS destination is still needed for relayed phone traffic. A caller that enables the route must provide the boot-owned capability and own its lifetime.

The AgentServer HTTP test enrolls a real native device through the installer-ticket path, then uses the enrolled host for a signed capability check and issue request. A second server with the default configuration refuses the same signed operation. The relay issuer in that HTTP test is synthetic. The distinct disposable relay integration covers the real transport. Reverting this change requires no migration.

## Class-Closure Declaration

- `unbounded-self-action`: closure n/a. Each operation comes from one signed local request and uses the runtime's bounded capability.
