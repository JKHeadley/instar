# Lease scheduler role continuity — ELI16

A scheduled job only runs on the machine that currently holds the agent's lease. The old server built its scheduler only if it was the holder when it booted. If a standby took the lease later, it could stay online and healthy while running no jobs. The existing role-change restart was limited to one optional self-heal mode, so it did not protect ordinary agents or agents with a preferred machine.

Whenever a scheduler-enabled machine changes between holder and standby, it now uses that existing bounded planned-restart path. A machine losing the lease pauses its scheduler immediately. A machine gaining the lease restarts so the normal boot path creates its scheduler. The one-minute reconciliation retries a throttled or failed restart request. The lease still decides who may run jobs; this change does not grant authority to a standby.

A missing job definition on the promoted machine is a separate catalog problem. This change makes the scheduler run the definitions it already has. A later catalog repair addresses missing definitions without activating git-sync.
