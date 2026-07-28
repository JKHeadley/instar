# Session-pool stage attribution: ELI16

Imagine a climber moving up a four-rung ladder. Before moving to the next rung,
the climber must prove that the rung they are currently standing on is safe.
Instar already had that rule. The promotion controller looked at the current
rung and asked for a matching green safety check. But the check runner kept
writing every successful check onto the label for the bottom rung, even after
the climber had moved higher. The checks were real and green, yet the controller
could not use them. It waited forever for proof attached to the current rung.

This change gives both pieces one shared view of the ladder. The promotion
controller and the check runner now read the same live, config-backed stage.
When the runner begins a check, it records the result against the stage that is
actually active. A green for live transfer can therefore authorize the one next
step to rebalance. A green accidentally attached to a different stage still
does nothing, which keeps the safety boundary intact. Instar also checks the
stage again after the test finishes. If rollout moved while the test was
running, the ambiguous result is discarded instead of saved for possible reuse.

The same sharing rule now applies to build identity. Deployment-provided commit
IDs remain preferred, followed by the Git checkout ID. On npm installations
where the test runs from a separate source checkout, that tested checkout's Git
ID is preferred. Instar then uses the installed package version before falling
back to `unknown`. The producer and controller use the exact same
identity function, so they cannot disagree merely because they were wired
separately. Older installations where both sides genuinely resolve to
`unknown` continue to work consistently; the signed evidence and stage match
are still required.

Nothing becomes more permissive. Dry-run results remain isolated from the
promotion store, signatures are still verified, promotion is still one rung at
a time, and the configured ceiling still limits authority. The fix removes a
false permanent stop without bypassing any rollout gate.
