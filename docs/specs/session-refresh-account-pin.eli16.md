# Choosing an Account When a Codex Session Restarts

A project can run on more than one Codex subscription account. Today, when an agent restarts a project to free up quota, the server uses its own account choice. Sometimes the workload plan already names the account, for example because that account has unused room and its next reset is approaching. This change gives the restart request a way to name that account directly. An installation has to switch the feature on before it can be used.

The project must be idle before the server stops it, and the named account must be available on the same machine. The server checks both again while preparing the restart. It uses the existing path that carries the saved Codex conversation into the replacement. The agent can include a short rebrief so the project knows which work to continue when it returns.

An accepted request means that the server is preparing the restart. The agent needs to check the replacement session and the live account identity to verify the move. Automatic account selection follows the current rules for every restart that leaves out the account choice.
