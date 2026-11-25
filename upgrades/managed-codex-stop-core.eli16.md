# Prepare the checks for Codex project continuation

When Instar asks Codex to continue a project, the eventual feature will need to tell a fresh confirmation from an old one. It also needs to remember whether it already issued an instruction and whether the project has been paused or stopped. This change adds two internal components that prepare those checks. One reads a verified section of the Codex record and looks for one matching confirmation. The other proposes whether to record a confirmation, issue a new instruction, or let the worker stop.

The components are exercised by unit tests. This commit does not connect them to any running worker. A later change must connect them to the authorized project and worker, commit the decision durably, and verify the real Stop hook before enabling the feature. For agents and project owners this change requires no action.
