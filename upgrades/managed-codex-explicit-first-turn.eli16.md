# Start a managed Codex turn only after enrollment

The new launch adapter opens a native Codex thread without sending any work. The server checks that the project still admits this worker and records the thread and private directory together. Only then does it send the first turn. If admission changes or the controller disconnects before sending work, Codex receives no turn to run.

The native tests exercise all three cases with a disposable Codex home and a local model fixture. The adapter sends the first turn only once, even if its reply is uncertain. This replaces the startup-hook wait as the authority for first input. The production launch still needs to connect the adapter to the server’s approved project work and credentials, and verify how the same worker behaves through Stop and shutdown. The continuation switch remains off.
