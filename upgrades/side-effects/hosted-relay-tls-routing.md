# Side effects of the optional relay TLS routing foundation

This component reads a bounded TLS ClientHello for the DNS routing name and forwards its original bytes to an exclusive preauthorized stream. It has no TLS key or TLS termination code.

- Missing, malformed, oversized, or ambiguous names and unavailable routes close the connection. Direct agent listeners are independent. The relay requires a visible DNS routing name, so an incompatible encrypted hello requires a direct route.
- The resolver owns route authority and must select only the authenticated holder's stream. The component cannot dial an arbitrary target. The eventual listener must bound aggregate concurrent admissions in addition to this component's per-connection byte and time limits.
- It opens no listener by itself, stores no payloads and logs no client metadata. The public service, outbound authenticated tunnel, certificate issuance and durable lease fencing are separate build milestones.
- The component is transport-only. The agent keeps its TLS keys, the direct entry points remain available, and the server owns post-handshake origin rules.
- No service is deployed or enabled. Reverting the component needs no data migration.

Independent rereview concurred with the graceful close correction and encrypted byte preservation.
