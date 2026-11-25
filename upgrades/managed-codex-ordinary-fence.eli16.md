# Remember ordinary project workers across restart

Before the ordinary round launcher starts a worker, it can now save a hold on the round and its items. The managed launcher checks that same hold. If the server restarts or the round is edited, the saved hold still prevents another worker from starting the same round.

The launcher only clears its own hold when it verifies that the worker never started or that the process group has stopped. When the check cannot confirm termination, the round stays held. The tests reopen the saved store, replace the round’s item list, and check that the old hold still blocks a competing launch. This change is exercised in the test setup. Production still needs the shared store connected to every launch and a way to verify old workers after a restart before clearing their holds.
