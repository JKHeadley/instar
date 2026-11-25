# Hold the worker’s first turn until the server verifies it

The managed Codex startup test now uses a launch-specific hook in the worker’s private directory. The hook sends the worker’s native session identity to the server and waits. The server releases that exact identity only after it records the binding. The tests show that Codex makes no model request while waiting. They also show that the server can reject and cancel the worker before it sends a request.

This prepares a production launch control. The test keeps its supervisor alive during the decision. The production path still needs proof of what happens if that supervisor disappears and the hook times out. Until then, the build stays disabled for real projects. The older task-ledger path continues to have its own controls, outside this launch test.
