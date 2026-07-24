# Mesh endpoints survive an optional tunnel outage — ELI16

An Instar agent can span two machines and reach the other machine through more
than one path: the local network, Tailscale, or a Cloudflare tunnel. During a
real single-agent CROSS-MACHINE enrollment, the local-network and Tailscale
paths both worked, but Cloudflare temporarily rate-limited the Mini's optional
quick tunnel. Startup only advertised machine endpoints after Cloudflare
succeeded, so it advertised none of the working paths. Both machines therefore
reported the reachable peer as offline and could not maintain an honest lease.

Startup now treats Cloudflare as one optional path instead of the gate for all
paths. It attempts the tunnel, then independently discovers and advertises LAN
and Tailscale endpoints whether the tunnel succeeded, failed, or was disabled.
Pool presence and session routing select from that advertised endpoint set
through the existing validated priority resolver instead of requiring the
legacy Cloudflare-only field. If Cloudflare is available it is included too. No new network exposure is
introduced: endpoint discovery still runs only for an enrolled multi-machine
identity, respects the mesh-transport opt-out, and the server uses the existing
mesh bind policy.

The regression test pins both sides of the live wiring: endpoint advertisement
must occur after the tunnel failure boundary, outside the optional tunnel
branch, and the shared pool/session peer resolver must consume the endpoint
set. Existing endpoint assembly tests cover omission of an unavailable
Cloudflare path and preservation of the healthy LAN/Tailscale paths.
