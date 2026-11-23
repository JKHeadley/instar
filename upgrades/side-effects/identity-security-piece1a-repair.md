# Local dashboard link verification repairs

Tier 2 because request locality is a security boundary. Three implementation/test files initially; narrow repair under the approved piece1a spec. No new identity authority.

- Over-block: main-listener loopback requests keep existing behavior. Same-network requests must not qualify, even if socket addresses appear local.
- Under-block: existing forwarding-header and loopback checks remain; the shared arrival marker supplies listener provenance.
- Abstraction: localPeer consumes the existing requestArrival authority; it does not introduce a parallel arrival detector.
- Signal versus authority: follows docs/signal-vs-authority.md; provenance comes from the server listener, not user headers or text heuristics.
- Interactions: arrival is checked before addresses. Registry inventory retains the actual registerSqliteHandle requirement; functional test covers close and shutdown.
- External surfaces: same-network arrivals cannot redeem local links. Dashboard PIN behavior and legitimate local links stay the same.
- Multi-machine posture: machine-local by design; each server owns its listener provenance and local SQLite handle. No replicated state or cross-machine URL changes.
- Rollback: revert this repair commit. No schema or persistent data migration.

Verification: existing assessment establishes inventory and arrival-ratchet failures. Targeted diagnosis and full unit/integration/E2E verification are delegated to echo-increasing-throughput, never hand-run full suites. Results pending; no pass claimed.

Console diagnosis: the focused run reproduced missing enrollment and an unhandled TypeError in fakeIndexedDB. It merged different database names and failed to create the local credential store after the device store existed. The fixture now keeps databases separate and runs store creation for each empty database. No runtime browser behavior changed.

Independent review: local_link_review concurred with arrival and registry repairs; additional fixture review requested.

Verification results: targeted SqliteRegistry-wiring 11/11, request-arrival-ratchet 3/3, local-access-routes 13/13 passed. Console fixture repair then passed all 28 console-chats-page tests with no unhandled errors. Independent additional fixture review concurred. Full exact-head verification remains pending via throughput.

Commit pairing gate required a staged lifecycle regression. Added a real server socket with same-network provenance and asserted local-link routes refuse it. No gate exemption used.

Local-link E2E passed 3/3, including real same-network marked socket refusal. Independent review concurred with the added lifecycle test.
