# Record the rollout path for managed Codex continuation

Instar's current managed continuation test switch stays off. This change records the planned path from the disposable test to a supervised development agent and then to default use. It records the evidence that still needs to be collected. Before broad rollout, Instar must prove it can recognize authorized project work, respect an owner stop, update installed hooks, and recover safely when work moves or a machine fails.

This change also fixes the test map for the new setting. It records which dark setting each line in the current configuration defines. Neither the rollout record nor the test map enables a project or changes how a current Codex session runs. The record lets reviewers see why the setting is still off and what evidence would justify turning it on.
