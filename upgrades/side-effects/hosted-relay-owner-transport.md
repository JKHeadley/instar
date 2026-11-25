# Side effects of the optional relay transport foundation

The relay's dormant reader validates pinned owner records and an independently committed, machine-signed mesh lease. The dormant HTTP/2 adapter multiplexes offered streams over one authenticated outbound connection.

- Missing enrollment, forked or revoked records, unavailable committed evidence, wrong key, release and expiry fail closed. The reader must use the relay's trusted registration and lease inputs. A holder cannot supply those inputs during admission. The committed lease lookup must establish exact agent provenance because the mesh envelope’s legacy signed fields omit agent ID.
- The transport accepts offers only from its own session. It bounds pending offers and expires them. Closing the authenticated control stream closes the transport and its data streams. The caller selects the fixed offer endpoint, authenticates the control connection and enforces aggregate limits.
- Inner TLS streams remain opaque to the relay. The coordinator can displace an old transport and cancel pending offers. The methods open no listeners or outbound connections themselves.
- The fixtures exercise real signed records and multiplexed HTTP/2 on loopback. They use no production registry, public deployment, or direct-route change.
- Rollback removes dormant adapters without a data migration. Cross-host durable authority, live registration/lease readers and native wiring remain integration milestones.

Independent rereview concurred with pinned owner evidence and control-stream-scoped transport.

## Class-Closure Declaration

- `unbounded-self-action`: closure n/a. Callers supply an existing authenticated session. The adapters open no listener, initiate no outbound connection and schedule no recurring work.
