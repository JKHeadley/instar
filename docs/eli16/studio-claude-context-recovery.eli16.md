# Claude Code conversation recovery on Studio

After Claude Code compresses a conversation, Instar rebuilds the context it needs to continue. This includes identity, relevant instructions and information about the conversation. Claude Code waits for the recovery script to finish before it delivers that context.

On Studio, one recovery script ran past its five-second allowance and Claude Code cancelled it. The recorded compact summary existed, but the recovery context never reached the model. We reproduced the same behavior with an isolated test server by slowing two local reads so together they took more than five seconds.

The repair gives the built-in compaction hook enough time for its bounded local reads. It also adds deadlines to the few optional requests that previously had none. The test exercises the hook written by the update process, with slow responses, and checks that both ends of the recovery block arrive. Regular startup and custom hooks keep their configured timeouts. The Studio safeguard remains in place while the repaired hooks await live verification.
