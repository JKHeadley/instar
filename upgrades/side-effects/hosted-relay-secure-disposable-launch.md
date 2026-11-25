# Side effects of the secure disposable relay launcher

An explicit launcher starts two ephemeral IPv4 loopback listeners. The outbound control listener requires TLS and HTTP/2. The client listener forwards the original encrypted data to the admitted agent. Neither listener opens a public port.

- The control side caps raw sockets and HTTP/2 streams. The relay tracks accepted TCP clients and checks current leases once per second while running.
- Both listeners and pending sockets are owned by the launcher and closed together on stop or bind failure. The outbound TLS certificate and authoritative lease source come from the caller.
- The integration uses separately pinned control TLS and the agent's TLS identity with the real verified dialer, reconnect supervisor and pinned owner record. The direct agent listener stays separate.
- There is no production invocation, configuration migration or data change. Reverting removes a disposable launcher only.

## Class-Closure Declaration

- `unbounded-self-action`: closure guard. An explicit disposable start owns one periodic lease sweep. Stop or listener failure clears it and closes the listeners.

Independent review concurred. The real loopback fixture also checks that revocation closes an idle data stream. It exercises normal shutdown, with partial bind failure covered by construction and review.
