# Disposable WSL relay startup

The explicit fixture command starts a synthetic agent and relay for a short test. It generates a fresh machine identity, signed owner chain and assignment, committed lease and two test certificates. It supplies that verified assignment to the same startup composition the runtime uses. It mounts the real AgentServer signed pairing routes on IPv4 loopback without starting background services.

Build the checkout first. On the Mama WSL user run `node scripts/hosted-relay-wsl-fixture.mjs 45783 300`, using an unused local port. Use Node 22, the lockfile dependencies and OpenSSL. The command prints the path to a private fixture manifest. Its temporary agent directory holds the standard short-lived local owner ticket. The manifest names the local agent origin, control and data ports, certificate pins and fixture request. It contains no private key, pairing code or ticket. Keep the code in the respective app flows and never put it in a log.

From the native Windows caller, enroll the test device with the standard local-owner ticket flow and call the signed capability and issuance routes. Redeem the resulting one-use locator over pinned HTTP/2. Connect over TLS using the manifest's assigned hostname, agent CA and exact public-key pin, then request `GET /__relay_fixture/ready`. All other requests to that relayed endpoint receive 404. This keeps real mobile bootstrap, owner proofs and credential entry out of the fixture, as Identity specified.

The fixture binds only to loopback and stops at the requested lifetime or a normal termination signal. It closes all listeners and removes its temporary agent, tickets, keys and manifest. It makes no installation or configuration changes to the caller's agent. The local hand-run proof passed enrollment, signed issuance, one-use redemption, pinned HTTPS and refusal of the real mobile device endpoint. Mama and phone-app acceptance remain pending.

## Class-Closure Declaration

- `unbounded-self-action`: closure n/a. The explicitly started fixture has a hard ten-minute lifetime, bounded local connections and automatic teardown.

## Simulator certificate compatibility

The disposable certificate generator uses a private fixture CA and two separate server certificates. Each leaf has the exact DNS name, server-authentication usage and its own key and pin. The manifest identifies each public leaf separately from the CA trust anchor. Clients still verify the CA chain, hostname and exact leaf pin. The old self-signed CA served as a leaf failed Apple SSL policy. The regression verifies both role-separated chains and, on macOS, checks both with the system SSL policy before running the relay flow. This changes synthetic fixture certificates only.
