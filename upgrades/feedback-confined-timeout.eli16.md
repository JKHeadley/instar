# Feedback worker test timeout cleanup

When a feedback fix changes a core file, its related tests can cover much of Instar. The old 20 minute limit stopped one SecretStore attempt before it could open a pull request. The sandbox wrapper exited, but its test children kept the output pipe open, so the executor stayed stuck until those children were stopped separately.

The related test step now has a 45 minute limit. All other confined commands keep their 20 minute limit. When either limit is reached, the runner kills the original process group and records the timeout immediately, even if a child has separated from that group and kept an output pipe open. Native Windows execution is refused because this process containment is supported only on macOS and Linux. The worker still has to pass its old-code test, new-code test, lint, related tests, independent review, local verification, and CI before a merge.

This change does not make the SecretStore patch safe by itself. That patch has a separate independent data loss finding and needs correction before merge.
