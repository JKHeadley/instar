# Dark monitoring routes: honest agent awareness

Instar already has two small monitoring guards. One notices when autonomous work
is active on a machine with no online failover target. The other notices when a
live session is using an account whose local login has disappeared. Both are
signals only: neither one moves work, repairs a login, restarts a session, or
blocks anything.

The missing piece was agent awareness. A newly created agent was not taught
about either status route, and an existing agent did not learn about them after
an update. This change gives both paths the same shared guidance, so fresh and
upgraded agents cannot drift.

The guidance is deliberately cautious. These guards are dev-gated and dark on
ordinary fleet agents by default. When dark, their routes return 503; that does
not mean the monitored condition is healthy or unhealthy. Even when enabled on
a development agent, they begin in simulation mode: they count what they would
raise but send no Attention item. The agent is told to read the live status
before answering and never infer health from configuration, identity drift, or
a dark route.

The capability registry already described both routes correctly, so this
change does not add duplicate registry entries. An idempotency test proves an
upgrade adds each missing section once and that a second run leaves the file
byte-for-byte unchanged.
