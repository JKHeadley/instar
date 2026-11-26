# Make planned restart admission usable on the lead machine

A planned restart can wait behind a verification run. The time spent waiting for verification should leave the machine its full chance to obtain a peer-confirmed lease afterwards. Instar starts the 15-minute lease wait on the first lease deferral and shares that deadline between the watcher and supervisor.

A single machine can proceed when its enrollment and transport inventory both show that nobody else can take the lead. A pool with an unreachable peer still waits for confirmation. If a very slow boot needs more time than peers will allow, the evidence shows both limits.

When a request times out, the server reports that failure and clears the exact request. A newer request or pending software update keeps its own place. This requires the server, supervisor and local writers to use compatible code before the admission setting is enabled.
