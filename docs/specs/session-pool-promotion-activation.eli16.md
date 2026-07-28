# Session-pool promotion activation: ELI16

Instar already had the safety machinery for gradually turning on the
multi-machine session pool. It could read signed test results, decide whether a
stage was green, move forward one stage, and move backward after a failure.
What was missing was the ignition switch: nothing in the running server asked
that machinery to promote.

This change adds three explicit modes. `off` is the default and does nothing.
`operator` advances only when the authenticated one-step route is called.
`auto-climb` checks periodically and advances at most one step per check. The
manual route remains useful in auto mode for a deliberate immediate check.

Both live modes use the same existing driver, signed evidence store, and stage
writer. A green result must match the running commit, and a separate ceiling
limits how far promotion may go. That ceiling also defaults to dark, so merely
selecting a mode cannot accidentally authorize rollout.

The activation is reversible: switch the mode back off. The existing failure
reconciler remains independent and can still demote a stage when evidence turns
red.
