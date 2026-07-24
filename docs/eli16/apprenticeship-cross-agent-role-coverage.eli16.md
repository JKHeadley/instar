# Cross-agent apprenticeship role coverage

An apprenticeship cycle is stored by the agent that records it. That is useful ownership, but it
means one apprenticeship can have evidence split across several local databases: an overseer cycle
on Echo, a mentor-to-mentee drive on Codey, and another observation on a third agent. Previously,
asking any one agent for role coverage inspected only that agent's database. A perfectly healthy
mentor-to-mentee drive stored elsewhere was invisible, so the local answer could falsely say the
keystone layer was starved.

The role-coverage endpoint now performs a bounded, read-only census of the other running agents in
the host registry. It uses each target agent's existing per-agent credential, requests only cycles
for the named apprenticeship instance, and combines those rows with the serving agent's local rows.
Cycle UUIDs are deduplicated, so a mirrored row is counted once. The existing role-axis and
keystone calculations then run over that combined evidence.

Peer failure does not erase valid local evidence and does not turn the endpoint into an error. The
response includes `aggregation.complete`, `omittedPeerCount`, `conflictingCycleIds`, plus a
`peerSources` list with counts, truncation, and errors. This makes a partial or contradictory census
visibly incomplete. Reads are concurrent, limited to 32 active
non-lifeline peers, limited to 500 rows per peer, and time-bounded. No cycle is copied, moved,
rewritten, or used to gate lifecycle actions; this remains an observe-only health surface.
