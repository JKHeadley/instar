# A full session queue is a status note, not a task for you

When all of an agent's session slots are busy, new work has to wait for one to finish. The dashboard currently puts that ordinary wait in Needs you, even though the explanation asks you to do nothing. That makes the list less useful: it should help you find the decisions and actions that really need your attention.

This correction gives that one declared health condition an explicit marker saying it does not require your action. The shared Needs-you read, used by the dashboard and an owner phone, leaves it out. Other problems keep their current behavior, including problems reported by older agents that do not send this marker. The change does not guess from a message's wording.

The capacity information remains available. A small dot on the dashboard's Agent door points you toward Health, where the same warning, explanation and Sessions link remain. If the status cannot be read, the dot says that it could not be read; a failed connection never means the agent is clear. The raw health answer still reports degraded when capacity is full.

Nothing stops a running session, changes a limit, grants permission, or alters the scheduler. This is a correction to how existing information is presented. It follows the already approved dashboard design: show agent-side problems under Agent unless the person must act. Reverting the change restores the previous presentation without a data migration.
