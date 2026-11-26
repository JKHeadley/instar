# When a test process stops without naming a failed test

The shared verifier recently ran tens of thousands of unit tests and reported zero failed tests, but the process still exited with an error. That is possible when a worker crashes or an error happens outside a test. The verifier correctly treated the run as failed and stopped the remaining work. The retained failure report had no explanation for the unit process exit, so the team could not tell what it needed to repair.

The existing private failure report will keep the end of the unit process output, its exit code and any signal. The installed reporter's unhandled-error summary is kept when available. The report stays bounded and follows the verifier's existing failure retention. This evidence helps people route the issue. Passing the gate still depends on the existing test rules.
