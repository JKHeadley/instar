# Local session placement confirmation — ELI16

The multi-machine session pool first records a new conversation as `placing`,
then changes it to `active` after the chosen machine accepts the work. Remote
placements already performed that second step. When the chosen machine was the
same machine handling the incoming message, the router deliberately handed the
message to the older local delivery path, but nothing performed the second
step. The conversation could start successfully while ownership stayed stuck
at `placing`, causing later messages to queue or re-enter placement.

The fix keeps the existing local path authoritative. It does not claim success
inside the router because the router's local callback is only a fall-through
marker. Instead, successful live injection, respawn, and cold spawn call a
small guarded confirmer afterward. Live injection must also return success.
The confirmer acts only when the row is
still `placing` and already names this machine. Active rows, remote rows, and
missing rows are no-ops. If local spawn rejects, its success continuation never
runs, so ownership honestly remains unconfirmed.

The single-agent CROSS-MACHINE regression used the real authenticated lifeline
entry path on the Mini. Before the fix, a successful Mini spawn remained
`placing`; with the repaired build, a fresh placement became `active` at epoch
2. Unit and integration tests also pin the state guard, idempotence, and
success-before-confirm ordering.
